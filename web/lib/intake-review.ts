/**
 * "Here's what you told us" — the client's own view of their questionnaire
 * (#427).
 *
 * Until now a client answered ~20 questions, submitted blind, and never saw the
 * answers again. This module turns a `deals.intake` answers object into an
 * ordered list of rows the client recognises — the questions in the order they
 * were ASKED, each carrying the wizard screen it came from so the review can
 * send them back to change it.
 *
 * Two rules the ticket is strict about:
 *
 *  1. **Skipped questions are not listed.** A cash buyer never saw the credit /
 *     income / lender screens, so showing them an empty "Credit score" row
 *     invites them to answer a question the product deliberately did not ask.
 *     The skip decision is NOT re-derived here — the caller passes the same
 *     signal the wizard navigates by (`isCash` for the buyer, the visible
 *     screen list for the seller), so the review and the wizard cannot disagree.
 *
 *  2. **An unanswered but VISIBLE question still gets a row**, showing
 *     "Not answered". Dropping it would make the one question they skipped the
 *     one question they can't go back and fill in.
 *
 * Labels come from lib/intake-fields, shared with the agent's Client Intake
 * panel, so both sides of the deal call the same answer the same thing.
 */
import { LENDER_LABELS, formatValue, labelFor, moneyShort } from "./intake-fields";

/** Shown in place of a blank answer — the row stays editable either way. */
export const UNANSWERED = "Not answered";

export type IntakeReviewRow = {
  /** Stable row identity (an answers key, or `budget` for the min/max pair). */
  key: string;
  label: string;
  value: string;
  /** True when the client left it blank — the row renders muted. */
  answered: boolean;
  /** The wizard screen this answer belongs to; clicking the row jumps there. */
  target: number | string;
};

// ─── Buyer ───────────────────────────────────────────────────────────────────

/**
 * The buyer wizard's loan-only screens — skipped for a cash buyer.
 *
 * THE source of truth: `BuyerOnboarding` imports this constant rather than
 * keeping its own copy, so a screen that stops being loan-only stops being
 * loan-only in both the navigation and the review at the same time.
 *
 * (17 = the estimated-buying-power interstitial and 18 = the lender pitch have
 * no answer of their own beyond `lenderChoice`; they are listed because
 * `shouldSkipScreen` navigates by screen number.)
 */
export const CASH_SKIP: ReadonlySet<number> = new Set([11, 12, 14, 15, 17, 18]);

/**
 * Which buyer answers live on which wizard screen, in the order asked.
 *
 * Screens 1–15 mirror `BuyerOnboarding`'s `SCREENS` array (screen n renders
 * `SCREENS[n - 1]`) — `tests/components/buyer-onboarding.test.tsx` asserts that
 * mapping stays true, so a reordered question breaks a test rather than
 * silently pointing "Change" at the wrong screen.
 */
export const BUYER_REVIEW_FIELDS: ReadonlyArray<{
  key: string;
  screen: number;
  /** Overrides the shared label where the agent panel has no entry. */
  label?: string;
}> = [
  { key: "cashOrLoan", screen: 0 },
  { key: "firstTimeBuyer", screen: 1 },
  { key: "bedrooms", screen: 2 },
  { key: "bathrooms", screen: 3 },
  { key: "areas", screen: 4 },
  { key: "propertyType", screen: 5 },
  { key: "garage", screen: 6 },
  { key: "pool", screen: 7 },
  { key: "schools", screen: 8 },
  { key: "basement", screen: 9 },
  { key: "notes", screen: 10 },
  { key: "military", screen: 11 },
  { key: "employment", screen: 12 },
  { key: "journeyStage", screen: 13 },
  { key: "creditScore", screen: 14 },
  { key: "monthlyIncome", screen: 15 },
  { key: "budget", screen: 16, label: "Budget" },
  { key: "lenderChoice", screen: 18, label: "Lender" },
  { key: "trackingAddress", screen: 19 },
  { key: "contactName", screen: 21 },
  { key: "contactPhone", screen: 21 },
  { key: "contactEmail", screen: 21 },
];

/** `$250K – $425K`, or null when the sliders never produced a real range. */
function budgetValue(answers: Record<string, unknown>): string | null {
  const min = answers.minBudget;
  const max = answers.maxBudget;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return `${moneyShort(min)} – ${moneyShort(max)}`;
}

/** Prettifies the two coded buyer answers whose raw value is not English. */
function displayValue(key: string, raw: unknown): string | null {
  if (key === "lenderChoice" && typeof raw === "string" && raw.trim()) {
    return LENDER_LABELS[raw.trim()] ?? raw.trim();
  }
  if (key === "cashOrLoan" && typeof raw === "string") {
    if (raw === "cash") return "Cash purchase";
    if (raw === "loan") return "Getting a loan";
  }
  return formatValue(key, raw);
}

/**
 * The buyer's review rows.
 *
 * @param isCash pass the wizard's own `data.cashOrLoan === 'cash'` — the same
 *   value `shouldSkipScreen` navigates by.
 */
