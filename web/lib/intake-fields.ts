/**
 * Display metadata for the onboarding questionnaire (#427).
 *
 * Extracted verbatim from `components/intake/IntakeCard.tsx`, which used to own
 * the only human-readable rendering of `deals.intake`. #427 adds a SECOND
 * renderer — the client's own review screen — and two copies of "what is this
 * answer called" would drift the moment a question is reworded: the agent's
 * Client Intake panel and the client's review would then label the same answer
 * differently, which is exactly the confusion the ticket is trying to remove.
 *
 * So the labels and the value formatting live here, and both renderers import
 * them. What each renderer still owns is ORDER and VISIBILITY: the agent panel
 * groups by what an agent scans for, while the client's review follows the
 * order the questions were actually asked in (see lib/intake-review.ts).
 *
 * Pure data + pure functions — no React, so it is unit-testable and usable from
 * server code.
 */

/** How the buyer's lender choice reads to a human. */
export const LENDER_LABELS: Record<string, string> = {
  mountain: "Mountain Mortgage",
  fastpass: "Fast Pass (Mountain Mortgage)",
  other: "Using another lender",
};

/** Number answers formatted as dollars rather than bare digits. */
export const MONEY_KEYS = new Set([
  "minBudget",
  "maxBudget",
  "mortgageBalance",
  "propertyTax",
  "hoaDues",
]);

export function moneyShort(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  return `$${Math.round(n / 1000)}K`;
}

/** camelCase → "Camel case" fallback label for unlisted keys. */
export function humanize(key: string): string {
  const spaced = key.replace(/([A-Z])/g, " $1").toLowerCase().trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Formats an answer value for display; `null` means "there is no answer here".
 *
 * Callers differ on what to do with a null: the agent panel drops the row
 * (an unanswered question is noise to them), while the client's review keeps it
 * and shows "Not answered" — dropping it there would make the one question they
 * skipped the one question they cannot go back and fill in.
 */
export function formatValue(key: string, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    if (t === "yes") return "Yes";
    if (t === "no") return "No";
    return t;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return MONEY_KEYS.has(key) ? moneyShort(v) : String(v);
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) {
    const items = v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    return items.length > 0 ? items.join(", ") : null;
  }
  return null;
}

/**
 * Curated display order + labels per role for the AGENT's Client Intake panel.
 * Unknown keys still render there (humanized) so future questionnaire fields
 * never silently disappear.
 */
export const BUYER_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "areas", label: "Areas" },
  { key: "bedrooms", label: "Bedrooms" },
  { key: "bathrooms", label: "Bathrooms" },
  { key: "propertyType", label: "Property type" },
  { key: "cashOrLoan", label: "Cash or loan" },
  { key: "firstTimeBuyer", label: "First-time buyer" },
  { key: "journeyStage", label: "Journey stage" },
  { key: "creditScore", label: "Credit score" },
  { key: "monthlyIncome", label: "Monthly income" },
  { key: "employment", label: "Employment" },
  { key: "military", label: "Military service" },
  { key: "garage", label: "Garage" },
  { key: "pool", label: "Pool" },
  { key: "basement", label: "Basement" },
  { key: "schools", label: "School preference" },
  { key: "trackingAddress", label: "First property to track" },
  { key: "notes", label: "Notes" },
  { key: "contactName", label: "Contact name" },
  { key: "contactPhone", label: "Contact phone" },
  { key: "contactEmail", label: "Contact email" },
];

export const SELLER_FIELDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "address", label: "Property address" },
  { key: "desiredListDate", label: "Target list date" },
  { key: "whatMattersMost", label: "Top priority" },
  { key: "priceExpectation", label: "Price expectation" },
  { key: "hardDeadline", label: "Hard deadline" },
  { key: "timelineFlexibility", label: "Timeline flexibility" },
  { key: "reasonsForSelling", label: "Reasons for selling" },
  { key: "stressfulOrUrgent", label: "Stressful or urgent" },
  { key: "stressNotes", label: "What's going on" },
  { key: "hasMortgage", label: "Has a mortgage" },
  { key: "mortgageBalance", label: "Mortgage balance" },
  { key: "mortgageRate", label: "Interest rate" },
  { key: "mortgageAssumable", label: "Assumable" },
  { key: "hasHeloc", label: "HELOC / 2nd mortgage" },
  { key: "propertyTax", label: "Annual property tax" },
  { key: "propertyType", label: "Property type" },
  { key: "occupancy", label: "Occupancy" },
  { key: "yearBuilt", label: "Year built" },
  { key: "conditionRating", label: "Condition" },
  { key: "knownIssues", label: "Known issues" },
  { key: "majorUpgrades", label: "Major upgrades" },
  { key: "upgradesList", label: "Upgrades" },
  { key: "hasHoa", label: "HOA" },
  { key: "hoaDues", label: "HOA dues (monthly)" },
  { key: "preListingPrep", label: "Open to pre-listing prep" },
  { key: "preListingSpend", label: "Pre-listing budget" },
  { key: "biggerFear", label: "Bigger fear" },
  { key: "openToIncentives", label: "Open to incentives" },
  { key: "alsoLookingToBuy", label: "Also looking to buy" },
  { key: "buyTiming", label: "Buy timing" },
  { key: "needSaleProceeds", label: "Needs sale proceeds to buy" },
  { key: "contactName", label: "Contact name" },
  { key: "contactPhone", label: "Contact phone" },
  { key: "contactEmail", label: "Contact email" },
];

const BUYER_LABELS: Record<string, string> = Object.fromEntries(
  BUYER_FIELDS.map((f) => [f.key, f.label])
);
const SELLER_LABELS: Record<string, string> = Object.fromEntries(
  SELLER_FIELDS.map((f) => [f.key, f.label])
);

/** The shared label for an answer key, falling back to a humanized key. */
export function labelFor(role: "buyer" | "seller", key: string): string {
  const map = role === "seller" ? SELLER_LABELS : BUYER_LABELS;
  return map[key] ?? humanize(key);
}
