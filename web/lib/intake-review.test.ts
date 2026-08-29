/**
 * Issue #427 — a client answered ~20 questions, submitted blind, and never saw
 * the answers again.
 *
 * These are the row builders behind the review screen. The two contracts worth
 * pinning here, because getting either wrong is user-visible and silent:
 *
 *   - a question the wizard SKIPPED must not appear (showing a cash buyer an
 *     empty "Credit score" row invites them to answer something the product
 *     deliberately never asked), and
 *   - a question the wizard ASKED must appear even when it was left blank —
 *     dropping it would make the one question they skipped the one question
 *     they cannot go back and fill in.
 *
 * Skip logic is NOT re-derived here: `buildBuyerReview` takes the wizard's own
 * `isCash`, and `buildSellerReview` takes its `getVisibleScreens()` output. The
 * tests below feed those the same way the components do.
 */
import { describe, it, expect } from "vitest";
import {
  BUYER_REVIEW_FIELDS,
  CASH_SKIP,
  UNANSWERED,
  buildBuyerReview,
  buildSellerReview,
  type IntakeReviewRow,
} from "./intake-review";

const LOAN_BUYER = {
  cashOrLoan: "loan",
  firstTimeBuyer: "yes",
  bedrooms: "3",
  bathrooms: "2",
  areas: "Hoover, Vestavia Hills",
  propertyType: "Single Family",
  garage: "Either works",
  pool: "Nice to have",
  schools: "Vestavia Hills City Schools",
  basement: "Not important",
  notes: "Needs a big yard",
  military: "no",
  employment: "W-2 Employee",
  journeyStage: "Actively searching now",
  creditScore: "Good (720+)",
  monthlyIncome: "8000",
  minBudget: 250_000,
  maxBudget: 425_000,
  lenderChoice: "mountain",
  trackingAddress: "123 Main St",
  contactName: "Alex Chen",
  contactPhone: "(205) 555-0100",
  contactEmail: "alex@example.com",
};

function rowFor(rows: IntakeReviewRow[], key: string): IntakeReviewRow | undefined {
  return rows.find((r) => r.key === key);
}

describe("buildBuyerReview — every question they answered (#427)", () => {
  it("lists the answers in the order they were asked", () => {
    const rows = buildBuyerReview(LOAN_BUYER, false);
    const keys = rows.map((r) => r.key);
    // cash/loan first, contact details last — the wizard's own running order.
    expect(keys[0]).toBe("cashOrLoan");
    expect(keys[keys.length - 1]).toBe("contactEmail");
    expect(keys.indexOf("bedrooms")).toBeLessThan(keys.indexOf("budget"));
  });

  it("renders the coded answers as English, not as their stored values", () => {
    const rows = buildBuyerReview(LOAN_BUYER, false);
    expect(rowFor(rows, "cashOrLoan")?.value).toBe("Getting a loan");
    expect(rowFor(rows, "lenderChoice")?.value).toBe("Mountain Mortgage");
    expect(rowFor(rows, "firstTimeBuyer")?.value).toBe("Yes");
    expect(rowFor(rows, "military")?.value).toBe("No");
  });

  it("collapses the two budget sliders into one range row", () => {
    const rows = buildBuyerReview(LOAN_BUYER, false);
    expect(rowFor(rows, "budget")?.value).toBe("$250K – $425K");
    // The raw slider keys are not separately listed — one question, one row.
    expect(rowFor(rows, "minBudget")).toBeUndefined();
    expect(rowFor(rows, "maxBudget")).toBeUndefined();
  });

  it("keeps a question they skipped, marked unanswered and still editable", () => {
    const rows = buildBuyerReview({ ...LOAN_BUYER, schools: "" }, false);
    const row = rowFor(rows, "schools");
    expect(row?.value).toBe(UNANSWERED);
    expect(row?.answered).toBe(false);
    expect(row?.target).toBe(8); // still points at the screen that asked it
  });

  it("points every row at the wizard screen that asked for it", () => {
    const rows = buildBuyerReview(LOAN_BUYER, false);
    expect(rowFor(rows, "cashOrLoan")?.target).toBe(0);
    expect(rowFor(rows, "bedrooms")?.target).toBe(2);
    expect(rowFor(rows, "budget")?.target).toBe(16);
    expect(rowFor(rows, "lenderChoice")?.target).toBe(18);
    expect(rowFor(rows, "contactPhone")?.target).toBe(21);
  });
});

