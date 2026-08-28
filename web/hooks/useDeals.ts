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

// The wire type is inferred from the zod schema (#88) — one contract for
// the server boundary and this adapter, instead of a hand-maintained copy
// that can lie about string-vs-number (#85).
export type { ApiDeal };

function fastPassFromApi(d: FastPassApiData): FastPassEnrollment {
  return {
    enrolledAt: d.enrolled_at ?? new Date().toISOString(),
    status: (d.status as FastPassEnrollment['status']) ?? 'active',
    paymentOption: (d.payment_option as FastPassEnrollment['paymentOption']) ?? 'now',
    selectedUpsells: (d.selected_upsells ?? []) as FastPassEnrollment['selectedUpsells'],
    totalPaid: Math.round((d.total_cents ?? 0) / 100),
  };
}

function smoothExitFromApi(d: SmoothExitApiData): SmoothExitEnrollment {
  const salePrice = d.estimated_sale_price ?? 0;
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
  // Deal.property.price is a plain number; 0 is the client's TBD sentinel.
  const price = parseNumeric(d.price) ?? 0;
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
    estimatedCommission: Math.round(price * (commissionPct / 100)),
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
    baaSigned: d.baa_signed ?? false,
    disclosuresComplete: d.disclosures_complete ?? false,
    buyerStatus: d.buyer_status ?? undefined,
    // #407 — only /api/me/deals serves this; agent payloads omit it, and an
    // absent flag must NOT read as "already onboarded".
    intakeSubmitted: d.intake_submitted ?? false,
    // #409 — server-derived cash/loan. An absent or null value must stay
    // undefined so the pre-approval gate holds; only an explicit 'cash' lifts it.
    financingType: d.financing_type ?? undefined,
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

export function useDeals(): {
  deals: Deal[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const query = useQuery({
    queryKey: ['deals'],
    queryFn: async () => {
      const raw = await api.get<ApiDeal[]>('/deals');
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
