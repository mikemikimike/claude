"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { resolveClosingDate } from "@/lib/arive-dates";
import { AriveTracker, AriveKeyDates, Deal, DealStage, LoanMilestones, FastPassEnrollment, SmoothExitEnrollment } from "@/lib/types";
import {
  apiDealSchema,
  apiDealListSchema,
  type ApiDeal,
  type FastPassApiData,
  type SmoothExitApiData,
} from "@/lib/schemas/deal";
import { checkWire } from "@/lib/schemas/wire";
import { isSmoothExitNextStep } from "@/lib/smooth-exit-display";

// The wire type is inferred from the zod schema (#88) — one contract for
// the server boundary and this adapter, instead of a hand-maintained copy
// that can lie about string-vs-number (#85).
export type { ApiDeal };

/**
 * Drop `null`-valued keys from a survey-answer blob (#426).
 *
 * The wire schemas accept `null` on every field (a survey can post one), but
 * the view-model types say `field?: T` — `undefined`, not `null`. Passing the
 * blob straight through would type-lie and force every renderer to handle a
 * third case. Deleting the nulls collapses it back to "absent".
 */
type NullsRemoved<T> = { [K in keyof T]?: Exclude<T[K], null> };

function stripNulls<T extends object>(obj: T): NullsRemoved<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v != null)
  ) as NullsRemoved<T>;
}

function fastPassFromApi(d: FastPassApiData): FastPassEnrollment {
  return {
    enrolledAt: d.enrolled_at ?? new Date().toISOString(),
    status: (d.status as FastPassEnrollment['status']) ?? 'active',
    // No default (#439): a `pending_payment` enrollment genuinely has no
    // option yet, and defaulting it to 'now' made the admin dashboard treat an
    // unpaid enrollment as already paid upfront.
    paymentOption: (d.payment_option as FastPassEnrollment['paymentOption']) ?? null,
    selectedUpsells: (d.selected_upsells ?? []) as FastPassEnrollment['selectedUpsells'],
    totalPaid: Math.round((d.total_cents ?? 0) / 100),
    // #426 — carried through so the agent's card (and the admin dashboard's
    // survey block, which was rendering against a field nothing ever set) can
    // show what the client actually bought and where the money stands.
    paid: d.paid ?? false,
    ...(d.promo_code ? { promoCode: d.promo_code } : {}),
    ...(d.discount_cents ? { discountCents: d.discount_cents } : {}),
    ...(d.survey_answers ? { surveyAnswers: stripNulls(d.survey_answers) } : {}),
    // Unrounded (#440) — the buyer's payment card has to show the exact figure
    // Stripe will charge, and a promo discount can leave sub-dollar cents.
    totalCents: d.total_cents ?? 0,
  };
}

function smoothExitFromApi(d: SmoothExitApiData): SmoothExitEnrollment {
  const salePrice = d.estimated_sale_price ?? 0;
  // #426 — the survey answers were being dropped on this side too. `nextStep`
  // lives inside them, which is why the admin dashboard's "What's next" always
  // read "—": nothing ever populated the top-level field it reads.
  const rawSurvey = d.survey_answers ? stripNulls(d.survey_answers) : undefined;
  // An unrecognised nextStep is dropped rather than cast — NEXT_STEP_LABELS is
  // an exhaustive Record, so a stale value would index to `undefined` and
  // render the literal string "undefined" on the admin card.
  const nextStep = isSmoothExitNextStep(rawSurvey?.nextStep) ? rawSurvey.nextStep : undefined;
  const survey: SmoothExitEnrollment['surveyAnswers'] | undefined = rawSurvey
    ? { ...rawSurvey, nextStep }
    : undefined;
  return {
    enrolledAt: d.enrolled_at ?? new Date().toISOString(),
    status: (d.status as SmoothExitEnrollment['status']) ?? 'active',
    paymentOption: (d.payment_option as SmoothExitEnrollment['paymentOption']) ?? 'from_proceeds',
    estimatedSalePrice: salePrice,
    fee: Math.round((d.fee_cents ?? salePrice * 0.01)),
    buyingNext: false,
    selectedUpsells: d.selected_upsells ?? [],
    upsellTotalCents: d.upsell_total_cents ?? 0,
    upsellsPaid: d.upsells_paid ?? false,
    ...(survey ? { surveyAnswers: survey } : {}),
    ...(nextStep ? { nextStep } : {}),
  };
}

