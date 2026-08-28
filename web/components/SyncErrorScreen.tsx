"use client";

import { useLogout } from "@/hooks/useLogout";

// Inline styles rather than Tailwind so this screen renders identically
// wherever it is mounted, including above route trees that never load the app
// shell. The escape-hatch button matches them instead of importing UserMenu.
export const logoutButtonStyle: React.CSSProperties = {
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
 * What a signed-in user sees when `POST /users/sync` (or the invite claim that
 * precedes it) failed. Extracted from `RootRedirect` for #425: the invite flow
 * now lands a new client on `/onboard/<role>` rather than `/`, so this screen
 * has to be reachable from more than one place — and there must be exactly one
 * copy of the wording, because two of the three branches are load-bearing
 * instructions rather than decoration.
 *
 * Two of the markers (set by AuthSetup#classifySyncError) are PERMANENT states
 * with their own next step; only the fallback is a genuine transient failure
 * where refreshing can help.
 *
 *   "no-access"      = authenticated but no role yet (invite not accepted).
 *   "email-conflict" = /users/sync 409 — this email already belongs to a
 *                      different Auth0 identity, so the collision is in the
 *                      database and every refresh returns the same 409.
 *                      Never tell this user to refresh (#397).
 */
export default function SyncErrorScreen({ syncError }: { syncError: string }) {
  const logout = useLogout();

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
