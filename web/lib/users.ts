import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "./db";
import { AuthError } from "./auth";
import { decideRole, resolveRole, type Role } from "./roles";
import { pendingInviteRole } from "./invite-role";

export type SyncedUser = {
  id: string;
  auth0_id: string;
  email: string;
  name: string;
  role: Role;
  phone: string | null;
  onboarding_complete: boolean;
  created_at: Date;
  updated_at: Date;
};

/**
 * Thrown by upsertUser when a NEW auth0 subject presents an email that already
 * belongs to a DIFFERENT user row (Postgres 23505 on users_email_key). Follows
 * the AuthError typed-error style (a catchable Error subclass carrying its HTTP
 * status) so route handlers can map it to a readable 409 instead of the opaque
 * 500 a raw unique violation would otherwise become (#277).
 */
export class EmailConflictError extends Error {
  readonly status = 409 as const;
  constructor(message = "an account with this email already exists") {
    super(message);
    this.name = "EmailConflictError";
  }
}

/**
 * Upserts a user from JWT data. Preserves a hand-edited name when Auth0 is
 * about to clobber it with the email (Auth0 sometimes defaults name=email).
 *
 * `role` is decided by the CALLER — resolveSyncRole for /users/sync, the invite
 * row for claim routes — and this deliberately writes whatever it is given. Do
 * not add role precedence here; it lives in exactly one place (lib/roles.ts
 * #decideRole) so the two claim routes can still set a role legitimately.
 *
 * Mirrors upsertUser in the legacy Go backend.
 */
export async function upsertUser(input: {
  auth0Id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * When true, an existing row KEEPS its current role — `input.role` only
   * applies on first insert. Invite claims use this so claiming can never
   * demote an existing account (#174: an agent opening their own client
   * invite must not become a buyer). Default (false) preserves the
   * historical overwrite for /users/sync, whose role comes from the JWT.
   */
  keepExistingRole?: boolean;
}): Promise<SyncedUser> {
  const roleOnConflict = input.keepExistingRole
    ? Prisma.sql`users.role`
    : Prisma.sql`EXCLUDED.role`;
  // Raw SQL keeps the CASE-WHEN name-preserve logic exactly as the Go side.
  let rows: SyncedUser[];
  try {
    rows = await prisma.$queryRaw<SyncedUser[]>`
      INSERT INTO users (auth0_id, email, name, role)
      VALUES (${input.auth0Id}, ${input.email}, ${input.name}, ${input.role}::user_role)
      ON CONFLICT (auth0_id) DO UPDATE
      SET email      = EXCLUDED.email,
          name       = CASE
                         WHEN users.name IS NULL OR users.name = '' OR users.name = users.email
                         THEN EXCLUDED.name
                         ELSE users.name
                       END,
          role       = ${roleOnConflict},
          updated_at = NOW()
      RETURNING id, auth0_id, email, name, role, phone, onboarding_complete, created_at, updated_at
    `;
  } catch (err) {
    // A new auth0 sub carrying an email already bound to a DIFFERENT row trips
    // users_email_key. ON CONFLICT (auth0_id) already absorbs same-sub
    // re-syncs, so the only unique violation that can escape this INSERT is the
    // email one — re-throw it typed so the caller can return a clean 409 (#277).
    if (isEmailUniqueViolation(err)) {
      throw new EmailConflictError();
    }
    throw err;
  }
  return rows[0];
}

/**
 * True when `err` is a unique-constraint violation on the users email column.
 * Handles the shapes Prisma 7 + the pg driver adapter surface it in:
 *  - a raw-query failure (P2010) wrapping the pg error under
 *    meta.driverAdapterError.cause (what upsertUser's $queryRaw throws),
 *  - a model-style unique violation (P2002, meta.target names the field),
 *  - a bare pg passthrough carrying code 23505 + constraint.
 * Confirms the email field where the detail is present; on this INSERT the only
 * inserted unique that can fire (auth0_id aside, handled by ON CONFLICT) is
 * users_email_key, so an unqualified unique violation is treated as the email.
 *
 * Exported for direct unit testing across the (Prisma-version-dependent) error
 * shapes — the live DB only ever produces the P2010 branch.
 */
