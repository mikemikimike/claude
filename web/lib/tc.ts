/**
 * Transaction Coordinator assignment — the shared half of the two paths that
 * can name an agent's TC (#415):
 *
 *   - PUT /api/me/tc                        (Settings → Transaction Coordinator)
 *   - POST /api/deals/:id/participants      (Add Participant → role `tc`)
 *
 * Both write the SAME place — `users.tc_contact` + `users.tc_user_id` on the
 * agent's own row — and both invite a TC who has no account yet. Keeping the
 * behaviour here is what stops them drifting apart again; before this, one
 * silently stored text and the other returned a bare 404.
 *
 * There is no `tc_invites` table on purpose. The agent's `tc_contact` row IS
 * the pending invite: `pendingTcContactRole` (lib/invite-role.ts) reads it to
 * give the signup `role = 'tc'`, and `linkTcContacts` (lib/users.ts) clears it
 * by setting `tc_user_id`.
 */
import { prisma } from "./db";
import { sendTcInviteEmail } from "./email";

export type TcContact = {
  name: string;
  email: string;
  phone: string;
};

/**
 * The account id for an email, or null. Matches by email ALONE — notably not
 * `role = 'tc'`, which is what made the original save-time lookup unable to
 * ever match a brand-new signup (the Auth0 tenant hands every signup the
 * default `agent` role).
 *
 * Raw SQL, like the lookups in lib/invite-role.ts: `lower(email) = lower($1)`
 * is the form the functional index from migration 000062 can serve, where
 * Prisma's `mode: "insensitive"` emits an unindexable ILIKE. ORDER BY
 * created_at because users.email is unique only case-SENSITIVELY, so the
 * original account wins if a case-variant pair ever appears.
 */
export async function findAccountByEmail(
  email: string
): Promise<{ id: string; name: string } | null> {
  if (!email) return null;
  const rows = await prisma.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text AS id, name
      FROM users
     WHERE lower(email) = lower(${email})
     ORDER BY created_at ASC
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/** `findAccountByEmail`, id only. */
export async function findAccountIdByEmail(email: string): Promise<string | null> {
  return (await findAccountByEmail(email))?.id ?? null;
}

/** The TC contact currently stored on an agent's row, or null. */
export async function currentTcContact(agentId: string): Promise<TcContact | null> {
  const row = await prisma.users.findUnique({
    where: { id: agentId },
    select: { tc_contact: true },
  });
  if (!row || row.tc_contact == null) return null;
  const c = row.tc_contact as { name?: string; email?: string; phone?: string };
  return { name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "" };
}

/**
 * Emails the TC their signup link. Best-effort by contract: returns false
 * instead of throwing, so a Resend outage degrades to "saved but not emailed"
 * rather than failing the agent's save.
 *
 * The link is the app root — RootRedirect sends a `tc` straight to /tc once
 * they have signed in. No token: the invite is bound to the EMAIL, because
 * that is what pendingTcContactRole and linkTcContacts match on.
 */
export async function inviteTc(input: {
  email: string;
  name: string;
  agentName: string;
  origin: string;
}): Promise<boolean> {
  try {
    await sendTcInviteEmail({
      to: input.email,
      name: input.name,
      agentName: input.agentName,
      inviteUrl: `${input.origin}/`,
    });
    return true;
  } catch (err) {
    console.error("failed to send TC invite email", err);
    return false;
  }
}

/**
 * Writes the agent's TC assignment: the typed contact plus the linked account
 * id when one exists. Passing `tcUserId: null` deliberately clears a stale
 * link — re-pointing at a TC with no account must not leave the old one wired
 * up to the agent's deals.
 */
export async function saveTcAssignment(input: {
  agentId: string;
  contact: TcContact;
  tcUserId: string | null;
}): Promise<void> {
  await prisma.users.update({
    where: { id: input.agentId },
    data: {
      tc_user_id: input.tcUserId,
      tc_contact: { ...input.contact },
      updated_at: new Date(),
    },
  });
}
