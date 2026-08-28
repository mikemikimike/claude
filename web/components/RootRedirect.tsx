"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth0 } from "@auth0/auth0-react";
import { useAuthStore } from "@/lib/store/authStore";
import { useLogout } from "@/hooks/useLogout";
import SyncErrorScreen, { logoutButtonStyle } from "@/components/SyncErrorScreen";
import { GroupId } from "@/permissions/groups";

/**
 * Smart root redirect based on active user group.
 * Returns null while Auth0 and /users/sync are still initializing so we never
 * default-route a buyer or seller to /agent. Ported from the legacy frontend.
 */
export default function RootRedirect() {
  const {
    isLoading: auth0Loading,
    isAuthenticated,
    loginWithRedirect,
    error: auth0Error,
  } = useAuth0();
  const isLoaded = useAuthStore((s) => s.isLoaded);
  const syncError = useAuthStore((s) => s.syncError);
  const activeUser = useAuthStore((s) => s.activeUser);
  const router = useRouter();
  const logout = useLogout();

  useEffect(() => {
    if (!auth0Loading && !isAuthenticated && !auth0Error) {
      void loginWithRedirect();
    }
  }, [auth0Loading, isAuthenticated, auth0Error, loginWithRedirect]);

  useEffect(() => {
    if (auth0Loading || !isAuthenticated || !isLoaded || auth0Error || syncError) return;
    const groupId = activeUser?.groupId as GroupId | undefined;
    const done = activeUser?.onboardingComplete;
    if (groupId === "admin") return router.replace("/admin");
    // Buyers/sellers run their personalization questionnaire once, right after
    // they accept the invite + create their account, then land on the portal.
    if (groupId === "buyer")
      return router.replace(done ? `/buyer/${activeUser?.id}` : "/onboard/buyer");
    if (groupId === "seller")
      return router.replace(done ? `/seller/${activeUser?.id}` : "/onboard/seller");
    if (groupId === "tc") return router.replace("/tc");
    // lending_partner is a real role with no product surface yet (#307) — send
    // it to its honest placeholder, never the full agent app.
    if (groupId === "lending_partner") return router.replace("/lending-partner");
    if (!done) return router.replace("/onboard/agent");
    router.replace("/agent");
  }, [auth0Loading, isAuthenticated, isLoaded, auth0Error, syncError, activeUser, router]);

  if (auth0Error) {
    return (
      <div style={{ padding: 32, fontFamily: "monospace" }}>
        <h2 style={{ color: "red" }}>Auth0 error</h2>
        <pre>{auth0Error.message}</pre>
        <button onClick={logout} style={logoutButtonStyle}>
          Log out
        </button>
      </div>
    );
  }

  // The same screen `/onboard/*` renders (app/onboard/layout.tsx). Shared via
  // components/SyncErrorScreen so the two entry points can never drift — two of
  // its three branches are the user's only actionable instruction, not copy.
  if (syncError) return <SyncErrorScreen syncError={syncError} />;

  return null;
}
