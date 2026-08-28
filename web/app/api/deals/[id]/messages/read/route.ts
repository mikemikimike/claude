import { error, json, withAuth } from "@/lib/http";
import { resolveUserId } from "@/lib/users";
import { hasRole } from "@/lib/roles";
import { getMessageAccess, markThreadRead, type MessageChannel } from "@/lib/messages";

type Ctx = { params: Promise<{ id: string }> };

type ReadBody = { channel?: string };

/**
 * POST /api/deals/:id/messages/read — moves the caller's read watermark on one
 * thread to now (#424). Clears that deal's contribution to the Messages badge.
 *
 * Access mirrors GET /api/deals/:id/messages exactly, so nobody can learn
 * whether a deal exists (404) or write a watermark row for a deal they can't
 * read. The internal thread stays agent + linked-TC + admin only (#177/#178).
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const access = await getMessageAccess(dealId, userId);
    const privilegedReader =
      hasRole(claims.roles, ["admin"]) ||
      (hasRole(claims.roles, ["tc"]) && access.isLinkedTC);
    if (!access.hasAccess && !privilegedReader) {
      return error("deal not found", 404);
    }

    let body: ReadBody = {};
    try {
      body = (await req.json()) as ReadBody;
    } catch {
      // An empty body is fine — default to the client thread.
    }
    const channel: MessageChannel =
      body.channel === "internal" ? "internal" : "client_thread";

    if (channel === "internal" && !access.isAgent && !privilegedReader) {
      return error("forbidden", 403);
    }

    await markThreadRead(userId, dealId, channel);
    return json({ deal_id: dealId, channel });
  })) as Response;
}
