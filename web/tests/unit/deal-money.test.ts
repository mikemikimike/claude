/**
 * Money the app may genuinely not know yet (#411).
 *
 * Pipeline Value and Est. Commission read "$0" on every deal whose price
 * nobody typed by hand, because the client collapsed a null price to the
 * number 0. "$0" reads like a computed answer; missing data has to look
 * missing. These are the two primitives every dashboard needs — printing an
 * unknown amount, and adding a pile of amounts up where "unknown" is not zero.
 *
 * DB-free: pure functions only.
 */
import { describe, it, expect } from "vitest";
import { NO_AMOUNT, formatMoney, formatCompactMoney, sumKnown } from "@/lib/deal-money";

describe("formatMoney (#411)", () => {
  it("renders a known amount with thousands separators", () => {
    expect(formatMoney(475000)).toBe("$475,000");
  });

  it("renders null as the em-dash, not $0", () => {
    expect(formatMoney(null)).toBe(NO_AMOUNT);
    expect(formatMoney(undefined)).toBe(NO_AMOUNT);
    expect(NO_AMOUNT).not.toContain("0");
  });

  it("still renders a genuine zero as $0 — only absence is a dash", () => {
    expect(formatMoney(0)).toBe("$0");
  });
});

describe("formatCompactMoney (#411)", () => {
  it("abbreviates millions and thousands", () => {
    expect(formatCompactMoney(1_250_000)).toBe("$1.3M");
    expect(formatCompactMoney(1_250_000, 2)).toBe("$1.25M");
    expect(formatCompactMoney(475_000)).toBe("$475K");
    expect(formatCompactMoney(750)).toBe("$750");
  });

  it("renders null as the em-dash", () => {
    expect(formatCompactMoney(null)).toBe(NO_AMOUNT);
    expect(formatCompactMoney(undefined, 2)).toBe(NO_AMOUNT);
  });
});

describe("sumKnown (#411)", () => {
  it("adds the known values and ignores the unknown ones", () => {
    expect(sumKnown([475000, null, 300000])).toBe(775000);
  });

  it("is null when nothing is known — an all-unknown pipeline is not $0", () => {
    expect(sumKnown([null, undefined, null])).toBeNull();
    expect(sumKnown([])).toBeNull();
  });

  it("returns a number, never a concatenated string (#85 regression)", () => {
    const total = sumKnown([450000, 450000]);
    expect(typeof total).toBe("number");
    expect(total).toBe(900000);
  });

  it("keeps a real zero in the total rather than treating it as unknown", () => {
    expect(sumKnown([0, null])).toBe(0);
  });
});
