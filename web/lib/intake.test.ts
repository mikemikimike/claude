/**
 * Issue #409 — cash buyers were dead-ended by the "pre-approval required to
 * make an offer" gate.
 *
 * Buyer onboarding has always captured the answer (`cashOrLoan: 'cash'`, and it
 * even skips the loan-only screens), but the answer only ever landed in the
 * free-form `deals.intake` JSON and nothing read it back out. The offer gate
 * ran purely off `deals.pre_approved`, which only an agent can set — so a cash
 * buyer saw "Pre-approval required to make an offer" on every property forever.
 *
 * These are the derivation helpers that carry the answer back onto the deal.
 * `deals.intake` is client-written free-form JSON, so the contract that matters
 * here is: anything that is not literally the buyer's `cash` / `loan` answer
 * derives to `null`. Never guess "cash" — guessing wrong unlocks the gate for a
 * financed buyer.
 */
import { describe, it, expect } from "vitest";
import {
  financingTypeFromAnswers,
  financingTypeFromIntake,
  lenderChoiceFromAnswers,
  needsPreApprovalTask,
  withFinancingType,
} from "./intake";

function buyerIntake(answers: Record<string, unknown>) {
  return { role: "buyer", submitted_at: "2026-08-27T12:00:00.000Z", answers };
}

describe("financingTypeFromAnswers (#409)", () => {
  it("reads the buyer questionnaire's cash answer", () => {
    expect(financingTypeFromAnswers("buyer", { cashOrLoan: "cash" })).toBe("cash");
  });

  it("reads the buyer questionnaire's loan answer", () => {
    expect(financingTypeFromAnswers("buyer", { cashOrLoan: "loan" })).toBe("loan");
  });

  it("is null when the buyer never answered", () => {
    expect(financingTypeFromAnswers("buyer", { bedrooms: "3" })).toBeNull();
    expect(financingTypeFromAnswers("buyer", { cashOrLoan: "" })).toBeNull();
  });

  it("is null for a seller intake — financing is a buy-side question", () => {
    expect(financingTypeFromAnswers("seller", { cashOrLoan: "cash" })).toBeNull();
  });

  it("never coerces a non-answer into a financing type", () => {
    for (const v of [true, 1, "CASH ", ["cash"], { value: "cash" }, null, undefined]) {
      expect(financingTypeFromAnswers("buyer", { cashOrLoan: v })).toBeNull();
    }
  });
});

describe("financingTypeFromIntake (#409)", () => {
  it("derives cash / loan from a stored buyer intake", () => {
    expect(financingTypeFromIntake(buyerIntake({ cashOrLoan: "cash" }))).toBe("cash");
    expect(financingTypeFromIntake(buyerIntake({ cashOrLoan: "loan" }))).toBe("loan");
  });

  it("is null for a deal with no intake yet", () => {
    expect(financingTypeFromIntake(null)).toBeNull();
    expect(financingTypeFromIntake(undefined)).toBeNull();
  });

  it("guards every level of the free-form JSON", () => {
    expect(financingTypeFromIntake("cash")).toBeNull();
    expect(financingTypeFromIntake(42)).toBeNull();
    expect(financingTypeFromIntake([{ role: "buyer", answers: { cashOrLoan: "cash" } }])).toBeNull();
    expect(financingTypeFromIntake({ answers: { cashOrLoan: "cash" } })).toBeNull(); // no role
    expect(financingTypeFromIntake({ role: "agent", answers: { cashOrLoan: "cash" } })).toBeNull();
    expect(financingTypeFromIntake({ role: "buyer" })).toBeNull(); // no answers
    expect(financingTypeFromIntake({ role: "buyer", answers: "cash" })).toBeNull();
    expect(financingTypeFromIntake({ role: "buyer", answers: ["cash"] })).toBeNull();
  });

  it("is null for a seller intake", () => {
    expect(
      financingTypeFromIntake({ role: "seller", answers: { cashOrLoan: "cash" } })
    ).toBeNull();
  });
});

