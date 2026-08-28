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
 * THE INVARIANT (#446): `users.tc_user_id` is written by exactly one thing —
 * POST /api/tc-invites/:token/claim, presenting a valid, unexpired, unclaimed
 * token. Nothing here links by email.
 *
 * #415 shipped the opposite: the agent's `tc_contact` row WAS the pending
 * invite, keyed on the email alone with no token and no expiry, so whoever
 * controlled an invited address could sign up at any point in the future and
 * be linked silently. A linked TC reads the agent's entire pipeline
 * (`listDealsForUser` scopes a TC by `tc_user_id`), so `tina@gmial.com` — one
 * typo — handed the pipeline to whoever owns the typo domain. The invite now
 * lives in `tc_invites`, modelled on `deal_invites`: token, 7-day expiry,
 * single claim.
 *
 * `tc_contact` keeps its other job: the name/email/phone the agent typed, for
 * the Settings card and the TC contact block. It is no longer a grant.
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
 * Used to detect self-assignment and to greet a known invitee by name. It does
 * NOT link them — that needs the token (#446).
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

/** The agent's current TC assignment: what they typed plus the linked account. */
export async function currentTcAssignment(
  agentId: string
): Promise<{ contact: TcContact | null; tcUserId: string | null }> {
  const row = await prisma.users.findUnique({
    where: { id: agentId },
    select: { tc_contact: true, tc_user_id: true },
  });
  if (!row) return { contact: null, tcUserId: null };
  const c = (row.tc_contact ?? null) as
    | { name?: string; email?: string; phone?: string }
    | null;
  return {
    contact: c
      ? { name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "" }
      : null,
    tcUserId: row.tc_user_id ?? null,
  };
}

/**
 * Retires every open invite this agent has issued.
 *
 * Called whenever the assignment moves — a new TC is saved, or the TC is
 * cleared — so a link that was emailed to the PREVIOUS address stops working
 * the moment the agent changes their mind. Without this, re-pointing the TC
 * field would leave the old invitee holding a live key to the pipeline.
 *
 * Marks them claimed-by-nobody rather than deleting, so the audit trail of who
 * was invited when survives.
 */
export async function expireOpenTcInvites(agentId: string): Promise<number> {
  return prisma.$executeRaw`
    UPDATE tc_invites
       SET claimed_at = NOW()
     WHERE agent_id = ${agentId}::uuid
       AND claimed_at IS NULL
  `;
}

/**
 * Issues a fresh tokened invite for this agent and returns its token.
 *
 * One open invite per agent at a time (the one-TC-per-agent model): any
 * outstanding one is expired first, so an agent who re-sends cannot leave two
 * live keys in two inboxes.
 */
export async function createTcInvite(input: {
  agentId: string;
  email: string;
  name: string;
}): Promise<string> {
  await expireOpenTcInvites(input.agentId);
  const rows = await prisma.$queryRaw<{ token: string }[]>`
    INSERT INTO tc_invites (agent_id, email, name)
    VALUES (${input.agentId}::uuid, ${input.email}, ${input.name})
    RETURNING token::text AS token
  `;
  return rows[0].token;
}

/**
 * Issues an invite and emails the TC their tokened signup link.
 *
 * Best-effort on the SEND only: a Resend outage returns false rather than
 * throwing, so the agent's save still succeeds. The invite row is written
 * either way — the agent can re-save to re-send, and the token is what the
 * claim needs, not the email.
 *
 * The link is `/tc-invite/<token>`: the landing page shows who invited them
 * before pushing anyone into creating an Auth0 account, stashes the token, and
 * AuthSetup claims it after the round-trip. Exactly the deal-invite shape.
 */
export async function inviteTc(input: {
  agentId: string;
  email: string;
  name: string;
  agentName: string;
  origin: string;
}): Promise<{ token: string; sent: boolean }> {
  const token = await createTcInvite({
    agentId: input.agentId,
    email: input.email,
    name: input.name,
  });
  try {
    await sendTcInviteEmail({
      to: input.email,
      name: input.name,
      agentName: input.agentName,
      inviteUrl: `${input.origin}/tc-invite/${token}`,
    });
    return { token, sent: true };
  } catch (err) {
    console.error("failed to send TC invite email", err);
    return { token, sent: false };
  }
}

/**
 * Writes the agent's TC assignment: the typed contact plus the linked account
 * id when one exists. Passing `tcUserId: null` deliberately clears a stale
 * link — re-pointing at a different TC must not leave the old one wired up to
 * the agent's deals.
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

/**
 * Whether this user is still SOMEBODY's linked transaction coordinator.
 *
 * Backs TC role revocation (#446, decideRole rule 2): a persisted `tc` is
 * protected from the tenant's default `agent` claim only while the link that
 * made them a TC still exists. Once every agent has removed them in Settings,
 * their next login demotes them — no manual `UPDATE users SET role='agent'`.
 *
 * Served by `users_tc_user_id_idx` (migration 000064); before that this
 * predicate — which `listDealsForUser` also runs for every TC page load — was
 * an unindexed scan.
 */
export async function isLinkedTc(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM users WHERE tc_user_id = ${userId}::uuid
    ) AS ok
  `;
  return rows[0]?.ok ?? false;
}
