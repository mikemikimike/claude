/**
 * Shared client-side entity types (#88, #89).
 *
 * The authoritative `Deal` / `Task` client types live here (they used to
 * live in the retired mock-data layer under `lib/data/`).
 *
 * Wire (API) request/response contracts live in `lib/schemas/` as zod
 * schemas — this file is the client-side view model layer.
 */
import type { DealStage, DealType } from "./stages";
import type { FastPassUpsellId } from "./fast-pass-catalog";

export type { DealStage, DealType };

export type DealStatus = 'active' | 'archived' | 'fallen_through';

// ── Fast Pass enrollment (deal.fastPass) ─────────────────────────────────────

export type FastPassEnrollmentStatus = 'pending_payment' | 'active' | 'complete' | 'collected';

export type FastPassPaymentOption = 'now' | 'at_closing' | 'seller_concession';

/**
 * The client's Fast Pass survey answers, as stored on `deals.fast_pass
 * .survey_answers` (#426).
 *
 * EVERY field is optional on purpose. The blob is whatever the survey posted at
 * the time — an older enrollment predates fields the survey has since added,
 * and the survey itself lets a buyer skip most screens. Rendering it must
 * therefore tolerate holes rather than assume the shape (`new Date(undefined)`
 * is how "Invalid Date" reached a concierge's screen).
 */
export type FastPassSurveyAnswers = {
  currentSituation?: string;
  targetMoveDate?: string;
  dateFlexibility?: string;
  moveSize?: string;
  moverPreference?: string;
  packingPreference?: string;
  utilities?: string[];
  notes?: string;
};

export type FastPassEnrollment = {
  enrolledAt: string;
  status: FastPassEnrollmentStatus;
  /**
   * `null` while the enrollment is `pending_payment` (#439) — the survey saves
   * the add-ons without asking how to pay, and the buyer's dashboard (#440)
   * fills this in when they do.
   */
  paymentOption: FastPassPaymentOption | null;
  selectedUpsells: FastPassUpsellId[];
  totalPaid: number;
  surveyAnswers?: FastPassSurveyAnswers;
  /**
   * Whether the money has actually arrived (#426). Distinct from `status`: a
   * `seller_concession` / `at_closing` enrollment is `active` and unpaid for
   * weeks, and a `pending_payment` one is unpaid AND has no option chosen. The
   * agent's card has to tell those three apart, so it reads both.
   */
  paid?: boolean;
  /** Promo code redeemed at enrollment, when one was (#281). */
  promoCode?: string;
  /** What that promo took off, in CENTS (#281) — server-computed, audit only. */
  discountCents?: number;
  /**
   * The enrollment's server-computed total in CENTS, straight off
   * `deals.fast_pass.total_cents` (#440). `totalPaid` is the same figure rounded
   * to whole dollars for display; anything that has to agree with what Stripe
   * charges — the buyer's payment card — must use this instead, because a promo
   * discount can leave a total that isn't a round dollar.
   */
  totalCents: number;
};

// ── Smooth Exit enrollment (deal.smoothExit) ─────────────────────────────────

export type SmoothExitNextStep =
  | 'buying_local'
  | 'buying_out_of_state'
  | 'downsizing'
  | 'renting'
  | 'retirement'
  | 'family'
  | 'not_sure';

export type SmoothExitPaymentOption = 'from_proceeds' | 'buyer_concession';

/**
 * The seller's Smooth Exit survey answers (`deals.smooth_exit.survey_answers`).
 * All-optional for the same reason as `FastPassSurveyAnswers` above; and
 * `estimatedSalePrice` is `string | number` because SmoothExitSurvey posts the
 * raw text input, so what is stored is genuinely either.
 */
export type SmoothExitSurveyAnswers = {
  nextStep?: SmoothExitNextStep;
  estimatedSalePrice?: number | string;
  moveOutDate?: string;
  needsBridgeFinancing?: boolean;
  moverPreference?: string;
  wantsDeepClean?: boolean;
  utilities?: string[];
  notes?: string;
};

export type SmoothExitEnrollmentStatus = 'pending' | 'active' | 'complete';