describe("withFinancingType (#409)", () => {
  it("swaps the raw intake JSON for the derived flag", () => {
    const row = { id: "d1", title: "Betty Buyer", intake: buyerIntake({ cashOrLoan: "cash" }) };
    expect(withFinancingType(row)).toEqual({
      id: "d1",
      title: "Betty Buyer",
      financing_type: "cash",
    });
  });

  it("never leaks the questionnaire answers into an API payload", () => {
    const row = {
      id: "d1",
      intake: buyerIntake({ cashOrLoan: "loan", minBudget: 250000, areas: "Hoover" }),
    };
    const out = withFinancingType(row);
    expect(out).not.toHaveProperty("intake");
    expect(JSON.stringify(out)).not.toContain("minBudget");
  });

  it("reports null financing for a deal whose client hasn't onboarded", () => {
    expect(withFinancingType({ id: "d1", intake: null })).toEqual({
      id: "d1",
      financing_type: null,
    });
  });
});

/**
 * Issue #434 — a buyer who picks Mountain Mortgage (or Fast Pass, which is the
 * same lender wrapped in the concierge service) needs a pre-approval task on
 * their deal the moment they finish onboarding.
 *
 * The choice is already in the questionnaire as `lenderChoice`. These are the
 * derivation helpers that read it back out — same shape and same default
 * direction as the `cashOrLoan` pair above: anything unrecognized derives to
 * `null`, and `null` means "don't create the task". A spurious pre-approval
 * task is worse than a missing one, because a high-priority open task holds
 * the deal at Property Search.
 */
describe("lenderChoiceFromAnswers (#434)", () => {
  it("reads each of the three onboarding choices", () => {
    expect(lenderChoiceFromAnswers("buyer", { lenderChoice: "mountain" })).toBe("mountain");
    expect(lenderChoiceFromAnswers("buyer", { lenderChoice: "fastpass" })).toBe("fastpass");
    expect(lenderChoiceFromAnswers("buyer", { lenderChoice: "other" })).toBe("other");
  });

  it("is null when the buyer never reached the lender screen", () => {
    expect(lenderChoiceFromAnswers("buyer", { bedrooms: "3" })).toBeNull();
    expect(lenderChoiceFromAnswers("buyer", { lenderChoice: "" })).toBeNull();
  });

  it("is null for a seller intake — the pre-approval ask is buy-side", () => {
    expect(lenderChoiceFromAnswers("seller", { lenderChoice: "mountain" })).toBeNull();
  });

  it("never coerces a non-answer into a lender choice", () => {
    for (const v of [true, 1, "Mountain", " mountain", ["mountain"], { v: "mountain" }, null]) {
      expect(lenderChoiceFromAnswers("buyer", { lenderChoice: v })).toBeNull();
    }
  });
});

describe("needsPreApprovalTask (#434)", () => {
  it("is true for a financed buyer who picked Mountain Mortgage or Fast Pass", () => {
    expect(needsPreApprovalTask("buyer", { lenderChoice: "mountain", cashOrLoan: "loan" })).toBe(true);
    expect(needsPreApprovalTask("buyer", { lenderChoice: "fastpass", cashOrLoan: "loan" })).toBe(true);
  });

  it("is true when the buyer skipped the cash/loan question but picked the lender", () => {
    // `cashOrLoan` is screen 0 and gates the lender screen, so this pairing is
    // unlikely — but an unanswered financing question must not suppress a
    // lender choice the buyer explicitly made.
    expect(needsPreApprovalTask("buyer", { lenderChoice: "mountain" })).toBe(true);
  });

  it("is false for an outside lender", () => {
    expect(needsPreApprovalTask("buyer", { lenderChoice: "other", cashOrLoan: "loan" })).toBe(false);
  });

  it("is false for a cash buyer, whatever the lender answer says", () => {
    expect(needsPreApprovalTask("buyer", { cashOrLoan: "cash" })).toBe(false);
    // Contradictory answers (cash + a lender) resolve toward NOT creating the
    // task: a cash buyer has nothing to get pre-approved for.
    expect(needsPreApprovalTask("buyer", { lenderChoice: "mountain", cashOrLoan: "cash" })).toBe(false);
  });

  it("is false for a seller intake", () => {
    expect(needsPreApprovalTask("seller", { lenderChoice: "mountain" })).toBe(false);
  });

  it("is false for an empty questionnaire", () => {
    expect(needsPreApprovalTask("buyer", {})).toBe(false);
  });
});
