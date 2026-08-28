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
 * Every role an INVITE can establish — the two client-portal roles plus `tc`.
 *
 * `tc` joined this set with #415: an agent adds their Transaction Coordinator
 * in Settings, we email them, and the pending assignment on the agent's row
 * (`users.tc_contact`) is the only thing that says the person signing up is a
 * TC rather than yet another self-serve agent. Auth0 RBAC can still grant `tc`
 * directly (that path goes through rule 1, not here).
 *
 * Deliberately a SUPERSET of isClientRole rather than a widening of it —
 * isClientRole answers "is this a portal client?", which drives portal-only
 * behaviour elsewhere and must keep excluding TCs.
 */
export function isInvitedRole(role: string | null | undefined): role is Role {
  return isClientRole(role) || role === "tc";
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
}): Role | null {
  const { claimedRole, dbRole, inviteRole } = input;

  // 1. An explicit (non-default) claim always wins. This is the documented
  //    promotion path: assign the role in Auth0 RBAC → log out → log back in.
  if (claimedRole && claimedRole !== DEFAULT_TENANT_ROLE) return claimedRole;

  // 2. An established buyer/seller/tc is NEVER overwritten by the tenant's
  //    default `agent` claim. Without this an invited TC (#415) is demoted back
  //    to agent on their SECOND login, since the tenant keeps handing them the
  //    default claim. Escape hatch for a genuine client/TC→agent move: update
  //    users.role directly, then re-login — dbRole is no longer an invited
  //    role, so rule 4 takes over and the claim is honoured again.
  if (isInvitedRole(dbRole)) return dbRole;

  // 3. No row yet — the invite claim POST is slow, failed, or they logged in on
  //    a device that never saw the invite link. An OPEN invite addressed to
  //    them is better evidence than the tenant default. Gated on !dbRole so an
  //    agent who happens to hold a client invite for their own email is never
  //    demoted (cf. #174) — which is also what stops an established agent whom
  //    someone typed into their TC settings from being turned into a TC (#415).
  if (!dbRole && isInvitedRole(inviteRole)) return inviteRole;

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
