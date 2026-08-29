"use client";

import { useState } from 'react';
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useDeal, patchStage } from "@/hooks/useDeals";
import { ApiError } from "@/lib/api-client";
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/lib/store/authStore";
import { useTasks } from "@/hooks/useTasks";
import { useDocuments } from "@/hooks/useDocuments";
import { postMessage } from "@/hooks/useMessages";
import {
  ArrowLeft,
  MessageSquare,
  FileText,
  LayoutDashboard,
  CheckSquare,
  GitBranch,
  Building2,
  ClipboardList,
  AlertTriangle,
} from 'lucide-react';

import { STAGE_ORDER } from "@/components/deal/shared";
import { OverviewTab, SellerBuyerStatusCard, ContingenciesCard } from "@/components/deal/OverviewTab";
import { TasksTab } from "@/components/deal/TasksTab";
import { MessagesTab } from "@/components/deal/MessagesTab";
import { DocumentsTab, UploadDocModal } from "@/components/deal/DocumentsTab";
import { VendorsTab } from "@/components/deal/VendorsTab";
import { TimelineTab } from "@/components/deal/TimelineTab";
import { InspectionTab } from "@/components/deal/InspectionTab";
import { StageAdvanceModal, type BlockingTask, type OfferDetails } from "@/components/deal/StageAdvanceModal";
import { useProperties } from "@/hooks/useProperties";
import { useOffers } from "@/hooks/useOffers";
import { useInspectionItems } from "@/hooks/useInspectionItems";
import { isClosedInspectionStatus } from "@/lib/inspection-items";
import { StageTransitionBar } from "@/components/deal/StageTransitionBar";
import { DealHeader } from "@/components/deal/DealHeader";

// Keep the pre-split public surface importable at this path for existing tests
// (the tabs/modals/cards now live under components/deal/, #87).
export { SellerBuyerStatusCard, ContingenciesCard, TasksTab, DocumentsTab, UploadDocModal, StageAdvanceModal };

// ─── Tab definitions ────────────────────────────────────────────────────────

type TabId = 'overview' | 'tasks' | 'messages' | 'documents' | 'timeline' | 'inspection' | 'vendors';

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: 'overview',  label: 'Overview',  icon: LayoutDashboard },
  { id: 'timeline',  label: 'Timeline',  icon: GitBranch },
  { id: 'tasks',     label: 'Tasks',     icon: CheckSquare },
  { id: 'messages',  label: 'Messages',  icon: MessageSquare },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'inspection', label: 'Inspection', icon: ClipboardList },
  { id: 'vendors',   label: 'Vendors',   icon: Building2 },
];


