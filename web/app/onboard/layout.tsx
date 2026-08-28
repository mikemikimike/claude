"use client";

import SyncErrorScreen from "@/components/SyncErrorScreen";
import { useAuthStore } from "@/lib/store/authStore";

/**
 * #425 — the claim/sync failure screens, for every onboarding route.
 *
 * Before this, `RootRedirect` was the ONLY renderer of `syncError`, because `/`
 * was the only place a freshly-signed-up user could land. The invite flow now
 * sends them straight to `/onboard/<role>`, which would have handed a client
 * whose invite claim AND `/users/sync` both failed an entire questionnaire
 * whose writes silently fail (`api.post(...).catch(() => {})`), instead of
 * telling them at the door.
 *
 * That matters most for `email-conflict`: a permanent 409 that returns the same
 * result on every refresh, whose screen carries the only instruction that
 * actually resolves it (#397). Twenty questions and then nothing is strictly
 * worse than the dead-end that fix removed.
 *
 * A layout rather than a per-page guard so buyer, seller and agent onboarding
 * all inherit it and a future `/onboard/*` route cannot forget it.
 *
 * `syncError` is set ONLY by a failed sync, so a signed-out visitor (e.g. a
 * `?token=` onboarding link opened before login) is never gated here.
 */
export default function OnboardLayout({ children }: { children: React.ReactNode }) {
  const syncError = useAuthStore((s) => s.syncError);
  if (syncError) return <SyncErrorScreen syncError={syncError} />;
  return <>{children}</>;
}
