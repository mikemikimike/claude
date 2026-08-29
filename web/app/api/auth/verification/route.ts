import { error, json, withAuth } from "@/lib/http";
import { getAuth0Client } from "@/lib/auth0";

/**
 * Email-verification state + resend, always scoped to the CALLER (claims.sub).
 *
 * The API access token only carries sub + roles (see lib/auth.ts — the Auth0
 * Post-Login Action injects roles, not email_verified), so verification state
 * comes from the Management API's getUser. When the M2M credentials are not
 * configured the GET reports `email_verified: null` — "we could not determine
 * this" — and callers keep the banner quiet rather than nagging about a check
 * we cannot perform.
 *
 * It used to report `true` in that case, which produced the same quiet UI by
 * asserting something it had not checked. That fails OPEN: the credentials were
 * empty strings in production for months (#405), so every account looked
 * verified and nothing could tell a verified address from an unverified one.
 * `null` keeps the UI identical while letting any caller that GATES on
 * verification treat "unknown" as "not verified" — the safe direction.
 */

// GET /api/auth/verification → { email_verified: boolean | null } for the
// caller; null means undeterminable, never assume it either way.
export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const auth0 = getAuth0Client();
    if (!auth0.managementEnabled()) {
      return json({ email_verified: null });
    }
    try {
      const user = await auth0.getUser(claims.sub);
      return json({ email_verified: user.email_verified });
    } catch (err) {
      console.error("verification status lookup failed", err);
      return error("could not check email verification status", 502);
    }
  })) as Response;
}

// POST /api/auth/verification → resend the verification email to the CALLER.
// Never accepts a target user from the body — claims.sub only.
export async function POST(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const auth0 = getAuth0Client();
    if (!auth0.managementEnabled()) {
      return error("email verification is not configured", 503);
    }
    try {
      const user = await auth0.getUser(claims.sub);
      if (user.email_verified) {
        return json({ ok: true, already_verified: true });
      }
      await auth0.sendVerificationEmail(claims.sub);
      return json({ ok: true });
    } catch (err) {
      // User-initiated action — this one CAN error visibly.
      console.error("resend verification email failed", err);
      return error(
        "could not send the verification email — please try again shortly",
        502
      );
    }
  })) as Response;
}
