import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { hasDealAccess } from "@/lib/deals";
import { createOfferBodySchema } from "@/lib/schemas/offer";
import { parseBody } from "@/lib/schemas/parse";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    if (!(await hasDealAccess(dealId, userId))) return error("deal not found", 404);
    const offers = await prisma.offers.findMany({
      where: { deal_id: dealId },
      orderBy: { submitted_at: "desc" },
    });
    return json(offers);
  })) as Response;
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    const owned = await prisma.deals.findFirst({
      where: { id: dealId, agent_id: userId },
      select: { id: true },
    });
    if (!owned) return error("deal not found", 404);

    // Schema-validated (#88): a stringly offer_price / bad close_date /
    // non-array contingencies 400 here — they used to 500 inside Prisma.
    const parsed = await parseBody(req, createOfferBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // #410: the offer must name the house. A tracked property from ANOTHER
    // deal (or one that no longer exists) is a client bug, not a permission
    // problem — 400 rather than leak whether the row exists elsewhere.
    let property: { address: string; city: string; state: string } | null = null;
    if (body.tracked_property_id) {
      property = await prisma.tracked_properties.findFirst({
        where: { id: body.tracked_property_id, deal_id: dealId },
        select: { address: true, city: true, state: true },
      });
      if (!property) return error("tracked property not found on this deal", 400);
    }

    const offer = await prisma.offers.create({
      data: {
        deal_id: dealId,
        tracked_property_id: body.tracked_property_id ?? null,
        buyer_name: body.buyer_name ?? "",
        offer_price: body.offer_price ?? 0,
        close_date: body.close_date ? new Date(body.close_date) : null,
        contingencies: body.contingencies ?? [],
        agent_notes: body.agent_notes ?? "",
      },
    });

    // Push the property under offer onto the deal so the header, the client
    // portals and the pipeline/commission math have real numbers instead of
    // the intake placeholder (#410 → #411). Only when a property was named:
    // an unlinked offer must not clobber the deal's own address/price.
    if (property) {
      await prisma.deals.update({
        where: { id: dealId },
        data: {
          address: [property.address, property.city, property.state]
            .map((part) => part.trim())
            .filter(Boolean)
            .join(", "),
          price: offer.offer_price,
        },
      });
    }

    return json(offer, 201);
  })) as Response;
}