describe("buildBuyerReview — a cash buyer's skipped questions (#427)", () => {
  /**
   * The loan-only screens are 11, 12, 14, 15 (military / employment / credit /
   * income), 17 (buying power, no answer of its own) and 18 (the lender pitch).
   * A cash buyer never saw any of them.
   */
  it("omits every loan-only question", () => {
    const rows = buildBuyerReview({ ...LOAN_BUYER, cashOrLoan: "cash" }, true);
    const keys = rows.map((r) => r.key);
    expect(keys).not.toContain("military");
    expect(keys).not.toContain("employment");
    expect(keys).not.toContain("creditScore");
    expect(keys).not.toContain("monthlyIncome");
    expect(keys).not.toContain("lenderChoice");
  });

  it("omits them even when stale answers are still on the deal", () => {
    // A buyer who answered as a financed buyer, then switched to cash: the old
    // answers are still in `deals.intake`, but they are no longer questions
    // this buyer is being asked, so the review must not offer to edit them.
    const rows = buildBuyerReview({ ...LOAN_BUYER, cashOrLoan: "cash" }, true);
    expect(rowFor(rows, "creditScore")).toBeUndefined();
    expect(rowFor(rows, "monthlyIncome")).toBeUndefined();
  });

  it("still lists everything a cash buyer WAS asked", () => {
    const rows = buildBuyerReview({ ...LOAN_BUYER, cashOrLoan: "cash" }, true);
    const keys = rows.map((r) => r.key);
    expect(keys).toContain("cashOrLoan");
    expect(keys).toContain("bedrooms");
    expect(keys).toContain("journeyStage"); // screen 13 — NOT in CASH_SKIP
    expect(keys).toContain("budget");
    expect(keys).toContain("trackingAddress");
    expect(keys).toContain("contactName");
    expect(rowFor(rows, "cashOrLoan")?.value).toBe("Cash purchase");
  });

  it("drops exactly the fields whose screen is in CASH_SKIP — no more, no less", () => {
    const loanKeys = buildBuyerReview(LOAN_BUYER, false).map((r) => r.key);
    const cashKeys = new Set(buildBuyerReview(LOAN_BUYER, true).map((r) => r.key));
    const dropped = loanKeys.filter((k) => !cashKeys.has(k));
    const expected = BUYER_REVIEW_FIELDS.filter((f) => CASH_SKIP.has(f.screen)).map(
      (f) => f.key
    );
    expect(dropped.sort()).toEqual(expected.sort());
  });
});

// ─── Seller ──────────────────────────────────────────────────────────────────

const SELLER_BASE = {
  address: "123 Oak Lane, Birmingham, AL",
  priceExpectation: "$400,000",
  whatMattersMost: "Top dollar",
  desiredListDate: "Next month",
  hardDeadline: "no",
  timelineFlexibility: "Somewhat flexible",
  reasonsForSelling: ["Upsizing", "Relocating"],
  stressfulOrUrgent: "no",
  hasMortgage: "no",
  propertyTax: "3200",
  propertyType: "Single Family",
  occupancy: "Owner occupied",
  yearBuilt: "1998",
  conditionRating: "Good",
  knownIssues: ["Roof"],
  majorUpgrades: "no",
  hasHoa: "no",
  preListingPrep: ["Paint"],
  preListingSpend: "$2,000",
  biggerFear: "Sitting on the market",
  openToIncentives: "yes",
  alsoLookingToBuy: "no",
  contactName: "Jordan Smith",
  contactPhone: "(205) 555-0100",
  contactEmail: "jordan@example.com",
};

