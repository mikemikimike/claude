/**
 * Shared HTTP helpers for route handlers.
 *
 * - `json(data, status?)` — return JSON with the right Content-Type.
 * - `error(message, status)` — return a plain-text error matching the Go
 *   backend's `http.Error` semantics.
 * - `withAuth(req, handler, allowedRoles?)` — verifies JWT, optionally checks
 *   role overlap, rejects deactivated users, and translates AuthError to the
 *   right HTTP status.
 * - `upsertUserOrConflict(input)` — upsertUser with the email-collision 409
 *   mapping applied, for every route that provisions an account.
 */
import { AuthError, verifyAuth0Jwt, type AuthClaims, type VerifyOptions } from "./auth";
import { prisma } from "./db";
import { requireRole } from "./roles";
import { assertNotDeactivated, EmailConflictError, upsertUser, type SyncedUser } from "./users";

export function json<T>(data: T, status = 200): Response {
  return Response.json(data as object, { status });
}

export function error(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * `upsertUser` plus the one mapping every account-provisioning route needs:
 * a NEW Auth0 subject presenting an email already bound to a DIFFERENT users
 * row throws the typed `EmailConflictError`, which must become a readable 409
 * rather than escaping withAuth as an unhandled 500 (#277, #396).
 *
 * Returns the user, or a ready-to-return 409 `Response` — so callers narrow
 * with `if (user instanceof Response) return user;` instead of repeating the
 * try/catch. `upsertUser`'s throwing contract is deliberately unchanged; this
 * only owns the HTTP translation, which is why it lives here and not in
 * lib/users.ts.
 *
 * Use this from any route that provisions an account. Getting it wrong is not
 * a cosmetic 500: AuthSetup treats only 404/409/410 as terminal, so a 500 on a
 * claim keeps the pending-invite localStorage keys and replays the claim on
 * every page load — a permanent lockout loop (#396).
 */
export async function upsertUserOrConflict(
  input: Parameters<typeof upsertUser>[0]
): Promise<SyncedUser | Response> {
  try {
    return await upsertUser(input);
  } catch (err) {
    if (err instanceof EmailConflictError) {
      await logEmailConflict(input.auth0Id, input.email);
      return error(err.message, err.status);
    }
    throw err;
  }
}

/**
 * Log WHICH two identities collided on a 409.
 *
 * Resolving one of these means pointing an existing row at the identity the
 * user actually authenticates with, so the incoming Auth0 subject is the single
 * value support needs — and it was the one thing the 409 path discarded. The
 * response body can't carry it (it is another account's data, shown to whoever
 * triggered the collision), so it goes to the server log instead. Without this
 * the only way to learn the subject is to read it out of the Auth0 dashboard by
 * hand, which is exactly the loop this is meant to end.
 *
 * Best-effort by construction: the owner lookup is swallowed so a failure there
 * can never turn a clean, recoverable 409 into a 500 (#396's lockout loop is
 * precisely what a 500 on this path causes). A partial log line beats a broken
 * error path.
 */
async function logEmailConflict(incomingAuth0Id: string, email: string): Promise<void> {
  let owner: { id: string; auth0_id: string; role: string } | null = null;
  try {
    owner = await prisma.users.findFirst({
      where: { email },
      // Oldest-first so the row reported is deterministic, matching how the
      // email lookups in lib/invite-role.ts break a would-be tie.
      orderBy: { created_at: "asc" },
      select: { id: true, auth0_id: true, role: true },
    });
  } catch {
    // leave owner null — the incoming subject alone is still actionable
  }
  console.error("users email conflict", {
    email,
    incomingAuth0Id,
    existingUserId: owner?.id ?? null,
    existingAuth0Id: owner?.auth0_id ?? null,
    existingRole: owner?.role ?? null,
  });
}

export type AuthedHandler<T> = (claims: AuthClaims) => Promise<T> | T;

export async function withAuth<T>(
  req: Request,
  handler: AuthedHandler<T>,
  opts?: { allowedRoles?: readonly string[]; verifyOpts?: VerifyOptions }
): Promise<Response | T> {
  try {
    const claims = await verifyAuth0Jwt(req, opts?.verifyOpts);
    if (opts?.allowedRoles) {
      requireRole(claims.roles, opts.allowedRoles);
    }
    // A valid JWT is not enough: a deactivated user (users.deactivated_at
    // set) is blocked on every protected route, including /users/sync (#173).
    await assertNotDeactivated(claims.sub);
    return await handler(claims);
  } catch (err) {
    if (err instanceof AuthError) {
      return error(err.message, err.status);
    }
    console.error("unhandled error in route handler", err);
    return error("internal server error", 500);
  }
}
