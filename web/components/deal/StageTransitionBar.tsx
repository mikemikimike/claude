"use client";

import { Deal, DealStage } from "@/lib/types";
import { useProperties } from "@/hooks/useProperties";
import { useOffers } from "@/hooks/useOffers";
import { ChevronRight, ChevronLeft, AlertTriangle, CheckCircle2 } from "lucide-react";
import { STAGE_LABELS, STAGE_ORDER, STAGE_GATE } from "@/components/deal/shared";

export function StageTransitionBar({
  stage,
  deal,
  onAdvance,
  onRetreat,
}: {
  stage: DealStage;
  deal: Deal;
  onAdvance: () => void;
  onRetreat: () => void;
}) {
  const idx = STAGE_ORDER.indexOf(stage);
  const prevStage = idx > 0 ? STAGE_ORDER[idx - 1] : null;
  const nextStage = idx < STAGE_ORDER.length - 1 ? STAGE_ORDER[idx + 1] : null;

  const nextGate = nextStage ? STAGE_GATE[nextStage] : null;
  const gateDocSigned = true;

  const isOfferActive = stage === 'offer_active';
  const { properties: stageProperties } = useProperties(isOfferActive ? deal.id : undefined);
  const { offers: dealOffers } = useOffers(isOfferActive ? deal.id : undefined);

  // #410: the banner used to name whichever listing the *buyer* had tapped
  // "Make an Offer" on — a guess that showed nothing when they'd tapped
  // nothing and silently picked the first when they'd tapped two. Advancing to
  // Offer Active now writes a real `offers` row carrying the property, so read
  // the newest linked offer (the API returns them submitted_at desc). The
  // offerRequested guess survives only as a fallback for deals that reached
  // offer_active before this shipped.
  const linkedOffer = isOfferActive
    ? dealOffers.find((o) => o.trackedPropertyId)
    : undefined;
  const offerProperty = !isOfferActive
    ? null
    : linkedOffer
      ? stageProperties.find((p) => p.id === linkedOffer.trackedPropertyId)
      : stageProperties.find((p) => p.offerRequested);

  return (
    <div className="rounded-xl bg-white shadow-sm border border-gray-100 overflow-hidden">
      {/* Progress pip track */}
      <div className="flex gap-0.5 px-4 pt-3">
        {STAGE_ORDER.map((s, i) => (
          <div
            key={s}
            className={[
              'h-1 flex-1 rounded-full transition-all',
              i < idx ? 'bg-brand-navy/40' :
              i === idx ? isOfferActive ? 'bg-amber-400' : 'bg-brand-navy' :
              'bg-gray-100',
            ].join(' ')}
          />
        ))}
      </div>

      {/* Stage label + step counter */}
      <div className="text-center px-4 pt-2 pb-1">
        <p className="text-base font-black text-brand-navy tracking-tight">{STAGE_LABELS[stage]}</p>
        <p className="text-[10px] text-gray-400 font-medium">Stage {idx + 1} of {STAGE_ORDER.length}</p>
      </div>

      {/* Offer context banner */}
      {isOfferActive && (
        <div className="mx-4 mb-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-xs font-bold text-amber-800 mb-0.5">
            {offerProperty ? `Offer on ${offerProperty.address}` : 'Offer pending — awaiting seller response'}
            {linkedOffer && linkedOffer.offerPrice > 0 && (
              <span className="font-semibold"> · ${linkedOffer.offerPrice.toLocaleString()}</span>
            )}
          </p>
          <p className="text-[11px] text-amber-600 leading-snug">
            Mark accepted to move into contract, or rejected to return to home search.
          </p>
        </div>
      )}

      {/* Warning */}
      {!isOfferActive && nextGate && !gateDocSigned && (
        <div className="mx-4 mb-2 flex items-center gap-1.5 rounded-lg bg-amber-50 border border-amber-100 px-3 py-1.5">
          <AlertTriangle size={12} className="text-amber-500 flex-shrink-0" />
          <p className="text-[11px] text-amber-700 font-medium">
            Heads up: {nextGate.name} not yet signed
          </p>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-2 px-4 pb-4">
        <button
          onClick={onRetreat}
          disabled={!prevStage}
          className={[
            'flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 px-4 py-2.5 text-sm font-bold disabled:opacity-25 disabled:cursor-not-allowed transition-colors',
            isOfferActive
              ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
              : 'border-gray-200 text-gray-500 hover:border-gray-300 hover:bg-gray-50',
          ].join(' ')}
        >
          <ChevronLeft size={15} />
          {isOfferActive ? 'Offer Rejected' : prevStage ? STAGE_LABELS[prevStage] : 'Back'}
        </button>
        {/* No next stage (post_close) — the deal is done, so show the stage as
            final instead of a permanently disabled "Complete" button (#416). */}
        {nextStage ? (
          <button
            onClick={onAdvance}
            className={[
              'flex flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-25 disabled:cursor-not-allowed transition-colors shadow-sm',
              isOfferActive
                ? 'bg-green-500 hover:bg-green-600'
                : 'bg-brand-navy hover:bg-brand-navy/85',
            ].join(' ')}
          >
            {isOfferActive ? 'Offer Accepted' : STAGE_LABELS[nextStage]}
            <ChevronRight size={15} />
          </button>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-green-200 bg-green-50 px-4 py-2.5 text-sm font-bold text-green-700">
            <CheckCircle2 size={15} />
            Final stage
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Deal Header ─────────────────────────────────────────────────────────────