export type SmoothExitEnrollment = {
  enrolledAt: string;
  status: SmoothExitEnrollmentStatus;
  estimatedSalePrice: number;
  fee: number;
  paymentOption: SmoothExitPaymentOption;
  buyingNext: boolean;
  nextStep?: SmoothExitNextStep;
  surveyAnswers?: SmoothExitSurveyAnswers;
  selectedUpsells?: string[];
  upsellTotalCents?: number;
  upsellsPaid?: boolean;
};

// ── Deal view model ──────────────────────────────────────────────────────────

export type DealHealth = 'green' | 'yellow' | 'red';
export type DealPriority = 'high' | 'medium' | 'low';

/**
 * Valid deal flags. Use these instead of raw strings.
 * Note: disclosure state is derived from loanMilestones (disclosuresSent + disclosuresSigned),
 * not from a flag, to keep a single source of truth.
 */
export type DealFlag =
  | 'fast_pass'       // buyer enrolled in Fast Pass concierge service
  | 'repair_request'  // buyer has submitted a repair request
  | 'mountain_mortgage' // buyer is using Mountain Mortgage (used for ARIVE default)
  | 'asap_timeline'   // seller/buyer has urgent timeline
  | 'also_buying';    // seller is also purchasing a new home

export type Vendor = {
  company: string;
  contactName?: string;
  phone?: string;
  email?: string;
};

export type LenderVendor = Vendor & {
  /** true = Mountain Mortgage → milestones auto-synced from ARIVE API */
  isAriveIntegrated: boolean;
  loanOfficer?: string;
  /** Direct link to lender's borrower portal — shown as a button in the buyer/seller view */
  portalUrl?: string;
};

export type DealVendors = {
  lender?: LenderVendor;
  titleCompany?: Vendor;
  closingAttorney?: Vendor;
  inspector?: Vendor;
  /** Homeowners insurance — required on every purchase to close */
  insurance?: Vendor;
};

export type AriveTracker = {
  name: string;
  currentTrackerStatus: { status: string };
};

export type AriveKeyDates = Record<string, string | null>;

export type LoanMilestones = {
  /** 'arive' = read-only, synced from Mountain Mortgage. 'manual' = editable by TC/agent. */
  source: 'arive' | 'manual';
  // Ordered milestones (manual or derived from ARIVE)
  loanSetup: boolean;
  disclosuresOut: boolean;
  disclosuresSignedSubmitted: boolean;
  approvedWithConditions: boolean;
  resubmittal: boolean;
  clearToClose: boolean;
  // Separate: appraisal API tracker
  appraisal: 'pending' | 'ordered' | 'scheduled' | 'complete' | null;
  // Funded = loan disbursed, triggers celebration
  funded: boolean;
  // ARIVE raw tracker data (present when source === 'arive')
  ariveTrackers?: AriveTracker[];
  ariveLoanStatus?: string;
  ariveKeyDates?: AriveKeyDates;
};