function ariveMilestonesFromTrackers(
  trackers: AriveTracker[],
  loanStatus: string | null | undefined,
  keyDates: AriveKeyDates | null | undefined,
): LoanMilestones {
  const get = (name: string) =>
    trackers.find((t) => t.name === name)?.currentTrackerStatus?.status ?? '';

  const isComplete = (name: string) => get(name).toLowerCase() === 'completed';
  const isStarted = (name: string) => {
    const s = get(name).toLowerCase();
    return s !== '' && s !== 'not_started';
  };

  const appraisalStatus = get('APPRAISAL').toLowerCase();
  let appraisal: LoanMilestones['appraisal'] = null;
  if (isComplete('APPRAISAL')) appraisal = 'complete';
  else if (appraisalStatus === 'scheduled') appraisal = 'scheduled';
  else if (appraisalStatus === 'ordered' || isStarted('APPRAISAL')) appraisal = 'ordered';
  else if (appraisalStatus !== '') appraisal = 'pending';

  const status = loanStatus?.toLowerCase() ?? '';

  return {
    source: 'arive',
    loanSetup: true,
    disclosuresOut: isStarted('CD'),
    disclosuresSignedSubmitted: isComplete('CD'),
    approvedWithConditions: status.includes('approved') || status.includes('conditional'),
    resubmittal: status.includes('resubmit') || status.includes('suspended'),
    clearToClose: status.includes('clear') || isComplete('SIGNED_DOCS_WITH_LENDER'),
    appraisal,
    funded: isComplete('FUNDING_WIRE'),
    ariveTrackers: trackers,
    ariveLoanStatus: loanStatus ?? undefined,
    ariveKeyDates: keyDates ?? undefined,
  };
}

/**
 * Numeric deal columns (DECIMAL) arrive over the wire as text. Parse
 * null-safely: null, empty string, and garbage stay null — callers apply
 * the client-type default at the assignment site.
 */
function parseNumeric(v: string | null | undefined): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function apiDealToFrontend(d: ApiDeal): Deal {
  // #411 — a price the app doesn't know stays `null` all the way to the
  // render. This used to be `?? 0` ("the client's TBD sentinel"), which is
  // exactly why Pipeline Value and Est. Commission read "$0" on every deal
  // nobody had priced by hand: a sentinel that looks like a real answer.
  //
  // A stored 0 is folded into "unknown" too. `deals.price` has no default and
  // the create/edit paths only ever write a number the user typed or an offer
  // amount, so a 0 in the column is legacy noise — and no house is worth $0,
  // so treating it as a real total would put the same "$0" back on the
  // dashboard with none of the honesty.
  const parsedPrice = parseNumeric(d.price);
  const price = parsedPrice != null && parsedPrice > 0 ? parsedPrice : null;
  const commissionPct = parseNumeric(d.commission_pct) ?? 3;

  let loanMilestones: LoanMilestones | undefined;
  if (d.arive_linked && d.arive_milestones && d.arive_milestones.length > 0) {
    loanMilestones = ariveMilestonesFromTrackers(
      d.arive_milestones,
      d.arive_loan_status,
      d.arive_key_dates,
    );
  }

  // ARIVE key dates win when present (same precedence as the calendar push in
  // lib/jobs.ts and the iCal feed — see lib/arive-dates.ts (#196/#300)); the
  // agent-entered manual closing_date is the fallback anchor for non-ARIVE
  // deals — every seller deal and outside-lender buyer (#253).
  const closingDate =
    resolveClosingDate(d.arive_key_dates, d.closing_date) ?? undefined;

  // Derive a live "days to close" counter from the closing date so the buyer /
  // seller portal countdown blocks show real data. Guard unparseable dates so
  // the counter is `undefined` (block hidden) rather than `NaN`.
  const closingMs = closingDate ? new Date(closingDate).getTime() : NaN;
  const daysToClose = Number.isFinite(closingMs)
    ? Math.max(0, Math.ceil((closingMs - Date.now()) / 86_400_000))
    : undefined;

  return {
    id: d.id,
    type: d.type,
    clientName: d.title,
    clientId: '',
    agentId: d.agent_id,
    stage: d.stage as DealStage,
    health: d.health ?? 'green',
    priority: 'medium',
    property: {
      address: d.address ?? 'TBD',
      city: '',
      state: '',
      zip: '',
      price,
    },
    timeline: {
      createdAt: d.created_at,
      closingDate: closingDate ?? undefined,
      daysToClose,
      // Anchor "days in stage" to when the deal entered its current stage (the
      // server health anchor), NOT updated_at — which ANY unrelated write
      // (notes, commission, fee checkout, buyer-status, ARIVE sync) bumps,
      // resetting the count to 0 (#257). Falls back to created_at when the wire
      // omits stage_entered_at (e.g. the create response).
      daysInStage: Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(d.stage_entered_at ?? d.created_at).getTime()) /
            86_400_000,
        ),
      ),
    },
    flags: d.arive_linked ? ['mountain_mortgage'] : [],
    // Real lifecycle status from the API (#254). Payloads that don't SELECT it
    // (create RETURNING, /api/me/deals) omit it — a fresh deal is 'active'.
    status: d.status ?? 'active',
    // No price, no commission figure (#411) — 3% of nothing is not $0, it is
    // "we don't know yet". Once the deal is under contract this price IS the
    // contract price, which is what the pipeline rollups take their cut of
    // (#459 — see `pipelineCommission` in lib/deal-money.ts for the gate).
    //
    // KNOWN LIMITATION (#459, deliberate): commission is a PERCENTAGE, full
    // stop. An agent working a flat fee gets a wrong number here. Paul chose
    // to keep v1 simple rather than carry a `commission_type` (percent | flat)
    // through the schema, the Edit Deal modal and both dashboards — so this is
    // a recorded decision, not an oversight. Whoever needs flat fees should
    // add the field rather than special-case this line.
    estimatedCommission: price == null ? null : Math.round(price * (commissionPct / 100)),
    commissionPct,
    agentName: d.agent_name,
    agentEmail: d.agent_email,
    agentPhone: d.agent_phone,
    notes: d.notes ?? undefined,
    loanMilestones,
    openTaskCount: d.open_task_count ?? 0,
    overdueTaskCount: d.overdue_task_count ?? 0,
    feeStatus: (d.fee_status as Deal['feeStatus']) ?? 'unpaid',
    feeAmountCents: d.fee_amount_cents ?? 7500,
    feePaidAt: d.fee_paid_at ?? null,
    fastPass: d.fast_pass ? fastPassFromApi(d.fast_pass) : undefined,
    smoothExit: d.smooth_exit ? smoothExitFromApi(d.smooth_exit) : undefined,
    preApproved: d.pre_approved ?? false,
    // #437 — the buyer's own "I applied", normalised to null when absent. It
    // deliberately does NOT feed `preApproved` above: the two states are
    // separate all the way to the render, which is what keeps the offer gate a
    // gate.
    preApprovalAppliedAt: d.pre_approval_applied_at ?? null,
    baaSigned: d.baa_signed ?? false,
    disclosuresComplete: d.disclosures_complete ?? false,
    buyerStatus: d.buyer_status ?? undefined,
    // #407 — only /api/me/deals serves this; agent payloads omit it, and an
    // absent flag must NOT read as "already onboarded".
    intakeSubmitted: d.intake_submitted ?? false,
    // #409/#451 — the server's cash/loan column. An absent or null value must
    // stay undefined so the pre-approval gate holds; only 'cash' lifts it.
    financingType: d.financing_type ?? undefined,
    // #428 — only /api/me/deals serves this. Left UNDEFINED when absent, never
    // coerced to false: an agent payload (or a response cached from before the
    // flag shipped) is "unknown", and unknown must fail open to the live MLS
    // form rather than telling a buyer their agent isn't connected.
    agentMlsConnected: d.agent_mls_connected,
  };
}