/** The seller wizard's screen list for a no-mortgage, not-also-buying seller. */
const SELLER_SCREENS_BASE = [
  "address",
  "priceExpectation",
  "whatMattersMost",
  "desiredListDate",
  "hardDeadline",
  "timelineFlexibility",
  "reasonsForSelling",
  "stressfulOrUrgent",
  "hasMortgage",
  "propertyTax",
  "propertyType",
  "occupancy",
  "yearBuilt",
  "conditionRating",
  "knownIssues",
  "majorUpgrades",
  "hasHoa",
  "preListingPrep",
  "preListingSpend",
  "biggerFear",
  "openToIncentives",
  "alsoLookingToBuy",
  "smoothExitPitch",
  "contactInfo",
  "review",
  "confirmation",
];

const SELLER_SCREENS_MORTGAGE = [
  ...SELLER_SCREENS_BASE.slice(0, 9),
  "mortgageBalance",
  "mortgageRate",
  "mortgageAssumable",
  "hasHeloc",
  ...SELLER_SCREENS_BASE.slice(9),
];

describe("buildSellerReview — driven by the wizard's own screen list (#427)", () => {
  it("lists the questions this seller was asked", () => {
    const rows = buildSellerReview(SELLER_BASE, SELLER_SCREENS_BASE);
    const keys = rows.map((r) => r.key);
    expect(keys[0]).toBe("address");
    expect(keys).toContain("whatMattersMost");
    expect(keys).toContain("contactEmail");
    expect(rowFor(rows, "reasonsForSelling")?.value).toBe("Upsizing, Relocating");
  });

  it("omits the mortgage branch for a seller with no mortgage", () => {
    const keys = buildSellerReview(SELLER_BASE, SELLER_SCREENS_BASE).map((r) => r.key);
    expect(keys).not.toContain("mortgageBalance");
    expect(keys).not.toContain("mortgageRate");
    expect(keys).not.toContain("hasHeloc");
  });

  it("includes the mortgage branch once the seller says they have one", () => {
    const answers = { ...SELLER_BASE, hasMortgage: "yes", mortgageBalance: 185_000 };
    const rows = buildSellerReview(answers, SELLER_SCREENS_MORTGAGE);
    expect(rowFor(rows, "mortgageBalance")?.value).toBe("$185K");
    expect(rowFor(rows, "hasHeloc")?.value).toBe(UNANSWERED);
  });

  it("omits the also-buying branch, including the lender question", () => {
    const keys = buildSellerReview(SELLER_BASE, SELLER_SCREENS_BASE).map((r) => r.key);
    expect(keys).not.toContain("buyTiming");
    expect(keys).not.toContain("needSaleProceeds");
    expect(keys).not.toContain("lenderChoice");
  });

  it("leaves an untouched follow-up out rather than listing it as unanswered", () => {
    // `stressNotes` only exists once the seller says yes to "stressful or
    // urgent" — it is not a question they skipped, so it gets no row.
    const rows = buildSellerReview(SELLER_BASE, SELLER_SCREENS_BASE);
    expect(rowFor(rows, "stressNotes")).toBeUndefined();
    expect(rowFor(rows, "stressfulOrUrgent")?.value).toBe("No");
  });

  it("shows a follow-up once it has an answer", () => {
    const answers = {
      ...SELLER_BASE,
      stressfulOrUrgent: "yes",
      stressNotes: "Job transfer in 60 days",
    };
    const rows = buildSellerReview(answers, SELLER_SCREENS_BASE);
    expect(rowFor(rows, "stressNotes")?.value).toBe("Job transfer in 60 days");
  });

  it("points every row at the screen id that asked for it", () => {
    const rows = buildSellerReview(SELLER_BASE, SELLER_SCREENS_BASE);
    expect(rowFor(rows, "address")?.target).toBe("address");
    expect(rowFor(rows, "contactName")?.target).toBe("contactInfo");
  });
});
