import { prisma } from "./db";

export type DealMessageAccess = {
  isAgent: boolean;
  hasAccess: boolean;
  /**
   * The caller is the deal agent's linked transaction coordinator
   * (users.tc_user_id) — internal-channel-eligible (#178). Same predicate as
   * lib/deals.ts#isLinkedTCForDeal, folded into this query to keep access
   * resolution a single round-trip. NOTE: this is a DB fact only — routes must
   * still require the `tc` role claim before granting anything on it.
   */
  isLinkedTC: boolean;
  agentId: string | null;
};

/**
 * Resolves the caller's relationship to a deal for messaging purposes.
 * Mirrors dealAccessForMessages in the legacy Go backend.
 */
export async function getMessageAccess(
  dealId: string,
  userId: string
): Promise<DealMessageAccess> {
  const rows = await prisma.$queryRaw<
    {
      agent_id: string;
      is_agent: boolean;
      has_access: boolean;
      is_linked_tc: boolean;
    }[]
  >`
    SELECT
      agent_id,
      agent_id = ${userId}::uuid AS is_agent,
      (agent_id = ${userId}::uuid OR EXISTS (
        SELECT 1 FROM deal_participants dp
        WHERE dp.deal_id = ${dealId}::uuid AND dp.user_id = ${userId}::uuid
      )) AS has_access,
      EXISTS (
        SELECT 1 FROM users agent
        WHERE agent.id = deals.agent_id
          AND agent.tc_user_id = ${userId}::uuid
      ) AS is_linked_tc
    FROM deals WHERE id = ${dealId}::uuid
  `;
  const row = rows[0];
  if (!row) {
    return { isAgent: false, hasAccess: false, isLinkedTC: false, agentId: null };
  }
  return {
    isAgent: row.is_agent,
    hasAccess: row.has_access,
    isLinkedTC: row.is_linked_tc,
    agentId: row.agent_id,
  };
}

export type MessageRow = {
  id: string;
  deal_id: string;
  sender_id: string;
  sender_name: string;
  sender_role: string;
  channel: string;
  body: string;
  created_at: Date;
};

export async function listMessages(
  dealId: string,
  channel: "client_thread" | "internal"
): Promise<MessageRow[]> {
  return prisma.$queryRaw<MessageRow[]>`
    SELECT m.id, m.deal_id, m.sender_id, u.name AS sender_name, u.role::text AS sender_role,
           m.channel, m.body, m.created_at
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.deal_id = ${dealId}::uuid AND m.channel = ${channel}
    ORDER BY m.created_at ASC
  `;
}

/**
 * Atomic insert + join — matches the CTE in CreateMessage(messages.go:128).
 * The single round-trip returns the new row with sender_name/sender_role
 * already populated so the client doesn't need a follow-up SELECT.
 */
export async function createMessage(input: {
  dealId: string;
  senderId: string;
  channel: "client_thread" | "internal";
  body: string;
}): Promise<MessageRow> {
  const rows = await prisma.$queryRaw<MessageRow[]>`
    WITH inserted AS (
      INSERT INTO messages (deal_id, sender_id, channel, body)
      VALUES (${input.dealId}::uuid, ${input.senderId}::uuid, ${input.channel}, ${input.body})
      RETURNING id, deal_id, sender_id, channel, body, created_at
    )
    SELECT i.id, i.deal_id, i.sender_id, u.name AS sender_name, u.role::text AS sender_role,
           i.channel, i.body, i.created_at
    FROM inserted i
    JOIN users u ON u.id = i.sender_id
  `;
  return rows[0];
}

// ─── Unread state (#424) ──────────────────────────────────────────────────────

export type MessageChannel = "client_thread" | "internal";

/**
 * The one thread that feeds the Messages nav badge. The internal agent+TC
 * thread has its own read watermark (so reading one never clears the other)
 * but deliberately does not drive the badge — the badge answers "has a client
 * written in?".
 */
export const BADGED_CHANNEL: MessageChannel = "client_thread";

export type UnreadDealCount = { deal_id: string; unread: number };

/**
 * Unread client-thread messages, per deal, for one user.
 *
 * SCOPING IS SERVER-SIDE AND LIVES HERE: a deal only contributes if the caller
 * owns it (`deals.agent_id`) or sits on it (`deal_participants`). There is no
 * caller-supplied filter to get wrong — an agent physically cannot pull another
 * agent's counts through this.
 *
 * Unread = "newer than my watermark for this thread, and not written by me".
 * No watermark row (thread never opened) means everything in it is unread.
 *
 * Raw SQL, like the rest of this module: the LEFT JOIN onto the watermark plus
 * the aggregate is not expressible in the Prisma query API. The predicate is
 * served by idx_messages_deal_channel_created (000065) after
 * idx_deals_agent_id / idx_participants_user_id narrow to the caller's deals.
 */
export async function unreadMessageCounts(
  userId: string
): Promise<UnreadDealCount[]> {
  return prisma.$queryRaw<UnreadDealCount[]>`
    SELECT m.deal_id, COUNT(*)::int AS unread
    FROM messages m
    JOIN deals d ON d.id = m.deal_id
    LEFT JOIN message_reads r
      ON r.user_id = ${userId}::uuid
     AND r.deal_id = m.deal_id
     AND r.channel = ${BADGED_CHANNEL}
    WHERE m.channel = ${BADGED_CHANNEL}
      AND m.sender_id <> ${userId}::uuid
      AND (
        d.agent_id = ${userId}::uuid
        OR EXISTS (
          SELECT 1 FROM deal_participants dp
          WHERE dp.deal_id = d.id AND dp.user_id = ${userId}::uuid
        )
      )
      AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)
    GROUP BY m.deal_id
  `;
}

/**
 * Moves the caller's read watermark on one thread to now. Idempotent, and
 * monotonic via GREATEST — a stale request that lands out of order can never
 * drag the watermark backwards and resurrect already-read messages.
 *
 * Access is the CALLER's job (see the route): this writes unconditionally.
 */
export async function markThreadRead(
  userId: string,
  dealId: string,
  channel: MessageChannel
): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO message_reads (user_id, deal_id, channel, last_read_at)
    VALUES (${userId}::uuid, ${dealId}::uuid, ${channel}, now())
    ON CONFLICT (user_id, deal_id, channel) DO UPDATE
      SET last_read_at = GREATEST(message_reads.last_read_at, EXCLUDED.last_read_at)
  `;
}
