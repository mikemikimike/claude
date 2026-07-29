import { env } from "@/lib/env";
import { error, json } from "@/lib/http";
import { roleForEmail } from "@/lib/invite-role";

// Called by the Auth0 Post-Login Action to resolve a role for a given email.
// Returns "" if no role applies (which the Action then surfaces as a 403 the
// frontend can handle).
//
// Gated by a shared secret (INVITE_ROLE_SECRET) the Action sends in the
// `x-invite-role-token` header — otherwise this is an unauthenticated
// email→role oracle for enumerating which emails have accounts/invites and what
// role each holds (#271). Same fail-closed shape as /api/indexnow/notion:
// secret unset → 503 (never compare against an empty secret); wrong/missing
// token → 401.
export async function GET(req: Request): Promise<Response> {
  const secret = env().INVITE_ROLE_SECRET;
  if (!secret) return error("invite role lookup not configured", 503);
  if (req.headers.get("x-invite-role-token") !== secret) {
    return error("unauthorized", 401);
  }

  // Lookup itself lives in lib/invite-role.ts — shared with resolveSyncRole so
  // the Action and /users/sync can never disagree about what an email's role is.
  const email = new URL(req.url).searchParams.get("email");
  return json({ role: email ? await roleForEmail(email) : "" });
}
