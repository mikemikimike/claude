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
      select: { offer_requested: true, address: true, price: true },
    });
    if (!existing) return error("not found", 404);

    if (Object.keys(data).length > 0) {
      await prisma.tracked_properties.updateMany({
        where: { id: propId, deal_id: dealId },
        data,
      });
    }

    // #411: give the pipeline a real number as soon as there is one.
    //
    // Pipeline Value and Est. Commission are `deals.price` × the commission
    // rate, and nothing in the normal flow filled `deals.price` in — so both
    // read "$0" on every deal. #410 stamps it from the offer amount once an
    // offer row exists; between "the buyer asked to offer on this house" and
    // "the agent advanced the stage with an amount", the tracked listing's
    // list price is the only real figure the system has.
    //
    // Deliberately a backfill, never a correction:
    //   - `price: null` in the WHERE means a figure the agent typed by hand,
    //     or a #410 offer amount, is never overwritten. Racing writers lose to
    //     whoever got there first rather than clobbering each other.
    //   - a 0 list price is "unknown", not "free" — writing it would put the
    //     "$0" this ticket is about back on the dashboard.
    //   - the false→true edge only, matching the notification below: a repeat
    //     PATCH of an already-set flag must not drag a corrected price back up.
    if (
      data.offer_requested === true &&
      !existing.offer_requested &&
      existing.price > 0
    ) {
      await prisma.deals.updateMany({
        where: { id: dealId, price: null },
        data: { price: existing.price },
      });
    }

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
