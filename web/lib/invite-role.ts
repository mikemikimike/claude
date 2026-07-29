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
  const invite = await prisma.deal_invites.findFirst({
    where: {
      email: { equals: email, mode: "insensitive" },
      claimed_at: null,
      expires_at: { gt: new Date() },
    },
    orderBy: { created_at: "desc" },
    select: { role: true },
  });
  // deal_invites.role is a plain text column, not the user_role enum — validate
  // rather than casting so a bad row can't reach the enum as a 500.
  return isValidRole(invite?.role) ? invite.role : null;
}

/**
 * The role that applies to an email: the users row first, then any open invite,
 * else "". Backs GET /api/invites/role, which the Auth0 Post-Login Action calls
 * (behind the INVITE_ROLE_SECRET gate — see that route).
 */
export async function roleForEmail(email: string): Promise<Role | ""> {
  if (!email) return "";
  const user = await prisma.users.findUnique({
    where: { email },
    select: { role: true },
  });
  if (user) return user.role as Role;
  return (await pendingInviteRole(email)) ?? "";
}
