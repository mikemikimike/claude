import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { hasDealAccess } from "@/lib/deals";
import { createNotification } from "@/lib/notifications";
import { emailOfferRequested, recipientUrl } from "@/lib/notification-email";

type Ctx = { params: Promise<{ id: string; propId: string }> };

type PatchBody = {
  status?: string;
  thumbnail_url?: string;
  buyer_note?: string | null;
  agent_note?: string | null;
  agent_private_note?: string | null;
  offer_requested?: boolean;
};

/**
 * #168: property writes are open to the owning agent AND deal participants
 * (the buyer portal drives these), with field-level rules — participants may
 * set status / buyer_note / offer_requested; agent_note and agent_private_note
 * stay agent-only. Returns null when the caller has no access at all.
 */
async function resolveWriteAccess(
  dealId: string,
  userId: string
): Promise<{ isOwningAgent: boolean; agentId: string } | null> {
  if (!(await hasDealAccess(dealId, userId))) return null;
  const deal = await prisma.deals.findUnique({
    where: { id: dealId },
    select: { agent_id: true },
  });
  if (!deal) return null;
  return { isOwningAgent: deal.agent_id === userId, agentId: deal.agent_id };
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId, propId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await resolveWriteAccess(dealId, userId);
    if (!access) return error("deal not found", 404);

    let body: PatchBody;
    try {
      body = (await req.json()) as PatchBody;
    } catch {
      return error("invalid request body", 400);
    }
    if (
      !access.isOwningAgent &&
      (body.agent_note !== undefined || body.agent_private_note !== undefined)
    ) {
      return error("agent-only field", 403);
    }

    const data: PatchBody = {};
    if (typeof body.status === "string") data.status = body.status;
    if (typeof body.thumbnail_url === "string") data.thumbnail_url = body.thumbnail_url;
    if (body.buyer_note !== undefined) data.buyer_note = body.buyer_note;
    if (body.agent_note !== undefined) data.agent_note = body.agent_note;
    if (body.agent_private_note !== undefined)
      data.agent_private_note = body.agent_private_note;
    if (typeof body.offer_requested === "boolean")
      data.offer_requested = body.offer_requested;

    const existing = await prisma.tracked_properties.findFirst({
      where: { id: propId, deal_id: dealId },
      select: { offer_requested: true, address: true },
    });
    if (!existing) return error("not found", 404);

    if (Object.keys(data).length > 0) {
      await prisma.tracked_properties.updateMany({
        where: { id: propId, deal_id: dealId },
        data,
      });
    }

    // NOTE (#459): this route deliberately does NOT write `deals.price`.
    //
    // #411 backfilled it from the tracked listing's list price on the
    // false→true edge of `offer_requested`, to stop the dashboard reading
    // "$0". Paul settled the rule differently (2026-08-28): Pipeline Value
    // fills in at **under contract**, from the contract price, and nowhere
    // else. An offer *request* is not an offer and a list price is not a
    // contract price — and this PATCH is one the *buyer* is allowed to make,
    // so writing money here let a client browsing listings move a number on
    // their agent's dashboard. The pipeline gate now lives in
    // `lib/deal-money.ts` (`pipelinePrice` / `pipelineCommission`).

    // Agent notification on offer request (#168) — fires on the false→true
    // transition only, never to the actor. In-app insert swallows internally;
    // the email is best-effort and must never block the mutation.
    if (
      data.offer_requested === true &&
      !existing.offer_requested &&
      access.agentId !== userId
    ) {
      await createNotification({
        userId: access.agentId,
        title: "Offer request",
        body: `Your client wants to make an offer on ${existing.address}.`,
        kind: "offer_requested",
        dealId,
        // Deep-link the agent to the deal, not '#' (#291).
        href: recipientUrl("", "agent", access.agentId, dealId),
      });
      try {
        await emailOfferRequested({
          req,
          dealId,
          requesterId: userId,
          propertyAddress: existing.address,
        });
      } catch (err) {
        console.error("offer-request notification email failed", err);
      }
    }

    return json({ ok: true });
  })) as Response;
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId, propId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const access = await resolveWriteAccess(dealId, userId);
    if (!access) return error("deal not found", 404);

    const existing = await prisma.tracked_properties.findFirst({
      where: { id: propId, deal_id: dealId },
      select: { added_by: true },
    });
    // Idempotent: deleting an already-gone property succeeds (matches the
    // previous deleteMany behavior).
    if (!existing) return new Response(null, { status: 204 });

    // Participants may only remove their own additions — the agent's picks
    // stay unless the agent removes them ("mark not_for_me" is the buyer's
    // way to pass on an agent pick).
    if (!access.isOwningAgent && existing.added_by === "agent")
      return error("only your agent can remove their picks", 403);

    await prisma.tracked_properties.deleteMany({
      where: { id: propId, deal_id: dealId },
    });
    return new Response(null, { status: 204 });
  })) as Response;
}
