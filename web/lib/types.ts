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

export type FastPassSurveyAnswers = {
  currentSituation: string;
  targetMoveDate: string;
  dateFlexibility: string;
  moveSize: string;
  moverPreference: string;
  packingPreference: string;
  utilities: string[];
  notes: string;
};

export type FastPassEnrollment = {
  enrolledAt: string;
  status: FastPassEnrollmentStatus;
  paymentOption: FastPassPaymentOption;
  selectedUpsells: FastPassUpsellId[];
  totalPaid: number;
  surveyAnswers?: FastPassSurveyAnswers;
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

export type SmoothExitSurveyAnswers = {
  nextStep: SmoothExitNextStep;
  estimatedSalePrice: number;
  moveOutDate: string;
  needsBridgeFinancing: boolean;
  moverPreference: string;
  wantsDeepClean: boolean;
  utilities: string[];
  notes: string;
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
    price: number;
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
  estimatedCommission: number;
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
  source: 'ai' | 'manual';
  stageContext: DealStage;
  dueDate?: string;
  completedAt?: string;
  dependsOn?: string[];
  actionType?: 'confirm' | 'upload' | 'link';
  actionUrl?: string;
};
