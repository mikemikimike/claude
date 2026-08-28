/**
 * Money the app may genuinely not know yet (#411).
 *
 * `deals.price` is nullable and, for most of a deal's life, null — nothing
 * filled it in until #410 started stamping it from the offer amount. The
 * client collapsed that null to the number 0 ("the client's TBD sentinel"), so
 * Pipeline Value and Est. Commission rendered "$0" on every unpriced deal.
 * "$0" reads like a computed answer; missing data has to look missing.
 *
 * Prices and commissions are therefore `number | null` from the wire adapter
 * all the way to the render, and this module owns the two things every
 * consumer needs: how to print an amount that might be absent, and how to add
 * a pile of them up without letting the absent ones count as zero.
 */

import type { DealStage } from "./stages";

/** What an amount the app doesn't know renders as. */
export const NO_AMOUNT = "—";

/** `$475,000`, or the em-dash when there is no amount. */
export function formatMoney(n: number | null | undefined): string {
  if (n == null) return NO_AMOUNT;
  return `$${n.toLocaleString()}`;
}

/**
 * Stat-card form: `$1.3M` / `$475K` / `$750`, or the em-dash when there is no
 * amount. `millionsDigits` matches each dashboard's existing precision (the
 * agent dashboard has always shown two, the admin one).
 */
export function formatCompactMoney(
  n: number | null | undefined,
  millionsDigits = 1,
): string {
  if (n == null) return NO_AMOUNT;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(millionsDigits)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

/**
 * Total the values that are known. Returns `null` when NOTHING is known — a
 * pipeline of three unpriced deals is "we don't know", not "$0" — and
 * otherwise the sum of the values that exist. A real 0 is a known value and
 * counts.
 *
 * Always returns a number (never a concatenated string): the reduce this
 * replaces is the one that string-concatenated `"0450000.00"` in #85.
 */
export function sumKnown(values: (number | null | undefined)[]): number | null {
  let total = 0;
  let sawOne = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    sawOne = true;
  }
  return sawOne ? total : null;
}

// ─── What counts as pipeline (#459) ─────────────────────────────────────────
//
// Paul, 2026-08-28: "Pipeline only fills in when the client goes under
// contract, then it takes the commission % based on the contract price. Keep
// it simple."
//
// Three things write `deals.price`: the agent typing it in the Edit Deal
// modal, #410 stamping the offer amount when a deal advances to Offer Active,
// and — until this ticket — a backfill from the tracked listing's list price
// when the *buyer* tapped "Make an Offer". The last one is gone: a client
// browsing listings must not move a number on their agent's dashboard.
//
// #410's capture stays exactly where it is. What moved is the point at which
// the captured amount COUNTS: an offer at Offer Active can still be rejected,
// so it is not pipeline until it is accepted — and on acceptance that accepted
// amount is the contract price, carried into `under_contract` unchanged (the
// stage PATCH never touches `deals.price`).

/**
 * The stages at which a deal is under contract or beyond — the only deals that
 * contribute to Pipeline Value and Est. Commission.
 */
export const PIPELINE_STAGES = [
  "under_contract",
  "pre_close",
  "closing",
  "post_close",
] as const satisfies readonly DealStage[];

/** Is this deal under contract or beyond? */
export function countsTowardPipeline(stage: DealStage | string): boolean {
  return (PIPELINE_STAGES as readonly string[]).includes(stage);
}

/** The shape both rollups need — a `Deal`, structurally. */
type PricedDeal = {
  stage: DealStage | string;
  property: { price: number | null };
  estimatedCommission: number | null;
};

/**
 * This deal's contribution to Pipeline Value: its contract price once the deal
 * is under contract, and `null` — "we don't know", rendered "—" — before that,
 * or when no price was ever captured. Never 0: see the module header.
 *
 * `deal.property.price` itself is left alone, so an Offer Active deal still
 * *shows* its offer amount on the deal card and in the client portals. Only
 * the rollups ask this question.
 */
export function pipelinePrice(deal: PricedDeal): number | null {
  return countsTowardPipeline(deal.stage) ? deal.property.price : null;
}

/**
 * This deal's contribution to Est. Commission — its `estimatedCommission`
 * (contract price × `commission_pct`, computed in `apiDealToFrontend`) over
 * the same set of deals `pipelinePrice` counts, so the two cards can never
 * disagree about which deals they are describing.
 *
 * KNOWN LIMITATION (#459, deliberate): commission is modelled as a percentage
 * only. An agent paid a FLAT FEE will see a wrong number here — Paul chose to
 * keep v1 simple rather than carry a `commission_type` (percent | flat). This
 * is a recorded decision, not an oversight; the fix is a real field, not a
 * special case bolted on here.
 */
export function pipelineCommission(deal: PricedDeal): number | null {
  return countsTowardPipeline(deal.stage) ? deal.estimatedCommission : null;
}
