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

/**
 * Undo the `payment_option: "now"` choice after Checkout could not be
 * created (#453).
 *
 * The enrollment is persisted BEFORE Stripe is called, so a failed hand-off
 * would otherwise leave a record claiming the buyer chose to pay now when they
 * were never shown a payment page. Clearing the option puts it back in exactly
 * the #439 shape FF16 produces — `pending_payment` with no option — so the
 * dashboard pay card (#440) offers the choice again and the buyer can retry.
 * The stored `total_cents` is already the un-premiumed figure a
 * `pending_payment` enrollment carries, so it stays.
 *
 * #463 note: `status` is now ALREADY `pending_payment` on this path (a pay-now
 * enrollment is no longer optimistically activated), so this only has to clear
 * the option — but it still writes the status explicitly, both as documentation
 * and so the record is normalised even if it somehow arrived here otherwise.
 *
 * Guarded on the exact shape this request just wrote, so it can never touch a
 * concurrently-updated or already-settled enrollment. Best-effort: the caller
 * is returning a 502 either way, and a failure here must not convert that into
 * an opaque 500 — but it IS logged, because it leaves a record needing a hand.
 */
async function leaveEnrollmentPayable(dealId: string): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE deals
      SET fast_pass = fast_pass || jsonb_build_object(
            'status', 'pending_payment',
            'payment_option', NULL::text
          ),
          updated_at = NOW()
      WHERE id = ${dealId}::uuid
        AND fast_pass IS NOT NULL
        AND fast_pass->>'status' = 'pending_payment'
        AND fast_pass->>'payment_option' = 'now'
        AND COALESCE((fast_pass->>'paid')::boolean, false) = false
    `;
  } catch (err) {
    console.error("fast pass: could not reset a failed pay-now enrollment", {
      dealId,
      err,
    });
  }
}

// POST /deals/:dealId/fastpass — owning agent or any deal participant (#169:
// buyers enroll their own deal from the portal pitch; the price is computed
// server-side, so opening the route to participants stays tamper-safe).
// Stores Fast Pass enrollment JSONB on the deal.
//
// `payment_option` is OPTIONAL (#439 / FF16). Onboarding's Fast Pass survey no
// longer asks for money, so it posts the add-on selection with no option at
// all: the enrollment is persisted `status: "pending_payment"`, `paid: false`,
// `payment_option: null`, and nothing is charged. The buyer picks how to pay
// from their dashboard afterwards via POST /fastpass/pay (#440 / FF17).
//
// The whitelisted `now | at_closing | seller_concession` path below is kept for
// direct API callers, but "now" no longer swallows a Stripe failure (#453): it
// 502s and leaves the enrollment `pending_payment` so /fastpass/pay can settle
// it. Nothing in the UI posts an option to THIS route any more.
//
// #463 (FF23) brought the "now" branch the rest of the way onto /fastpass/pay's
// contract. A SUCCESSFUL "now" now stays `pending_payment` and records the
// Checkout session id; only Stripe's webhook may mark it paid and promote it to
// `active`. Before, reaching Checkout was enough to persist `active`, so a
// buyer who closed the tab left an `active`, unpaid enrollment — and with no
// session id stored, the #282 double-session guard in /fastpass/pay could not
// see a session this route had minted.
//
// RECOMMENDATION (out of scope for #463, deliberately not done here): the two
// routes now agree on everything that matters, so this "now" branch is pure
// duplication of /fastpass/pay and should eventually be deleted, leaving this
// route to do only what the app uses it for — enroll, price, never charge.
// The blocker is test coverage, not behaviour: several cases in
// tests/api/fastpass-enroll.test.ts reach Stripe only through here, including
// the ONLY assertion that a #281 promo discount reaches the Stripe line item
// (promo redemption lives on this route, not on /pay). Re-home those first.
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
      // What "active" is allowed to mean (#463):
      //
      //   null (#439)       → enrolled, nothing chosen, nothing charged.
      //   now               → a card charge is about to be attempted. The money
      //                       has NOT arrived, so this stays `pending_payment`
      //                       until Stripe's webhook says otherwise — exactly
      //                       what /fastpass/pay does. Persisting `active` here
      //                       meant a buyer who reached Checkout and closed the
      //                       tab left an `active`, unpaid enrollment behind.
      //   at_closing /
      //   seller_concession → deferred by design: no money moves now and none
      //                       is expected to, so `active` is honest, and the
      //                       separate `paid` flag stays false until it lands.
      //
      // Only the webhook (or the admin override in `fastpass/mark-paid`) may
      // promote a `pending_payment` enrollment.
      status:
        paymentOption === null || paymentOption === "now"
          ? "pending_payment"
          : "active",
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

    // Only "now" charges upfront. Nothing in the app posts it here any more
    // (#439 took payment out of the survey, #440 moved it to /fastpass/pay), so
    // this is a direct-API path only — but it still has to be honest: a Stripe
    // failure is a 502 and the enrollment is left retryable, never a success
    // for a payment that did not happen (#412 / #453).
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
      // #413: prefill Checkout with the payer's own address, read here from the
      // DB for the authenticated caller (agent or buyer — whoever submitted
      // this enrollment) rather than accepted from the request body, which
      // would let a caller point the receipt at an address they don't own.
      const payer = await prisma.users.findUnique({
        where: { id: userId },
        select: { email: true },
      });

      // #453 (FF20): BOTH failure shapes are hard errors. This used to catch
      // the throw, log it, and fall through to `{ ok: true }` — success
      // reported for a payment that never happened (#412), which the caller
      // rendered as a paid-and-done screen. `/fastpass/pay` (#440) is the
      // reference behaviour and this now matches it.
      let session: { id: string; url: string | null };
      try {
        session = await createFastPassCheckout({
          dealId,
          dealTitle: deal.title,
          amountCents: totalCents,
          successUrl,
          cancelUrl,
          customerEmail: payer?.email ?? undefined,
        });
      } catch (err) {
        console.error("stripe fast pass checkout error", { dealId, err });
        await leaveEnrollmentPayable(dealId);
        return error("could not start checkout — please try again", 502);
      }
      if (!session.url) {
        console.error("stripe fast pass checkout returned no url", {
          dealId,
          sessionId: session.id,
        });
        await leaveEnrollmentPayable(dealId);
        return error("could not start checkout — please try again", 502);
      }

      // #463: record the session that was just minted. Without this the #282
      // double-session guard in /fastpass/pay is blind to a session THIS route
      // created, and a buyer with the enrollment still open could be handed a
      // second, independently-payable Checkout for the same $1,787+ charge.
      // (That was previously masked only by the `active` status this route used
      // to write — which is the other half of #463, hence one ticket.)
      //
      // A merge (`||`), not a whole-row rewrite, so it can't clobber a sibling
      // key. Guarded on `pending_payment` so a webhook that landed while
      // Checkout was being created is never rewound to unpaid — the same guard
      // /fastpass/pay uses. Deliberately NOT written before the Stripe call:
      // storing an id for a session that failed to exist would make the guard
      // 409 on a retrieve that can only fail.
      await prisma.$executeRaw`
        UPDATE deals
        SET fast_pass = fast_pass || jsonb_build_object(
              'checkout_session_id', ${session.id}::text
            ),
            updated_at = NOW()
        WHERE id = ${dealId}::uuid
          AND fast_pass IS NOT NULL
          AND fast_pass->>'status' = 'pending_payment'
      `;

      // `enrollment.status` is `pending_payment` on this branch (#463) — the
      // buyer is being sent to Checkout, not confirmed as having paid.
      return json({ ok: true, status: enrollment.status, checkout_url: session.url });
    }

    // Echo the persisted status so a caller can tell a deferred enrollment
    // (#439) from an active one without re-fetching the deal.
    return json({ ok: true, status: enrollment.status });
  })) as Response;
}
