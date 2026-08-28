"use client";

import { useEffect } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { setTokenGetter, api, ApiError } from "@/lib/api-client";
import { useAuthStore } from "@/lib/store/authStore";

type SyncUserResponse = {
  id: string;
  name: string;
  email: string;
  role: string;
  onboarding_complete: boolean;
};

/**
 * Turn a `/users/sync` rejection into the marker `RootRedirect` branches on.
 *
 * Two statuses are PERMANENT states rather than outages, and each earns its own
 * actionable screen — telling either of them to "refresh the page" is advice
 * that cannot possibly work:
 *
 *   403 → no role assigned yet (signed in without accepting an invite).
 *   409 → a second Auth0 identity reusing an existing user's email. The
 *         collision is in the database, so every retry returns the same 409
 *         (#277 added the readable status precisely so we could say this).
 *
 * Anything else — network blip, timeout, 5xx — IS transient, so it keeps the
 * stringified error and falls through to the generic "please refresh" screen.
 */
export function classifySyncError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'no-access';
    if (err.status === 409) return 'email-conflict';
  }
  return String(err);
}

export default function AuthSetup({ children }: { children: React.ReactNode }) {
  const { getAccessTokenSilently, user, isAuthenticated } = useAuth0();
  const setFromAuth0 = useAuthStore((state) => state.setFromAuth0);
  const setSyncError = useAuthStore((state) => state.setSyncError);

  useEffect(() => {
    setTokenGetter(getAccessTokenSilently);
  }, [getAccessTokenSilently]);

  useEffect(() => {
    if (!isAuthenticated || !user) return;

    // Every pending-invite flavour, in precedence order. A table rather than a
    // third copy of the same if/else: the claim-then-sync dance below is
    // identical for all of them, and the copies had already started to drift
    // (only one of them defaulted the name).
    const PENDING = [
      { tokenKey: 'pendingAgentInvite', emailKey: 'pendingAgentInviteEmail', path: 'agent-invites' },
      { tokenKey: 'pendingInvite', emailKey: 'pendingInviteEmail', path: 'invites' },
      // #446 — the TC invite is tokened now, so it claims like the others
      // instead of being inferred from the email at sync time.
      { tokenKey: 'pendingTcInvite', emailKey: 'pendingTcInviteEmail', path: 'tc-invites' },
    ] as const;

    const pending = PENDING.map((p) => ({
      ...p,
      token: localStorage.getItem(p.tokenKey),
      email: localStorage.getItem(p.emailKey),
    })).find((p) => p.token && p.email);

    const adopt = (dbUser: SyncUserResponse) =>
      setFromAuth0(dbUser.id, dbUser.name, dbUser.email, dbUser.role, dbUser.onboarding_complete, user.picture);

    const doSync = () =>
      api.post<SyncUserResponse>('/users/sync', {
        email: user.email ?? '',
        name: user.name ?? '',
      }).then(adopt).catch((err) => {
        console.error('users/sync failed:', err);
        // Permissions/identity states are NOT backend outages. Flag them
        // distinctly so RootRedirect shows an actionable message instead of
        // the scary — and, for a 409, permanently wrong — "server down" screen.
        setSyncError(classifySyncError(err));
      });

    // A claim outcome is TERMINAL (won't succeed on retry) for these statuses;
    // anything else (network blip, timeout, 5xx) is transient and worth keeping
    // the pending token around for so a refresh re-attempts the claim.
    const isTerminal = (err: unknown) =>
      err instanceof ApiError && [404, 409, 410].includes(err.status);

    // Claim any pending invite FIRST, then sync. A brand-new invited user has
    // no role until their invite is claimed (the claim upserts them with the
    // invite's role); if we synced first, /users/sync would 403 and the claim
    // would never run — the buyer dead-end we just fixed.
    //
    // Only clear the pending-invite keys once the claim SUCCEEDS or terminally
    // fails. Clearing up-front (the old bug) meant a single transient failure
    // discarded the token and stranded the buyer role-less with no way to retry.
    //
    // On SUCCESS we adopt the claim's response rather than firing /users/sync
    // straight after: both claim routes return the same upserted-user payload
    // sync would, so the second round-trip is pure latency. (It is not the
    // fix for the role clobber — every later page load syncs with no pending
    // invite, so lib/roles.ts#decideRole is what actually holds the line.)
    if (pending) {
      const clear = () => {
        localStorage.removeItem(pending.tokenKey);
        localStorage.removeItem(pending.emailKey);
      };
      api.post<SyncUserResponse>(`/${pending.path}/${pending.token}/claim`, {
        email: pending.email,
        name: user.name || pending.email,
      }).then((dbUser) => {
        clear();
        adopt(dbUser);
      }).catch((err) => {
        if (isTerminal(err)) clear();
        return doSync();
      });
    } else {
      doSync();
    }
  }, [isAuthenticated, user, setFromAuth0, setSyncError]);

  return <>{children}</>;
}