export function isEmailUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: unknown;
    meta?: unknown;
    message?: unknown;
    constraint?: unknown;
  };

  // Prisma raw-query failure (P2010) wrapping the driver-adapter error.
  const cause = (
    e.meta as
      | {
          driverAdapterError?: {
            cause?: {
              originalCode?: unknown;
              kind?: unknown;
              originalMessage?: unknown;
              constraint?: { fields?: unknown };
            };
          };
        }
      | undefined
  )?.driverAdapterError?.cause;
  if (
    cause &&
    (cause.originalCode === "23505" ||
      cause.kind === "UniqueConstraintViolation")
  ) {
    const fields = cause.constraint?.fields;
    if (Array.isArray(fields)) return fields.includes("email");
    if (typeof cause.originalMessage === "string") {
      return cause.originalMessage.includes("email");
    }
    return true;
  }

  // Prisma model-style unique violation (P2002) — defensive, e.g. if this ever
  // moves to a typed .create()/.upsert(); meta.target names the offending field.
  if (e.code === "P2002") {
    const target = (e.meta as { target?: unknown } | undefined)?.target;
    if (Array.isArray(target)) return target.includes("email");
    if (typeof target === "string") return target.includes("email");
    return true;
  }

  // Bare pg passthrough (no Prisma wrapper).
  if (e.code === "23505") {
    return typeof e.constraint !== "string" || e.constraint.includes("email");
  }

  // Last resort: the constraint name / code surfaced only in the message text
  // (hardens against Prisma changing the nested meta shape between versions —
  // upsertUser's error message includes `users_email_key` and `23505`).
  if (typeof e.message === "string") {
    if (e.message.includes("users_email_key")) return true;
    if (e.message.includes("23505") && e.message.includes("email")) return true;
  }

  return false;
}

/**
 * Throws AuthError(403) when the auth0 subject maps to a deactivated user
 * row (users.deactivated_at set). A missing row passes — brand-new users
 * (first /users/sync, invite claims) have no row yet and must not be blocked.
 *
 * Called by withAuth (lib/http.ts) so a valid JWT alone is never enough:
 * deactivation revokes access on every protected route immediately (#173).
 */
export async function assertNotDeactivated(auth0Id: string): Promise<void> {
  const row = await prisma.users.findUnique({
    where: { auth0_id: auth0Id },
    select: { deactivated_at: true },
  });
  if (row?.deactivated_at) {
    throw new AuthError("account deactivated", 403);
  }
}

/**
 * Looks up the DB user id for a given auth0 subject. Returns null if no row.
 * Throws AuthError(403) for a deactivated user — defense in depth on top of
 * the withAuth choke point (#173).
 */
export async function resolveUserId(auth0Id: string): Promise<string | null> {
  const row = await prisma.users.findUnique({
    where: { auth0_id: auth0Id },
    select: { id: true, deactivated_at: true },
  });
  if (row?.deactivated_at) {
    throw new AuthError("account deactivated", 403);
  }
  return row?.id ?? null;
}

/**
 * Resolves the role POST /api/users/sync writes for a caller. Owns the IO only
 * — the precedence rule itself is decideRole() in lib/roles.ts, and that is the
 * single place it lives.
 *
 * Throws AuthError(403) for a deactivated user — defense in depth on top of the
 * withAuth choke point (#173).
 */
export async function resolveSyncRole(input: {
  auth0Id: string;
  claimRoles: readonly string[];
  email: string;
}): Promise<Role | null> {
  const row = await prisma.users.findUnique({
    where: { auth0_id: input.auth0Id },
    select: { role: true, deactivated_at: true },
  });
  if (row?.deactivated_at) {
    throw new AuthError("account deactivated", 403);
  }
  const dbRole = (row?.role as Role | undefined) ?? null;

  // The invite lookup can only change the answer when there is no row yet
  // (decideRole rule 3), so skip the query entirely for returning users — this
  // costs one extra read on first login and nothing after that.
  const inviteRole = row ? null : await pendingInviteRole(input.email);

  return decideRole({
    claimedRole: resolveRole(input.claimRoles),
    dbRole,
    inviteRole,
  });
}
