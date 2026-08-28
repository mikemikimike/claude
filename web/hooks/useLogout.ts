"use client";

import { useCallback } from "react";
import { useAuth0 } from "@auth0/auth0-react";
import { setTokenGetter } from "@/lib/api-client";
import { useAuthStore } from "@/lib/store/authStore";
import { resetVerifyEmailBannerCache } from "@/components/VerifyEmailBanner";

// E2E (Playwright) renders no Auth0Provider — see Providers.tsx. Calling
// useAuth0() outside the provider is safe (it returns the library's
// initialContext), but every function on that context THROWS when invoked, so
// the logout call itself has to be guarded.
const E2E_AUTH = process.env.NEXT_PUBLIC_E2E_AUTH === "1";

// Pending-invite tokens are per-signup, not per-browser. Leaving one behind
// means the NEXT account to log in on this machine claims someone else's
// invite — and the claim route trusts the email we hand it — so that account
// gets written with the invited role. Always clear them on the way out.
const PENDING_INVITE_KEYS = [
  "pendingInvite",
  "pendingInviteEmail",
  "pendingAgentInvite",
  "pendingAgentInviteEmail",
  "pendingTcInvite",
  "pendingTcInviteEmail",
];

/**
 * The single logout entry point for every role.
 *
 * Local state is torn down FIRST: Auth0's logout is a full-document navigation,
 * so nothing after it is guaranteed to run, and a blocked or slow redirect must
 * still leave this tab signed out.
 *
 * Deliberately does NOT clear the React Query cache. It is memory-only (no
 * persister — see Providers.tsx), so the navigation wipes it anyway, and
 * calling useQueryClient() here would break the server render of consumers that
 * live outside the provider stack (Providers renders bare children on the first
 * pass), e.g. RootRedirect and OnboardingLayout.
 */
export function useLogout(): () => void {
  const { logout } = useAuth0();
  const reset = useAuthStore((s) => s.reset);

  return useCallback(() => {
    for (const key of PENDING_INVITE_KEYS) localStorage.removeItem(key);
    setTokenGetter(null);
    resetVerifyEmailBannerCache();
    reset();

    const returnTo = window.location.origin;

    if (E2E_AUTH) {
      document.cookie = "rtf_e2e_session=; Max-Age=0; path=/";
      window.location.assign(returnTo);
      return;
    }

    try {
      // returnTo MUST be listed in the Auth0 application's Allowed Logout URLs
      // or Auth0 strands the user on its own error page. Local teardown has
      // already happened by then, so the tab is at least signed out.
      void logout({ logoutParams: { returnTo } });
    } catch (err) {
      console.error("auth0 logout failed", err);
      window.location.assign(returnTo);
    }
  }, [logout, reset]);
}
