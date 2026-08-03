import { prisma } from "./db";
import { isValidRole, type Role } from "./roles";

/**
 * The role an OPEN (unclaimed, unexpired) deal invite implies for an email.
 * Newest invite wins.
 *
 * Case-insensitive on purpose: Auth0 hands back a normalized address, while the
 * agent typed whatever they typed into the invite form. A case difference must
 * not silently drop the invited role and leave the client as an agent.
 */
export async function pendingInviteRole(email: string): Promise<Role | null> {
  if (!email) return null;
  // Raw SQL rather than Prisma's `mode: "insensitive"`, which emits ILIKE — and
  // ILIKE cannot use an index, so this lookup was a sequential scan (34.6ms on
  // 100k rows, vs 0.11ms now). `lower(email) = lower($1)` matches the functional
  // index in migration 000061 exactly; change one and you must change the other,
  // or this silently reverts to a full scan on the login hot path.
  const rows = await prisma.$queryRaw<{ role: string }[]>`
    SELECT role FROM deal_invites
     WHERE lower(email) = lower(${email})
       AND claimed_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1
  `;
  const invite = rows[0];
  // deal_invites.role is a plain text column, not the user_role enum. The DB
  // check constraint (deal_invites_role_check) keeps it to buyer/seller; this
  // validates rather than casting so that if the constraint is ever relaxed, a
  // bad value can't reach the user_role enum as an opaque 500 — or worse, hand
  // out a role nobody was invited to.
  return isValidRole(invite?.role) ? invite.role : null;
}

/**
 * The role that applies to an email: the users row first, then any open invite,
 * else "". Backs GET /api/invites/role, which the Auth0 Post-Login Action calls
 * (behind the INVITE_ROLE_SECRET gate — see that route).
 */
export async function roleForEmail(email: string): Promise<Role | ""> {
  if (!email) return "";
  // findFirst, not findUnique: matching has to be case-insensitive for the same
  // reason as above, and a unique-where clause only takes an exact string. A
  // case-sensitive miss here would silently fall through to the invite lookup
  // and report an invited role for someone whose account already exists.
  const user = await prisma.users.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { role: true },
  });
  if (user) return isValidRole(user.role) ? user.role : "";
  return (await pendingInviteRole(email)) ?? "";
}
