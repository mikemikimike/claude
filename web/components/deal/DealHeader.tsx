"use client";

import { useState } from "react";
import { Deal, DealStatus } from "@/lib/types";
import { MapPin, Calendar, Clock, CheckCircle2, Circle, Zap, Pencil, Archive, RotateCcw, Banknote } from "lucide-react";
import { STAGE_LABELS, HEALTH_BORDER, HEALTH_BADGE, ClosingDaysBadge } from "@/components/deal/shared";

/** The editable core-identity patch (#254). */
export type DealEdit = { title?: string; address?: string; price?: number; status?: DealStatus };

export function DealHeader({
  deal,
  onFlagChange,
  canEdit = false,
  onSave,
}: {
  deal: Deal;
  /**
   * Agent-side deal flags. `financingType` (#451) accepts an explicit `null`
   * to clear a mis-clicked answer back to "unknown" — which re-engages the
   * pre-approval gate, the safe direction.
   */
  onFlagChange?: (flags: {
    preApproved?: boolean;
    financingType?: 'cash' | 'loan' | null;
  }) => void;
  /** Owning agent only — shows the Edit / Archive affordances (#254). */
  canEdit?: boolean;
  /** PATCH /api/deals/[id] with the given fields. */
  onSave?: (patch: DealEdit) => Promise<void>;
}) {
  const preApproved = deal.preApproved ?? false;
  const [editing, setEditing] = useState(false);

  async function archive() {
    if (!onSave) return;
    if (!window.confirm("Archive this deal? It leaves your pipeline but stays viewable, with its history intact.")) {
      return;
    }
    await onSave({ status: "archived" });
  }

  /**
   * The way back (#417). The Status dropdown inside the Edit Deal modal could
   * always do this, but a closed deal now has a one-click reversal on the same
   * row the Archive link lived on — otherwise "archived" reads as permanent.
   */
  async function reactivate() {
    if (!onSave) return;
    if (!window.confirm("Reactivate this deal? It returns to your active pipeline.")) {
      return;
    }
    await onSave({ status: "active" });
  }

  return (
    <div className={`rounded-xl bg-white shadow-sm border-t-4 ${HEALTH_BORDER[deal.health]} px-5 py-4`}>
      {editing && onSave && (
        <EditDealModal
          deal={deal}
          onCancel={() => setEditing(false)}
          onSave={async (patch) => {
            await onSave(patch);
            setEditing(false);
          }}
        />
      )}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl font-bold text-brand-navy">{deal.clientName}</h1>
            {deal.status === 'archived' && (
              <span className="rounded-full bg-gray-100 border border-gray-200 px-2.5 py-0.5 text-[11px] font-bold text-gray-500 uppercase tracking-wide">
                Archived
              </span>
            )}
            {deal.status === 'fallen_through' && (
              <span className="rounded-full bg-red-50 border border-red-200 px-2.5 py-0.5 text-[11px] font-bold text-red-600 uppercase tracking-wide">
                Fell Through
              </span>
            )}
            {/* #409 — the buyer's own onboarding answer. Without this the
                agent has no way to know why the pre-approval pill next to it
                doesn't gate this buyer's offers.
                #451 — and it is CORRECTABLE now: a buyer who mis-clicked
                "💰 Cash purchase" unlocked their own offer CTA permanently,
                and the only undo used to be editing JSON in the database.
                Read-only badge for anyone who can't write the deal's flags. */}
            {deal.type === 'buy' && (onFlagChange ? (
              <label className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-bold text-gray-600 focus-within:border-brand-navy">
                <Banknote size={12} className={deal.financingType === 'cash' ? 'text-green-600' : 'text-gray-400'} />
                <select
                  aria-label="Financing"
                  value={deal.financingType ?? ''}
                  onChange={(e) =>
                    onFlagChange({
                      financingType:
                        e.target.value === '' ? null : (e.target.value as 'cash' | 'loan'),
                    })
                  }
                  className="cursor-pointer bg-transparent text-xs font-bold outline-none"
                >
                  <option value="">Financing?</option>
                  <option value="cash">Cash Buyer</option>
                  <option value="loan">Financed</option>
                </select>
              </label>
            ) : deal.financingType === 'cash' && (
              <span className="flex items-center gap-1.5 rounded-full border border-green-200 bg-green-100 px-3 py-1 text-xs font-bold text-green-700">
                <Banknote size={12} /> Cash Buyer
              </span>
            ))}
            {deal.type === 'buy' && (
              <button
                onClick={() => onFlagChange?.({ preApproved: !preApproved })}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold transition-all border ${
                  preApproved
                    ? 'bg-green-100 text-green-700 border-green-200 hover:bg-green-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'
                }`}
              >
                {preApproved ? <CheckCircle2 size={12} /> : <Circle size={12} />}
                {preApproved ? 'Pre-Approved ✓' : 'Pre-approved?'}
              </button>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-sm text-gray-400">
            <MapPin size={13} />
            <span className="truncate">{deal.property.address}, {deal.property.city}, {deal.property.state} {deal.property.zip}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-3 py-1 text-sm font-semibold ${HEALTH_BADGE[deal.health]}`}>
              {STAGE_LABELS[deal.stage]}
            </span>
            <span className="rounded-full bg-brand-navy/10 px-3 py-1 text-sm font-medium text-brand-navy capitalize">
              {deal.type === 'buy' ? 'Purchase' : 'Listing'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {deal.fastPass?.status === 'active' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-green-100 border border-green-200 px-2 py-0.5 text-[11px] font-bold text-green-700">
                <Zap size={10} /> Fast Pass
              </span>
            )}
            {deal.smoothExit?.status === 'active' && (
              <span className="rounded-full bg-purple-100 border border-purple-200 px-2 py-0.5 text-[11px] font-bold text-purple-700">
                Smooth Exit
              </span>
            )}
          </div>
        </div>
      </div>
      {deal.timeline.closingDate && (
        <div className="mt-2 flex items-center gap-1 text-xs text-gray-400">
          <Calendar size={11} />
          <span>Closing {deal.timeline.closingDate}</span>
          <ClosingDaysBadge closingDate={deal.timeline.closingDate} />
          <span className="mx-1">·</span>
          <Clock size={11} />
          <span>{deal.timeline.daysInStage} days in current stage</span>
        </div>
      )}
      {canEdit && onSave && (
        <div className="mt-3 flex items-center gap-3 border-t border-gray-100 pt-2.5">
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-brand-navy transition-colors"
          >
            <Pencil size={12} /> Edit details
          </button>
          {deal.status === 'active' ? (
            <button
              onClick={archive}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-red-600 transition-colors"
            >
              <Archive size={12} /> Archive deal
            </button>
          ) : (
            <button
              onClick={reactivate}
              className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-brand-navy transition-colors"
            >
              <RotateCcw size={12} /> Reactivate deal
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Edit modal ──────────────────────────────────────────────────────────────

function EditDealModal({
  deal,
  onCancel,
  onSave,
}: {
  deal: Deal;
  onCancel: () => void;
  onSave: (patch: DealEdit) => Promise<void>;
}) {
  const [title, setTitle] = useState(deal.clientName);
  const [address, setAddress] = useState(deal.property.address === 'TBD' ? '' : deal.property.address);
  const [price, setPrice] = useState(deal.property.price ? String(deal.property.price) : '');
  const [status, setStatus] = useState<DealStatus>(deal.status);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const patch: DealEdit = {};
    const t = title.trim();
    if (t && t !== deal.clientName) patch.title = t;
    const a = address.trim();
    if (a !== (deal.property.address === 'TBD' ? '' : deal.property.address)) patch.address = a;
    const p = Number(price);
    if (price.trim() !== '' && Number.isFinite(p) && p !== deal.property.price) patch.price = p;
    if (status !== deal.status) patch.status = status;
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      await onSave(patch);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-brand-navy">Edit deal</h2>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-semibold text-gray-500">Client name</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-gray-500">Property address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-gray-500">Price</span>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold text-gray-500">Status</span>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as DealStatus)}
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="fallen_through">Fell through</option>
            </select>
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-gray-500 hover:text-brand-navy transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={saving}
            className="rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand-navy/90 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
