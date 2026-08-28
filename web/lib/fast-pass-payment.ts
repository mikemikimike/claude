/**
 * Fast Pass — applying a payment option to an ALREADY-PERSISTED enrollment
 * (#440 / FF17).
 *
 * FF16 (#439) split enrolling from paying: the onboarding survey saves the
 * add-on basket with `status: 'pending_payment'` and no `payment_option`, and
 * the buyer chooses how to pay later, from their dashboard. That created a new
 * question the enrollment path never had to answer — *given a total we already
 * agreed to, what does each payment option cost?*
 *
 * This module is the one answer, shared by both sides of that question:
 *   - `POST /api/deals/[id]/fastpass/pay` prices the Stripe charge from it, and
 *   - the buyer portal's payment card renders its figures from it,
 * so the number on screen is always the number Stripe charges. (Showing a
 * figure derived from somewhere other than the persisted enrollment is exactly
 * the class of bug FF16's self-review flagged on the survey's success screen.)
 *
 * It owns NO pricing arithmetic of its own. `computeFastPassTotalCents()` in
 * lib/fast-pass-catalog.ts stays the single home of the +15% deferral premium
 * (#280) and of the discount-then-premium ordering (#281) — see below for how
 * the agreed total is fed back through it.
 *
 * Client-safe: pure functions over the catalog, no server imports.
 */
import {
  computeFastPassSubtotalCents,
  computeFastPassTotalCents,
  type FastPassUpsellId,
} from "@/lib/fast-pass-catalog";

/**
 * The three ways a buyer can settle a Fast Pass enrollment. Same whitelist the
 * enrollment route validates; only `at_closing` carries the deferral premium.
 */
export const FAST_PASS_PAYMENT_OPTIONS = [
  "now",
  "at_closing",
  "seller_concession",
] as const;

export type FastPassPaymentOptionId = (typeof FAST_PASS_PAYMENT_OPTIONS)[number];

export function isFastPassPaymentOption(
  value: unknown
): value is FastPassPaymentOptionId {
  return (
    typeof value === "string" &&
    (FAST_PASS_PAYMENT_OPTIONS as readonly string[]).includes(value)
  );
}

/**
 * What a given payment option costs for an enrollment that is ALREADY priced.
 *
 * `enrolledTotalCents` is `deals.fast_pass.total_cents` — the server-computed,
 * already-discounted basket stored when the buyer enrolled. That is the number
 * they agreed to, so it is the number we build on rather than re-pricing the
 * catalog from scratch (a mid-flight reprice must not quietly change the bill
 * on someone who has already enrolled).
 *
 * The premium itself is NOT applied here. Instead the agreed total is expressed
 * as a discount off the current catalog subtotal and handed to
 * `computeFastPassTotalCents()`, which remains the only code that knows the
 * multiplier and the order of operations. `now` and `seller_concession` come
 * back unchanged; `at_closing` comes back as `round(agreed × 1.15)`.
 *
 * Edge case, deliberate: `computeFastPassTotalCents` clamps a discount to
 * `[0, subtotal]`. So if the catalog has since been repriced *below* the agreed
 * total, the clamp hands back the cheaper catalog price — this can only ever
 * charge the buyer LESS than they agreed to, never more.
 */
export function fastPassTotalForPaymentOption(
  enrolledTotalCents: number,
  selectedUpsells: readonly FastPassUpsellId[],
  paymentOption: FastPassPaymentOptionId
): number {
  const subtotalCents = computeFastPassSubtotalCents(selectedUpsells);
  return computeFastPassTotalCents(selectedUpsells, paymentOption, {
    discountCents: subtotalCents - enrolledTotalCents,
  });
}
