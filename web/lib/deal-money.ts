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