export default function DealDetail() {
  const { dealId } = useParams<{ dealId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeUser = useAuthStore((s) => s.activeUser);
  const initialTab = (() => {
    // Returning from an embedded DocuSign session (?signed_doc=<id>) lands on
    // the Documents tab, where the return banner + refreshed statuses live.
    if (searchParams.get('signed_doc')) return 'documents';
    const t = searchParams.get('tab');
    const valid: TabId[] = ['overview', 'tasks', 'messages', 'documents', 'timeline', 'inspection', 'vendors'];
    return (valid as string[]).includes(t ?? '') ? (t as TabId) : 'overview';
  })();
  const [activeTab, setActiveTab] = useState<TabId>(initialTab);
  const [showAdvanceModal, setShowAdvanceModal] = useState(false);
  const [stageGateError, setStageGateError] = useState<{ blockingTasks: BlockingTask[] } | null>(null);
  // Non-blocking: set when the stage advanced but the drafted client message
  // failed to post (#185) — the advance itself must never be rolled back.
  const [clientMsgSendFailed, setClientMsgSendFailed] = useState(false);
  // Non-blocking: the stage advanced but the offer row failed to save (#410).
  const [offerSaveFailed, setOfferSaveFailed] = useState(false);

  const { deal: apiDeal, loading: dealLoading, error: dealError, refresh: refreshDeal } = useDeal(dealId);
  const { tasks: dealTasks, refresh: refreshTasks } = useTasks(dealId ?? '');
  const { docs: dealDocs, loading: docsLoading, refresh: refreshDocs } = useDocuments(dealId ?? '');
  // The Offer Active picker's options (#410). Fetched here rather than inside
  // the modal so StageAdvanceModal stays a pure, prop-driven component.
  const { properties: dealProperties } = useProperties(dealId);
  const { addOffer, refresh: refreshOffers } = useOffers(dealId);
  // Fetched here only for the tab's open-item badge. InspectionTab calls the
  // same hook, and React Query dedupes on the shared key — one request, not two.
  const { items: inspectionItems } = useInspectionItems(dealId ?? '');

  if (dealLoading) {
    return (
      <div className="max-w-3xl">
        <button
          onClick={() => router.back()}
          className="mb-4 flex items-center gap-1.5 text-sm text-gray-400 hover:text-brand-navy transition-colors"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="rounded-xl bg-white p-10 text-center shadow-sm">
          <p className="text-gray-400">Loading deal…</p>
        </div>
      </div>
    );
  }

  if (!apiDeal) {
    return (
      <div className="max-w-3xl">
        <button
          onClick={() => router.back()}
          className="mb-4 flex items-center gap-1.5 text-sm text-gray-400 hover:text-brand-navy transition-colors"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <div className="rounded-xl bg-white p-10 text-center shadow-sm">
          <p className="text-sm text-gray-500">
            {dealError ? "We couldn't load this deal — it may have been removed, or you may not have access." : 'Deal not found.'}
          </p>
          <button
            onClick={() => refreshDeal()}
            className="mt-4 rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand-navy/90 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const deal = apiDeal;
  // Server stage is the single source of truth (#87 — the dealStageStore local
  // override was deleted). After an advance/retreat we refreshDeal() to pull it.
  const stage = deal.stage;
  const localDeal = { ...deal, stage };
  const canAdvanceStage = ['agent', 'tc', 'admin'].includes(activeUser?.groupId ?? '');

  function advanceStage() {
    setClientMsgSendFailed(false);
    setOfferSaveFailed(false);
    setShowAdvanceModal(true);
  }

  async function handleAdvanceConfirm(
    draftMessage: string,
    force?: boolean,
    offer?: OfferDetails | null,
  ) {
    const idx = STAGE_ORDER.indexOf(stage);
    if (idx < STAGE_ORDER.length - 1) {
      const nextStage = STAGE_ORDER[idx + 1];
      try {
        await patchStage(deal.id, nextStage, force);
      } catch (err) {
        if (err instanceof ApiError && err.status === 422 && err.body?.gate) {
          setStageGateError({ blockingTasks: err.body.blocking_tasks ?? [] });
          return;
        }
        setShowAdvanceModal(false);
        return;
      }
      // Record WHICH house and for how much (#410). After the stage PATCH, so
      // a 422 gate rejection can't leave an orphan offer behind. Best-effort
      // like the client message: a failed write must not undo the advance —
      // the agent can still see the stage moved.
      if (offer) {
        try {
          await addOffer({
            trackedPropertyId: offer.tracked_property_id,
            buyerName: deal.clientName ?? '',
            offerPrice: offer.offer_price,
            contingencies: [],
            agentNotes: '',
          });
          refreshOffers();
        } catch {
          setOfferSaveFailed(true);
        }
      }
      refreshDeal();
      // Post the agent's (possibly edited) drafted message to the client
      // thread — the modal promises this (#185). Best-effort: a failed send
      // must never break the stage advance itself.
      const clientNote = draftMessage.trim();
      if (clientNote) {
        try {
          await postMessage(deal.id, 'client_thread', clientNote);
        } catch {
          setClientMsgSendFailed(true);
        }
      }
      // Auto-tasks are now seeded server-side, atomically with the stage
      // transition (#87 — the old client postTask() loop was lost if the tab
      // closed mid-loop). Pull the freshly-seeded tasks into the UI.
      refreshTasks();
    }
    setStageGateError(null);
    setShowAdvanceModal(false);
  }

  async function retreatStage() {
    const idx = STAGE_ORDER.indexOf(stage);
    if (idx > 0) {
      const prevStage = STAGE_ORDER[idx - 1];
      try {
        await patchStage(deal.id, prevStage);
      } catch {
        return;
      }
      refreshDeal();
    }
  }

  const tabCounts: Partial<Record<TabId, number>> = {
    tasks: dealTasks.filter((t) => t.status !== 'completed').length,
    documents: dealDocs.length,
    inspection: inspectionItems.filter((i) => !isClosedInspectionStatus(i.status)).length,
  };

  return (
    <div className="max-w-3xl space-y-4">
      {/* Back nav */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-brand-navy transition-colors w-fit"
      >
        <ArrowLeft size={14} /> Back
      </button>

      {/* Deal header */}
      <DealHeader
        deal={localDeal}
        canEdit={activeUser?.id === deal.agentId}
        onFlagChange={async (flags) => {
          // PATCH /flags speaks the DB's snake_case. The camelCase object was
          // being posted straight through, so the route recognized nothing in
          // it and the write was a silent no-op — caught while wiring the #451
          // financing override onto the same handler.
          const body: Record<string, unknown> = {};
          if (flags.preApproved !== undefined) body.pre_approved = flags.preApproved;
          // `null` is meaningful here (clear it), so test for presence.
          if ('financingType' in flags) body.financing_type = flags.financingType ?? null;
          await api.patch(`/deals/${localDeal.id}/flags`, body).catch(() => {});
          refreshDeal();
        }}
        onSave={async (patch) => {
          await api.patch(`/deals/${localDeal.id}`, patch).catch(() => {});
          refreshDeal();
        }}
      />

      {/* Stage transition bar — agents, TCs, admins only */}
      {canAdvanceStage && deal.status !== 'fallen_through' && (
        <StageTransitionBar
          stage={stage}
          deal={deal}
          onAdvance={advanceStage}
          onRetreat={retreatStage}
          // #417 — the owning agent closes the deal out from the same bar they
          // moved it with. Only the owner: PATCH /api/deals/[id] is agent-only,
          // so a TC or admin would get a control that 403s. Archiving is the
          // same soft end the header's Archive link performs; it stays
          // readable and reversible, and it shows up under Completed Deals.
          onComplete={
            activeUser?.id === deal.agentId
              ? async () => {
                  if (
                    !window.confirm(
                      "Mark this deal complete? It leaves your active pipeline and moves to Completed Deals on your dashboard — you can reopen it any time."
                    )
                  ) {
                    return;
                  }
                  await api.patch(`/deals/${deal.id}`, { status: 'archived' }).catch(() => {});
                  refreshDeal();
                }
              : undefined
          }
        />
      )}

      {/* Non-blocking warning — stage advanced but the client message didn't send (#185) */}
      {clientMsgSendFailed && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
            <p className="text-xs font-medium text-amber-800">
              Stage advanced, but the client message could not be sent. You can resend it from the Messages tab.
            </p>
          </div>
          <button
            onClick={() => setClientMsgSendFailed(false)}
            className="text-xs font-semibold text-amber-600 hover:text-amber-800 transition-colors flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Non-blocking warning — stage advanced but the offer didn't save (#410) */}
      {offerSaveFailed && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
            <p className="text-xs font-medium text-amber-800">
              Stage advanced, but the offer details could not be saved. Advance again, or add
              the offer from the deal, so the property and amount are recorded.
            </p>
          </div>
          <button
            onClick={() => setOfferSaveFailed(false)}
            className="text-xs font-semibold text-amber-600 hover:text-amber-800 transition-colors flex-shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Stage advance automation modal */}
      {showAdvanceModal && (() => {
        const idx = STAGE_ORDER.indexOf(stage);
        const nextStage = idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;
        return nextStage ? (
          <StageAdvanceModal
            deal={deal}
            nextStage={nextStage}
            properties={dealProperties}
            gateError={stageGateError}
            onConfirm={handleAdvanceConfirm}
            onCancel={() => { setStageGateError(null); setShowAdvanceModal(false); }}
          />
        ) : null;
      })()}

      {/* Tabs */}
      <div className="flex gap-0.5 rounded-xl bg-white p-1 shadow-sm overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const count = tabCounts[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'flex items-center gap-1.5 flex-shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'bg-brand-navy text-white shadow-sm'
                  : 'text-gray-500 hover:bg-brand-bg',
              ].join(' ')}
            >
              <Icon size={14} />
              {tab.label}
              {count !== undefined && count > 0 && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
                  activeTab === tab.id ? 'bg-white/20 text-white' : 'bg-brand-navy/10 text-brand-navy'
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && <OverviewTab deal={localDeal} tasks={dealTasks} onRefresh={refreshDeal} />}
      {activeTab === 'tasks' && <TasksTab deal={localDeal} tasks={dealTasks} onTasksChange={refreshTasks} />}
      {activeTab === 'messages' && <MessagesTab deal={localDeal} />}
      {activeTab === 'documents' && <DocumentsTab deal={localDeal} docs={dealDocs} loading={docsLoading} onRefresh={refreshDocs} />}
      {activeTab === 'timeline' && <TimelineTab deal={localDeal} tasks={dealTasks} />}
      {activeTab === 'inspection' && <InspectionTab deal={localDeal} />}
      {activeTab === 'vendors' && <VendorsTab deal={localDeal} />}
    </div>
  );
}
