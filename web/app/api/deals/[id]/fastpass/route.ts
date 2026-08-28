import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { hasDealAccess } from "@/lib/deals";
import { resolveUserId } from "@/lib/users";
import {
  computeFastPassSubtotalCents,
  computeFastPassTotalCents,
  isFastPassUpsellId,
  type FastPassUpsellId,
} from "@/lib/fast-pass-catalog";
import { redeemPromoCode } from "@/lib/promo-codes";
import { createFastPassCheckout } from "@/lib/stripe";
import { fastPassEnrollBodySchema } from "@/lib/schemas/enrollment";
import { parseBody } from "@/lib/schemas/parse";

type Ctx = { params: Promise<{ id: string }> };

const PAYMENT_OPTIONS = ["now", "at_closing", "seller_concession"] as const;

// Product key the promo's `applies_to` must include for a Fast Pass enrollment.
const PROMO_PRODUCT = "fast_pass";

/** Thrown inside the enrollment transaction when a concurrent redemption
 * consumed the code's last use; rolls the whole enrollment back so `max_uses`
 * is never exceeded (#281 double-spend guard). */
class PromoExhaustedError extends Error {}

// POST /deals/:dealId/fastpass — owning agent or any deal participant (#169:
// buyers enroll their own deal from the portal pitch; the price is computed
// server-side, so opening the route to participants stays tamper-safe).
// Stores Fast Pass enrollment JSONB on the deal.
//
// `payment_option` is OPTIONAL (#439 / FF16). Onboarding's Fast Pass survey no
// longer asks for money, so it posts the add-on selection with no option at
// all: the enrollment is persisted `status: "pending_payment"`, `paid: false`,
// `payment_option: null`, and nothing is charged. The buyer picks how to pay
// from their dashboard afterwards (#440 / FF17), which posts the same route
// WITH an option — so the whitelisted `now | at_closing | seller_concession`
// path below is unchanged, including the Stripe Checkout hand-off on "now".
//
// Ports EnrollFastPass (backend/internal/handlers/enrollment.go), except the
// total is priced server-side from lib/fast-pass-catalog.ts (#78) instead of
// trusting the client's total_cents.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const deal = await prisma.deals.findFirst({
      where: { id: dealId },
      select: { agent_id: true, title: true },
    });
    if (!deal) return error("deal not found", 404);
    // Owner short-circuits; anyone else must be a deal participant (buyer,
    // seller, …) — hasDealAccess covers both, but the owner check avoids the
    // extra query on the common agent path.
    const isOwner = deal.agent_id === userId;
    if (!isOwner && !(await hasDealAccess(dealId, userId))) {
      return error("forbidden", 403);
    }

    // Schema-validated (#88): typed junk 400s here before any write.
    const parsed = await parseBody(req, fastPassEnrollBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    // Whitelist the payment option (now | at_closing | seller_concession);
    // only "now" charges upfront. Validated before any write.
    //
    // OMITTING it entirely (undefined / null) is the #439 deferred enrollment:
    // no option chosen yet, nothing charged, status "pending_payment". An
    // option that is PRESENT but not on the whitelist — including "" — is still
    // a hard 400, so a client that fumbles the field can't silently downgrade
    // itself into the deferred path.
    const paymentOption: (typeof PAYMENT_OPTIONS)[number] | null =
      body.payment_option == null ? null : (body.payment_option as (typeof PAYMENT_OPTIONS)[number]);
    if (
      paymentOption !== null &&
      !(PAYMENT_OPTIONS as readonly string[]).includes(paymentOption)
    ) {
      return error(`invalid payment_option: ${paymentOption}`, 400);
    }

    const selectedUpsells = body.selected_upsells ?? [];

    // Server-side pricing (#78): the total is computed from the shared catalog
    // (base fee + selected upsells, plus the +15% deferral premium when
    // payment_option === "at_closing" — #280) — body.total_cents is ignored, so
    // a tampered client can't set its own price. Unknown keys 400 before
    // anything is persisted; duplicate keys count once. (Deliberate divergence
    // from the Go handler, which trusted the client's total_cents.)
    const validatedUpsells: FastPassUpsellId[] = [];
    for (const key of new Set(selectedUpsells)) {
      if (!isFastPassUpsellId(key)) {
        return error(`unknown upsell: ${key}`, 400);
      }
      validatedUpsells.push(key);
    }
    const subtotalCents = computeFastPassSubtotalCents(validatedUpsells);

    // Optional promo code (#281): validated server-side against the catalog
    // subtotal (pre-premium). The client's discount_cents/total_cents are never
    // trusted — the server recomputes the discount from the stored code (mirrors
    // #78/#280 anti-tamper). An invalid code (unknown / expired / wrong product /
    // past max_uses) 400s BEFORE any write, matching the "validate before
    // persist" shape of the upsell check above, so the enrollment is untouched.
    const promoInput = (body.promo_code ?? "").trim();
    let appliedPromo:
      | { promoId: string; code: string; maxUses: number | null; discountCents: number }
      | null = null;
    if (promoInput) {
      const promo = await redeemPromoCode(promoInput, PROMO_PRODUCT, subtotalCents);
      if (!promo.ok) return error(promo.reason, 400);
      appliedPromo = {
        promoId: promo.promoId,
        code: promo.code,
        maxUses: promo.maxUses,
        discountCents: promo.discountCents,
      };
    }

    // Final charge, composed in the catalog (#281 + #280): discount the subtotal
    // first, THEN apply the at_closing +15% premium on the discounted basket —
    // so a discounted at_closing enrollment costs round((subtotal − discount) ×
    // 1.15). body.total_cents stays ignored.
    // A deferred (#439) enrollment passes no option, so it gets the plain
    // discounted subtotal — the +15% premium only ever attaches to an option
    // the buyer has actually chosen (at_closing), which FF17 collects later.
    const totalCents = computeFastPassTotalCents(validatedUpsells, paymentOption ?? undefined, {
      discountCents: appliedPromo?.discountCents ?? 0,
    });

    const enrollment = {
      // No payment option means the buyer has enrolled but not paid — the
      // status `fastpass/mark-paid` and FF17 both key off (#439).
      status: paymentOption === null ? "pending_payment" : "active",
      payment_option: paymentOption,
      // Dedupe what we store so the JSONB matches what was actually charged.
      selected_upsells: validatedUpsells,
      total_cents: totalCents,
      // Record the redeemed code + discount for audit (only when one applied).
      ...(appliedPromo
        ? { promo_code: appliedPromo.code, discount_cents: appliedPromo.discountCents }
        : {}),
      survey_answers: (body.survey_answers ?? null) as object | null,
      paid: false,
      enrolled_at: new Date().toISOString(),
    };

    // Persist the enrollment and the promo's uses_count++ in ONE transaction so
    // two concurrent redemptions can't both slip under max_uses (#281). The
    // increment is a conditional update (WHERE uses_count < max_uses); Postgres
    // re-checks that predicate against the row a concurrent writer just
    // committed, so if it touches 0 rows the code was exhausted mid-flight and
    // the whole enrollment rolls back to a clean 400 — no double-spend.
    try {
      await prisma.$transaction(async (tx) => {
        const promo = appliedPromo;
        if (promo) {
          const bumped = await tx.promo_codes.updateMany({
            where:
              promo.maxUses == null
                ? { id: promo.promoId }
                : { id: promo.promoId, uses_count: { lt: promo.maxUses } },
            data: { uses_count: { increment: 1 } },
          });
          if (bumped.count !== 1) throw new PromoExhaustedError();
        }
        await tx.deals.update({
          where: { id: dealId },
          data: { fast_pass: enrollment, updated_at: new Date() },
        });
      });
    } catch (err) {
      if (err instanceof PromoExhaustedError) {
        return error("promo code has reached its usage limit", 400);
      }
      throw err;
    }

    // Only "now" charges upfront. The enrollment is already persisted, so any
    // Stripe failure (including no key configured) falls back to a plain ok —
    // mirrors the Go handler's deferred path.
    if (paymentOption === "now") {
      const url = new URL(req.url);
      const origin = `${url.protocol}//${url.host}`;
      // Role-aware return URLs (#169): the owning agent lands back on the
      // deal page; a participant (buyer) returns to their own portal on
      // success, and to the survey's ?deal_id entry point on cancel so a
      // resubmit works (FastPassSurvey keeps its handoff for exactly this).
      const successUrl = isOwner
        ? `${origin}/agent/deals/${dealId}?fastpass=paid`
        : `${origin}/buyer/${userId}?fastpass=paid`;
      const cancelUrl = isOwner
        ? `${origin}/agent/deals/${dealId}`
        : `${origin}/fast-pass/survey?deal_id=${dealId}`;
      try {
        const session = await createFastPassCheckout({
          dealId,
          dealTitle: deal.title,
          amountCents: totalCents,
          successUrl,
          cancelUrl,
        });
        if (session.url) {
          return json({ ok: true, status: enrollment.status, checkout_url: session.url });
        }
      } catch (err) {
        console.error("stripe fast pass checkout error", err);
      }
    }

    // Echo the persisted status so a caller can tell a deferred enrollment
    // (#439) from an active one without re-fetching the deal.
    return json({ ok: true, status: enrollment.status });
  })) as Response;
}
