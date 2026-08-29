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
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  financingTypeFromAnswers,
  lenderChoiceFromAnswers,
  needsPreApprovalTask,
  normalizeFinancingType,
  withFinancingType,
} from "./intake";
import { PRE_APPROVAL_TASK_SOURCE, PRE_APPROVAL_TASK_TITLE } from "./stage-task-seed";

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

/**
 * Issue #451 — the derivation above is now the WRITE path only. The read path
 * is the `deals.financing_type` column (migration 000066), which is why
 * `financingTypeFromIntake` is gone: nothing reads the questionnaire key back
 * out at request time any more, so renaming `cashOrLoan` can no longer
 * silently re-gate every existing cash buyer.
 */
describe("normalizeFinancingType (#451)", () => {
  it("passes the two values the column is constrained to", () => {
    expect(normalizeFinancingType("cash")).toBe("cash");
    expect(normalizeFinancingType("loan")).toBe("loan");
  });

  // Case 6 — the #409 fail-closed guard, moved onto the column. Only an
  // explicit 'cash' lifts the pre-approval offer gate; anything else keeps it.
  it("fails closed on anything else", () => {
    for (const v of [null, undefined, "", "CASH", "cash ", "financed", 0, 1, true, ["cash"], { financing_type: "cash" }]) {
      expect(normalizeFinancingType(v)).toBeNull();
    }
  });
});

describe("withFinancingType (#451)", () => {
  it("normalizes the column onto the payload", () => {
    expect(withFinancingType({ id: "d1", title: "Betty Buyer", financing_type: "cash" })).toEqual({
      id: "d1",
      title: "Betty Buyer",
      financing_type: "cash",
    });
  });

  it("keeps a deal whose buyer never answered at null", () => {
    expect(withFinancingType({ id: "d1", financing_type: null })).toEqual({
      id: "d1",
      financing_type: null,
    });
  });

  it("fails closed if the column somehow holds something else", () => {
    // The CHECK constraint makes this unreachable through the app, but the
    // mapper is the last line before the offer gate — it must not pass through
    // a value it doesn't recognize.
    expect(withFinancingType({ id: "d1", financing_type: "CASH" }).financing_type).toBeNull();
  });

  /**
   * Case 2 — the failure mode #409 shipped with, made impossible.
   *
   * The old mapper took `{ intake?: unknown }`: a deal SELECT that forgot the
   * column compiled fine and quietly produced `financing_type: null`, silently
   * putting the pre-approval gate back in front of every cash buyer. The
   * property is required now (a row without it is a TYPE error — see the
   * @ts-expect-error below), and a missing key throws rather than deriving a
   * null nobody would notice.
   */
  it("throws instead of silently reporting null when the SELECT forgot the column", () => {
    // @ts-expect-error — a row without `financing_type` must not typecheck.
    expect(() => withFinancingType({ id: "d1", title: "Betty Buyer" })).toThrow(
      /financing_type/
    );
  });

  it("never carries the questionnaire answers — they aren't in the row at all", () => {
    const out = withFinancingType({ id: "d1", financing_type: "loan" });
    expect(out).not.toHaveProperty("intake");
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

/**
 * Issue #460 — the pre-approval task's copy must not be load-bearing.
 *
 * #434 used the task's user-facing title as its idempotency key AND as a
 * hardcoded exception inside `seedStageAutoTasks`'s NOT EXISTS guard, so one
 * English sentence was doing structural work in two places. #435 renders this
 * task to the buyer and is the obvious place someone improves the wording;
 * doing that would have orphaned every existing row and created a duplicate
 * beside it on every already-onboarded deal.
 *
 * The behavioural proof lives in tests/api/me-intake.test.ts (cases 24-27,
 * against a real database). This is the structural half, and it is a source
 * check on purpose: the failure mode being guarded is a future edit quietly
 * reintroducing a title predicate, which the behavioural tests only catch if
 * whoever writes it also remembers to rename a task in them.
 */
describe("stage-task-seed keys on source, not copy (#460)", () => {
  // Read per test, not once at describe scope: collection-time I/O would make a
  // watch-mode edit to stage-task-seed.ts invisible until vitest restarts, and
  // a read that throws during collection reports as an unhelpful file-level
  // failure rather than a failing assertion.
  const readSource = () =>
    readFileSync(new URL("./stage-task-seed.ts", import.meta.url), "utf8");

  /** The text of `seedStageAutoTasks`, up to the next exported function. */
  function stageSeederSource(): string {
    const src = readSource();
    const start = src.indexOf("export async function seedStageAutoTasks");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("export async function", start + 1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  }

  it("the stage seeder never mentions the pre-approval title", () => {
    const body = stageSeederSource();
    expect(body).not.toContain("PRE_APPROVAL_TASK_TITLE");
    expect(body).not.toContain(PRE_APPROVAL_TASK_TITLE);
  });

  it("the stage seeder's SQL has no `title <>` / `title !=` predicate", () => {
    expect(stageSeederSource()).not.toMatch(/title\s*(<>|!=)/);
  });

  it("the pre-approval seeder's guard matches on source, not on title", () => {
    const src = readSource();
    const start = src.indexOf("export async function seedPreApprovalTask");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    expect(body).toMatch(/t\.source\s*=\s*\$\{PRE_APPROVAL_TASK_SOURCE\}/);
    expect(body).not.toMatch(/t\.title\s*=/);
  });

  it("uses a source value that is neither 'ai' nor too wide for varchar(20)", () => {
    expect(PRE_APPROVAL_TASK_SOURCE).not.toBe("ai");
    expect(PRE_APPROVAL_TASK_SOURCE).not.toBe("manual");
    expect(PRE_APPROVAL_TASK_SOURCE.length).toBeGreaterThan(0);
    expect(PRE_APPROVAL_TASK_SOURCE.length).toBeLessThanOrEqual(20);
  });
});