export type Deal = {
  id: string;
  type: DealType;
  clientName: string;
  clientId: string;
  agentId: string;
  stage: DealStage;
  health: DealHealth;
  priority: DealPriority;
  property: {
    address: string;
    city: string;
    state: string;
    zip: string;
    /**
     * `null` when the app genuinely doesn't know the price yet (#411) — most
     * of a deal's life, until an offer amount or a tracked listing's list
     * price fills `deals.price` in. Render it with `formatMoney` from
     * `lib/deal-money`, and total a list of them with `sumKnown`: collapsing
     * "unknown" to 0 is what made every dashboard read "$0".
     */
    price: number | null;
    image?: string;
  };
  timeline: {
    createdAt: string;
    closingDate?: string;
    daysInStage: number;
    daysToClose?: number;
  };
  flags: DealFlag[];
  status: DealStatus;
  /** Reason deal fell through — only present when status === 'fallen_through' */
  fallReason?: string;
  /** Stage the deal was in when it fell through — for displaying history */
  fellFromStage?: DealStage;
  /** Loan milestone tracking. Present on buy deals (and sell deals with a buyer's lender). */
  loanMilestones?: LoanMilestones;
  /** Vendors assigned to this file — lender, title company, inspector. */
  vendors?: DealVendors;
  /** `null` whenever `property.price` is — there is no cut of an unknown number (#411). */
  estimatedCommission: number | null;
  commissionPct?: number;
  notes?: string;
  fastPass?: FastPassEnrollment;
  smoothExit?: SmoothExitEnrollment;
  /** Populated from real API — agent contact info attached to each deal */
  agentName?: string;
  agentEmail?: string;
  agentPhone?: string | null;
  /** Task counts populated from real API */
  openTaskCount?: number;
  overdueTaskCount?: number;
  /** Closing fee — populated from real API */
  feeStatus?: 'unpaid' | 'pending' | 'paid' | 'waived' | 'refunded';
  feeAmountCents?: number;
  feePaidAt?: string | null;
  /** Deal flags — populated from real API */
  preApproved?: boolean;
  /**
   * ISO timestamp of the buyer's "I applied for my pre-approval" (#437), or
   * null when they never said so.
   *
   * The WEAK of the two pre-approval states, and the reason `preApproved`
   * above can stay honest: the buyer can set THIS one themselves, and it
   * unlocks nothing. Never fold it into the offer gate — `canOffer` is
   * `preApproved || financingType === 'cash'` and this field is not part of
   * that expression by design.
   */
  preApprovalAppliedAt?: string | null;
  baaSigned?: boolean;
  disclosuresComplete?: boolean;
  /**
   * Agent-set "Buyer's Progress" step shown on the seller portal (#184).
   * Persisted server-side (deals.buyer_status); one of BUYER_STATUS_STEPS
   * in lib/buyer-status.ts, or undefined when not set.
   */
  buyerStatus?: string;
  /**
   * Whether the client has submitted their onboarding questionnaire (#407).
   * Populated from /api/me/deals (`intake_submitted`); the client portal uses
   * it to stop prompting for onboarding a client already completed — including
   * on the deals still parked in `intake` from before the fix.
   */
  intakeSubmitted?: boolean;
  /**
   * How the buyer is paying (#409). A real column since #451
   * (`deals.financing_type`), written from the onboarding answer and
   * correctable by the deal's agent; undefined when they haven't answered, on
   * sell deals, and on payloads that don't carry it.
   *
   * `'cash'` is what lets the buyer portal drop the pre-approval offer gate —
   * a cash buyer has no lender and can never satisfy it. Undefined must keep
   * the gate, never bypass it.
   */
  financingType?: 'cash' | 'loan';
  /**
   * Whether this deal's AGENT has MLS credentials on file (#428). Populated
   * from /api/me/deals (`agent_mls_connected`) so the client portal can render
   * the MLS browser in an explained empty state rather than inviting a search
   * that is guaranteed to fail.
   *
   * A boolean, never a credential. `undefined` means "we weren't told" — an
   * agent-facing payload, or a cached response from before this shipped — and
   * must fail OPEN to the live form, exactly as the portal behaved before.
   * It is a UX signal only; `GET /deals/:id/listings/search` remains the
   * enforcement point.
   */
  agentMlsConnected?: boolean;
};

export type Task = {
  id: string;
  dealId: string;
  title: string;
  description?: string;
  assignedTo: 'agent' | 'buyer' | 'seller' | 'tc' | 'admin' | 'third_party';
  assignedToId: string;
  status: 'pending' | 'in_progress' | 'completed' | 'overdue' | 'blocked';
  priority: 'high' | 'medium' | 'low';
  /**
   * Where the row came from. `'manual'` = a person created it, `'ai'` = the
   * stage seeder created it on stage entry, `'preapproval'` = the Mountain
   * Mortgage / Fast Pass pre-approval ask created by onboarding (#434/#460).
   *
   * `'preapproval'` is a distinct value rather than another `'ai'` row because
   * `'ai'` is read as "seeded by entering this stage" by both the stage seeder
   * and the forward-advance gate's #445 exemption — see lib/stage-task-seed.ts.
   * Note it therefore does NOT get the "AI"/"Auto" badge the UI shows for
   * `'ai'`, which is correct: nothing auto-generated it on stage entry, and it
   * is a genuine ask of the buyer rather than a reminder.
   */
  source: 'ai' | 'manual' | 'preapproval';
  stageContext: DealStage;
  dueDate?: string;
  completedAt?: string;
  dependsOn?: string[];
  actionType?: 'confirm' | 'upload' | 'link';
  actionUrl?: string;
};
