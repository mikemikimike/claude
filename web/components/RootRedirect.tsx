"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth0 } from "@auth0/auth0-react";
import { useAuthStore } from "@/lib/store/authStore";
import { useLogout } from "@/hooks/useLogout";
import { GroupId } from "@/permissions/groups";

// Both error screens below use inline styles rather than Tailwind, so the
// escape-hatch button matches them instead of importing UserMenu.
const logoutButtonStyle: React.CSSProperties = {
  marginTop: 20,
  padding: "10px 18px",
  borderRadius: 10,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

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

  if (syncError) {
    // Two of these markers (set by AuthSetup#classifySyncError) are PERMANENT
    // states with their own next step; only the fallback is a genuine transient
    // failure where refreshing can help.
    //
    //   "no-access"      = authenticated but no role yet (invite not accepted).
    //   "email-conflict" = /users/sync 409 — this email already belongs to a
    //                      different Auth0 identity, so the collision is in the
    //                      database and every refresh returns the same 409.
    //                      Never tell this user to refresh (#397).
    const noAccess = syncError === "no-access";
    const emailConflict = syncError === "email-conflict";
    const heading = noAccess
      ? "You're not set up yet"
      : emailConflict
        ? "This email already has an account"
        : "We couldn't load your account";
    const explanation = noAccess
      ? "Open the invite link your agent sent you to finish creating your account — or ask them to resend it."
      : emailConflict
        ? "An account already exists for this email address. Log out and sign back in with the account you originally created, or contact support and we can merge the two."
        : "Something went wrong reaching your account. Please refresh the page. If this keeps happening, contact your agent or support.";
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          fontFamily: "-apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h2 style={{ color: "#0f172a", marginBottom: 8 }}>{heading}</h2>
          <p style={{ color: "#64748b", lineHeight: 1.5 }}>{explanation}</p>
          {/* Without this the screen is a hard dead-end: signed in, no usable
              account, no way to reach another one. On the email-conflict branch
              it is also the actual fix — log out, sign in as the original
              identity. */}
          <button onClick={logout} style={logoutButtonStyle}>
            Log out
          </button>
        </div>
      </div>
    );
  }

  return null;
}
