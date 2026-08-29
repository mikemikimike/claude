import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  createCheckoutSession,
  retrieveCheckoutSession,
  type CheckoutSessionSnapshot,
} from "@/lib/stripe";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const deal = await prisma.deals.findUnique({
      where: { id: dealId },
      select: {
        agent_id: true,
        fee_status: true,
        fee_checkout_session_id: true,
        title: true,
      },
    });
    if (!deal) return error("deal not found", 404);
    if (deal.agent_id !== userId) return error("forbidden", 403);
    if (deal.fee_status === "paid" || deal.fee_status === "waived") {
      return error("fee already settled", 409);
    }

    // Guard against minting a SECOND payable Stripe session while one is still
    // live (#282). fee_status === "pending" means we already minted a session
    // and stored its id. Re-check that session's live status with Stripe: an
    // "open" session is still payable, so reuse it instead of minting another;
    // only a genuinely "expired" session may be replaced with a fresh one. Any
    // other outcome (a completed session whose webhook hasn't landed yet, or a
    // status we can't read) must NOT mint — that is exactly the double-charge
    // window this guards against.
    if (deal.fee_status === "pending" && deal.fee_checkout_session_id) {
      let existing: CheckoutSessionSnapshot;
      try {
        existing = await retrieveCheckoutSession(deal.fee_checkout_session_id);
      } catch (err) {
        console.error("fee checkout: could not verify pending session", err);
        return error("fee checkout already in progress; please retry", 409);
      }
      if (existing.status !== "expired") {
        // Still open → hand back the same session's URL so a re-click/second
        // tab lands on the one live checkout. Completed/no-URL → 409, never a
        // second session.
        if (existing.url) {
          return json({ checkout_url: existing.url });
        }
        return error("fee checkout already in progress", 409);
      }
      // expired → fall through and mint a fresh, retryable session below.
    }

    // #413: prefill Checkout with the payer's own address so they don't retype
    // it and the receipt reaches the RealTourFlow account. This route is
    // agent-only (the 403 above), so the payer is always the owning agent — and
    // the address is read here from the DB, never taken from the request.
    const payer = await prisma.users.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const session = await createCheckoutSession({
      dealId,
      dealTitle: deal.title,
      successUrl: `${origin}/agent/deals/${dealId}?fee=paid`,
      cancelUrl: `${origin}/agent/deals/${dealId}?fee=cancelled`,
      customerEmail: payer?.email ?? undefined,
    });

    await prisma.deals.update({
      where: { id: dealId },
      data: { fee_status: "pending", fee_checkout_session_id: session.id },
    });
    return json({ checkout_url: session.url });
  })) as Response;
}
