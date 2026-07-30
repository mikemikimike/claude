/**
 * Fast Pass catalog — the server's source of truth for enrollment pricing
 * (#78). Mirrors lib/smooth-exit-catalog.ts.
 *
 * POST /deals/[id]/fastpass computes the Stripe charge from this table and
 * ignores any client-supplied total_cents, so a tampered request can't enroll
 * for a penny. This is a deliberate divergence from the Go EnrollFastPass
 * (backend/internal/handlers/enrollment.go), which trusted the client's
 * total_cents.
 *
 * Unlike Smooth Exit (where only the add-ons go through Stripe), the Fast Pass
 * charge is the base fee PLUS any selected upsells — matching what the Go
 * handler billed and what the UI shows. The UI list in lib/fast-pass-display.ts
 * derives its displayed dollar prices from these cents, so what the user sees
 * is what the server charges.
 */
/**
 * $1,787 — the advertised price. The server previously charged $2,977 while
 * marketing quoted $1,787, so every buyer who enrolled was billed ~$1,190 over
 * the number they were sold on (flagged in the 2026-07 audit as three
 * conflicting Fast Pass prices). Confirmed with Paul 2026-07-30: $1,787 is the
 * real one, and this constant is what Stripe charges.
 *
 * Enrollment stores its computed total on the deal, so changing this only
 * affects NEW enrollments — anyone already enrolled keeps their agreed amount.
 */
export const FAST_PASS_BASE_PRICE_CENTS = 178700;

/**
 * "Pay at closing" defers the Fast Pass charge to the closing table, and buyers
 * pay a 15% premium for that convenience. The premium is a property of the
 * payment *timing*, not the products, so it multiplies the whole basket
 * (base + upsells) exactly once — never the upsells on their own. Only the
 * `at_closing` option carries it (the survey shows a `+15%` badge on that
 * option and no other); `now` and `seller_concession` are unmarked.
 */
export const AT_CLOSING_PREMIUM = 1.15;

export const FAST_PASS_UPSELL_PRICE_CENTS = {
  utility_setup: 9700,
  refi_monitoring: 14700,
  home_warranty: 9700,
  deep_clean: 19700,
  inspection_followup: 14700,
  address_change: 9700,
  storage_research: 9700,
  new_construction: 14700,
  staging_consult: 24700,
  moving_coordination: 19700,
} as const;

export type FastPassUpsellId = keyof typeof FAST_PASS_UPSELL_PRICE_CENTS;

// hasOwnProperty (not `in`) so prototype keys like "toString" don't pass.
export function isFastPassUpsellId(key: string): key is FastPassUpsellId {
  return Object.prototype.hasOwnProperty.call(FAST_PASS_UPSELL_PRICE_CENTS, key);
}

/**
 * Server-side SUBTOTAL for a Fast Pass enrollment: base fee + the selected
 * upsells, before any promo discount or payment-timing premium. Duplicate keys
 * count once (pass a deduped set or rely on this to collapse them). Callers must
 * validate each key with isFastPassUpsellId first — unknown keys here would be
 * silently skipped.
 */
export function computeFastPassSubtotalCents(upsells: Iterable<FastPassUpsellId>): number {
  let subtotal = FAST_PASS_BASE_PRICE_CENTS;
  for (const key of new Set(upsells)) {
    subtotal += FAST_PASS_UPSELL_PRICE_CENTS[key];
  }
  return subtotal;
}

/**
 * Server-side TOTAL for a Fast Pass enrollment: base fee + selected upsells,
 * then (a) any promo discount and (b) the deferral premium if the buyer pays at
 * closing. The single entry point the route charges from — the client never
 * supplies a total or a discount.
 *
 * Order of operations (documented choice, #281 composed with #280):
 *   1. subtotal = base fee + selected upsells       (computeFastPassSubtotalCents)
 *   2. subtract the promo discount, clamped to ≥ 0   (opts.discountCents)
 *   3. apply the at_closing payment-timing premium   (#280, AT_CLOSING_PREMIUM)
 *
 * The promo discounts the SUBTOTAL and the premium then multiplies the ALREADY
 * DISCOUNTED basket — the buyer's discount is on the goods, and the deferral
 * premium is charged on what they actually defer. So a discounted at_closing
 * enrollment costs `round((subtotal − discount) × 1.15)`.
 *
 * `paymentOption` is the whitelisted enrollment option (`now` | `at_closing` |
 * `seller_concession`); only `at_closing` adds AT_CLOSING_PREMIUM, applied once.
 * Typed as `string` because the route validates the whitelist before calling —
 * this stays the single source of the markup so the survey never re-derives it
 * (#280). Passing no `discountCents` returns #280's plain (undiscounted)
 * behavior, so pre-#281 callers — the route's un-promo'd path and the survey
 * preview — are unaffected.
 */
export function computeFastPassTotalCents(
  upsells: Iterable<FastPassUpsellId>,
  paymentOption?: string,
  opts: { discountCents?: number } = {}
): number {
  const subtotal = computeFastPassSubtotalCents(upsells);
  const discount = Math.max(0, Math.min(opts.discountCents ?? 0, subtotal));
  let total = subtotal - discount;
  if (paymentOption === "at_closing") {
    total = Math.round(total * AT_CLOSING_PREMIUM);
  }
  return total;
}
