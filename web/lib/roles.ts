import { AuthError } from "./auth";

export { AuthError };

/**
 * The six roles the platform recognizes — the single source of truth. `Role` is
 * derived from it, `isValidRole` guards against anything else, and it mirrors
 * the Postgres `user_role` enum. Adding a role means adding it here AND to the
 * enum via a migration (and to ROLE_PRECEDENCE below).
 */
export const ROLES = [
  "agent",
  "buyer",
  "seller",
  "admin",
  "tc",
  "lending_partner",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Runtime whitelist check for an untrusted role string (e.g. a JWT `roles`
 * claim). Narrows to `Role` so callers stop reaching for an unchecked
 * `as Role` cast — that cast is exactly what let a typo'd or misconfigured
 * Auth0 role slip through to the DB `user_role` enum and surface as an opaque
 * 500 instead of a clear 4xx (#308).
 */
export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Precedence for collapsing a multi-role JWT claim to one role, most privileged
 * first. A token should normally carry exactly one role; when it carries
 * several we resolve deterministically to the most privileged rather than
 * silently taking whichever happened to be first in the array (#308).
 *
 * admin > tc > agent > lending_partner > seller > buyer:
 *   - admin           — platform-wide administration
 *   - tc              — transaction coordinator; works across many agents' deals
 *   - agent           — owns and manages their own deals (full CRUD, invites)
 *   - lending_partner — read access to loan data on linked deals
 *   - seller / buyer  — client portal, scoped to a single deal
 */
const ROLE_PRECEDENCE: readonly Role[] = [
  "admin",
  "tc",
  "agent",
  "lending_partner",
  "seller",
  "buyer",
];

/**
 * Collapses a JWT `roles` claim to the single most-privileged recognized role,
 * ignoring any unrecognized entries. Returns null when the claim contains no
 * recognized role at all — the caller turns that into a clear 4xx instead of
 * letting a bad value hit the `user_role` enum (#308).
 */
export function resolveRole(claimRoles: readonly string[]): Role | null {
  for (const role of ROLE_PRECEDENCE) {
    if (claimRoles.includes(role)) return role;
  }
  return null;
}

/**
 * The role the Auth0 tenant hands every brand-new signup. Self-serve agent
 * signup is intentional — someone who signs up with no invite SHOULD become an
 * agent — but that makes the claim a DEFAULT rather than a statement of
 * identity, so it must lose to a role an invite already established. See
 * decideRole.
 */
export const DEFAULT_TENANT_ROLE: Role = "agent";

/**
 * Client-portal roles. These only ever come from a deal invite — Auth0 RBAC
 * never assigns them — which is why decideRole treats them as authoritative.
 */
export function isClientRole(role: string | null | undefined): role is Role {
  return role === "buyer" || role === "seller";
}

/**
 * THE role-precedence rule for POST /api/users/sync. Pure — all IO lives in
 * resolveSyncRole (lib/users.ts). This is the ONLY place the rule lives: do not
 * add a second guard in upsertUser or in the route handler.
 *
 * Fixes the invited-client-becomes-an-agent bug: the claim route wrote `buyer`,
 * then the very next /users/sync overwrote it with the tenant's default `agent`
 * claim and dropped the client into agent onboarding.
 *
 * Returns null when nothing anywhere assigns a role — the caller turns that
 * into a 403.
 */
export function decideRole(input: {
  claimedRole: Role | null;
  dbRole: Role | null;
  inviteRole: Role | null;
  /**
   * Whether some agent still has this user as their linked transaction
   * coordinator (`users.tc_user_id`). Only consulted for a persisted `tc` —
   * see rule 2b. Defaults to false, which is the safe direction: it can only
   * ever demote a `tc` back to whatever the claim says.
   */
  tcLinked?: boolean;
}): Role | null {
  const { claimedRole, dbRole, inviteRole, tcLinked = false } = input;

  // 1. An explicit (non-default) claim always wins. This is the documented
  //    promotion path: assign the role in Auth0 RBAC → log out → log back in.
  if (claimedRole && claimedRole !== DEFAULT_TENANT_ROLE) return claimedRole;

  // 2a. An established buyer/seller is NEVER overwritten by the tenant's
  //    default `agent` claim. Escape hatch for a genuine client→agent move:
  //    update users.role directly, then re-login — dbRole is no longer a client
  //    role, so rule 4 takes over and the claim is honoured again.
  if (isClientRole(dbRole)) return dbRole;

  // 2b. A persisted `tc` is protected the same way, but only WHILE THE LINK
  //    THAT MADE THEM ONE STILL EXISTS (#446). The protection is needed for the
  //    same reason as 2a — the tenant keeps handing an invited TC the default
  //    `agent` claim, which would demote them on their second login — but
  //    making it unconditional (as #415 did) meant TC revocation silently
  //    stopped working: dropping their Auth0 `tc` role left them a `tc`
  //    forever, and only a hand-written `UPDATE users SET role='agent'` could
  //    undo it.
  //
  //    Tying it to the link makes revocation an in-product action with no SQL:
  //    the agent removes them in Settings → Transaction Coordinator (which
  //    clears `tc_user_id`), and their next login returns them to `agent`. A TC
  //    who serves several agents stays a `tc` until the LAST one removes them.
  //    Auth0-granted TCs are unaffected — that is an explicit claim, rule 1.
  if (dbRole === "tc") return tcLinked ? dbRole : (claimedRole ?? dbRole);

  // 3. No row yet — the invite claim POST is slow, failed, or they logged in on
  //    a device that never saw the invite link. An OPEN invite addressed to
  //    them is better evidence than the tenant default. Gated on !dbRole so an
  //    agent who happens to hold a client invite for their own email is never
  //    demoted (cf. #174).
  //
  //    Client roles ONLY. A TC never arrives this way: #446 removed the
  //    email-keyed TC lookup that fed this branch, because for a TC the role
  //    and the pipeline access are the same grant, so an email-only safety net
  //    WAS the vulnerability. A TC's role comes from claiming their token.
  if (!dbRole && isClientRole(inviteRole)) return inviteRole;

  // 4. Normal path — including self-serve agent signup with no invite at all.
  return claimedRole ?? dbRole;
}

export function hasRole(
  userRoles: readonly string[],
  allowed: readonly string[]
): boolean {
  if (allowed.length === 0) return false;
  for (const role of userRoles) {
    if (allowed.includes(role)) return true;
  }
  return false;
}

export function requireRole(
  userRoles: readonly string[],
  allowed: readonly string[]
): void {
  if (!hasRole(userRoles, allowed)) {
    throw new AuthError(
      `role required (one of: ${allowed.join(", ")})`,
      403
    );
  }
}
