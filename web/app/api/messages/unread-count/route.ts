import { error, json, withAuth } from "@/lib/http";
import { resolveUserId } from "@/lib/users";
import { unreadMessageCounts } from "@/lib/messages";

/**
 * GET /api/messages/unread-count — unread client-thread messages for the
 * caller, total and per deal (#424).
 *
 * Feeds the Messages nav badge. Role-agnostic on purpose: the scope comes from
 * the caller's own relationship to each deal (agent or participant), resolved
 * in `unreadMessageCounts`, so the agent, TC and admin shells can all use the
 * same endpoint without a per-role branch here.
 */
export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const rows = await unreadMessageCounts(userId);
    const byDeal: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      byDeal[row.deal_id] = row.unread;
      total += row.unread;
    }
    return json({ total, by_deal: byDeal });
  })) as Response;
}