export function useDeal(id: string | undefined): {
  deal: Deal | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const query = useQuery({
    queryKey: ['deal', id],
    queryFn: async () => {
      // Dev/test-only wire check (#88): warns when the response drifts from
      // the schema; a no-op passthrough in production.
      const raw = await api.get<ApiDeal>(`/deals/${id}`);
      return apiDealToFrontend(checkWire(apiDealSchema, raw, "GET /api/deals/:id"));
    },
    enabled: Boolean(id),
  });

  return {
    deal: query.data ?? null,
    loading: query.isLoading || query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => { void query.refetch(); },
  };
}

export async function patchStage(dealId: string, stage: string, force?: boolean): Promise<ApiDeal> {
  const qs = force ? '?force=true' : '';
  return api.patch<ApiDeal>(`/deals/${dealId}/stage${qs}`, { stage });
}

/**
 * The two "this deal is over" statuses, as the `?status=` API takes them
 * (#417). Archived is the successful ending — a deal filed away from
 * `post_close`; `fallen_through` is the bad one. Both leave the pipeline, and
 * both belong in the dashboard's Completed Deals section.
 */
export const CLOSED_DEAL_STATUSES = 'archived,fallen_through';

/**
 * The caller's deals.
 *
 * `useDeals()` — no argument — is the active-only pipeline list, unchanged:
 * same `['deals']` query key, same request, so nothing that already reads it
 * moves. Pass a `?status=` value (a single lifecycle status, a comma list such
 * as `CLOSED_DEAL_STATUSES`, or `'all'`) to ask for a different slice; that
 * gets its own cache entry rather than overwriting the pipeline's.
 */
export function useDeals(statusFilter?: string): {
  deals: Deal[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const query = useQuery({
    queryKey: statusFilter ? ['deals', statusFilter] : ['deals'],
    queryFn: async () => {
      const qs = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
      const raw = await api.get<ApiDeal[]>(`/deals${qs}`);
      return checkWire(apiDealListSchema, raw, 'GET /api/deals').map(apiDealToFrontend);
    },
  });

  return {
    deals: query.data ?? [],
    loading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refresh: () => { void query.refetch(); },
  };
}