export function buildBuyerReview(
  answers: Record<string, unknown>,
  isCash: boolean
): IntakeReviewRow[] {
  const rows: IntakeReviewRow[] = [];
  for (const { key, screen, label } of BUYER_REVIEW_FIELDS) {
    if (isCash && CASH_SKIP.has(screen)) continue;
    const value = key === "budget" ? budgetValue(answers) : displayValue(key, answers[key]);
    rows.push({
      key,
      label: label ?? labelFor("buyer", key),
      value: value ?? UNANSWERED,
      answered: value !== null,
      target: screen,
    });
  }
  return rows;
}

// ─── Seller ──────────────────────────────────────────────────────────────────

/**
 * Which seller answers live on which wizard screen id, in the order asked.
 *
 * The seller wizard's own visibility rules (`getVisibleScreens`) are branchier
 * than the buyer's — mortgage details only exist for a seller who HAS a
 * mortgage, the buy-side questions only for one who is also buying. Rather than
 * restate any of that, `buildSellerReview` takes the wizard's computed screen
 * list and keeps only the rows whose screen is in it.
 */
export const SELLER_REVIEW_FIELDS: ReadonlyArray<{
  key: string;
  screen: string;
  label?: string;
}> = [
  { key: "address", screen: "address" },
  { key: "priceExpectation", screen: "priceExpectation" },
  { key: "whatMattersMost", screen: "whatMattersMost" },
  { key: "desiredListDate", screen: "desiredListDate" },
  { key: "hardDeadline", screen: "hardDeadline" },
  { key: "timelineFlexibility", screen: "timelineFlexibility" },
  { key: "reasonsForSelling", screen: "reasonsForSelling" },
  { key: "stressfulOrUrgent", screen: "stressfulOrUrgent" },
  { key: "stressNotes", screen: "stressfulOrUrgent" },
  { key: "hasMortgage", screen: "hasMortgage" },
  { key: "mortgageBalance", screen: "mortgageBalance" },
  { key: "mortgageRate", screen: "mortgageRate" },
  { key: "mortgageAssumable", screen: "mortgageAssumable" },
  { key: "hasHeloc", screen: "hasHeloc" },
  { key: "propertyTax", screen: "propertyTax" },
  { key: "propertyType", screen: "propertyType" },
  { key: "occupancy", screen: "occupancy" },
  { key: "yearBuilt", screen: "yearBuilt" },
  { key: "conditionRating", screen: "conditionRating" },
  { key: "knownIssues", screen: "knownIssues" },
  { key: "majorUpgrades", screen: "majorUpgrades" },
  { key: "upgradesList", screen: "majorUpgrades" },
  { key: "hasHoa", screen: "hasHoa" },
  { key: "hoaDues", screen: "hasHoa" },
  { key: "preListingPrep", screen: "preListingPrep" },
  { key: "preListingSpend", screen: "preListingSpend" },
  { key: "biggerFear", screen: "biggerFear" },
  { key: "openToIncentives", screen: "openToIncentives" },
  { key: "alsoLookingToBuy", screen: "alsoLookingToBuy" },
  { key: "buyTiming", screen: "buyTiming" },
  { key: "needSaleProceeds", screen: "needSaleProceeds" },
  { key: "lenderChoice", screen: "pitchPage", label: "Lender" },
  { key: "contactName", screen: "contactInfo" },
  { key: "contactPhone", screen: "contactInfo" },
  { key: "contactEmail", screen: "contactInfo" },
];

/**
 * Follow-up questions that only exist once their parent was answered "yes".
 * An untouched one is not a question the seller skipped, so it is omitted
 * rather than listed as unanswered.
 */
const FOLLOW_UP_KEYS = new Set(["stressNotes", "upgradesList", "hoaDues"]);

/**
 * The seller's review rows.
 *
 * @param visibleScreens the wizard's own `getVisibleScreens(data)` output — the
 *   single source of truth for which questions this seller was actually asked.
 */
export function buildSellerReview(
  answers: Record<string, unknown>,
  visibleScreens: readonly string[]
): IntakeReviewRow[] {
  const visible = new Set(visibleScreens);
  const rows: IntakeReviewRow[] = [];
  for (const { key, screen, label } of SELLER_REVIEW_FIELDS) {
    if (!visible.has(screen)) continue;
    // `stressNotes` / `upgradesList` / `hoaDues` are follow-ups that only exist
    // once the parent question was answered "yes"; an untouched follow-up is
    // not a question the seller skipped, so it is left out rather than shown as
    // unanswered.
    const value = displayValue(key, answers[key]);
    if (value === null && FOLLOW_UP_KEYS.has(key)) continue;
    rows.push({
      key,
      label: label ?? labelFor("seller", key),
      value: value ?? UNANSWERED,
      answered: value !== null,
      target: screen,
    });
  }
  return rows;
}
