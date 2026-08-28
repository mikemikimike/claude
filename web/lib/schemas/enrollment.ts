/**
 * Fast Pass / Smooth Exit enrollment request bodies (#88).
 *
 * These land in a JSONB column, so pre-#88 nothing rejected junk — a string
 * estimated_sale_price simply persisted as a string. The schemas type the
 * fields the server actually stores; the deliberately-ignored client totals
 * stay unknown (the server prices enrollments — #78/#81 — so their shape
 * never mattered and rejecting them would break older clients for no gain).
 *
 * Catalog membership (`unknown upsell: x`) and the fastpass payment-option
 * whitelist stay in the handlers — their exact 400 messages are asserted in
 * tests and load-bearing for the surveys.
 *
 * Client-safe: zod only.
 */
import { z } from "zod";

/** POST /api/deals/[id]/fastpass */
export const fastPassEnrollBodySchema = z.object({
  // now | at_closing | seller_concession — whitelist stays in the handler.
  //
  // Optional on purpose (#439): the onboarding survey no longer takes payment,
  // so it enrols with no option at all and the handler persists the enrollment
  // as `pending_payment`. Sending one is still valid — that is how the buyer's
  // dashboard (#440) pays — and a present-but-unrecognised value still 400s in
  // the handler.
  payment_option: z.string().nullish(),
  selected_upsells: z.array(z.string()).optional(),
  /** Optional promo code (#281); the server validates it + prices the discount. */
  promo_code: z.string().nullish(),
  /** Client-sent; deliberately ignored — the server prices the enrollment. */
  total_cents: z.unknown().optional(),
  /** Arbitrary JSON from the survey. */
  survey_answers: z.unknown().optional(),
});
export type FastPassEnrollBody = z.output<typeof fastPassEnrollBodySchema>;

/** POST /api/deals/[id]/smoothexit */
export const smoothExitEnrollBodySchema = z.object({
  // from_proceeds | buyer_concession — stored as-is (legacy Go parity).
  payment_option: z.string().nullish(),
  estimated_sale_price: z.number().nullish(),
  fee_cents: z.number().nullish(),
  /** Arbitrary JSON from the survey. */
  survey_answers: z.unknown().optional(),
  selected_upsells: z.array(z.string()).optional(),
  /** Client-sent; deliberately ignored — the server prices upsells. */
  upsell_total_cents: z.unknown().optional(),
});
export type SmoothExitEnrollBody = z.output<typeof smoothExitEnrollBodySchema>;

/**
 * POST /api/deals/[id]/fastpass/pay (#440) — the buyer settles an enrollment
 * that is already persisted and priced.
 *
 * Deliberately ONE field. Everything that decides the amount (the add-on
 * basket, any promo discount, the agreed total) is read from the stored
 * enrollment, and the payer's identity comes from the JWT — so there is nothing
 * else here a client could tamper with. In particular there is no
 * `customer_email`: Stripe's prefill is read server-side from `users.email`
 * (#413), never from the wire.
 */
export const fastPassPayBodySchema = z.object({
  // now | at_closing | seller_concession — the whitelist (and its 400 message)
  // stays in the handler, matching the enrollment route.
  payment_option: z.string().nullish(),
});
export type FastPassPayBody = z.output<typeof fastPassPayBodySchema>;
