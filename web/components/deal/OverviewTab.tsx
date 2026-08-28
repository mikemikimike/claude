"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Deal, LoanMilestones, Task } from "@/lib/types";
import { api } from "@/lib/api-client";
import { formatMoney } from "@/lib/deal-money";
import { useAuthStore } from "@/lib/store/authStore";
import { BUYER_STATUS_STEPS } from "@/lib/buyer-status";
import { useParticipants } from "@/hooks/useParticipants";
import { useProperties, TrackedProperty, PropertyStatus } from "@/hooks/useProperties";
import { useShowingAvailability, DAYS_OF_WEEK, ShowingSlot, DayOfWeek } from "@/hooks/useShowingAvailability";
import { useOffers } from "@/hooks/useOffers";
import { useNetSheet, NetSheetLine, recalcLines, calcNetProceeds } from "@/hooks/useNetSheet";
import { AddCustomLineControl } from "@/components/net-sheet/AddCustomLineControl";
import { useContingencies, ContingencyStatus } from "@/hooks/useContingencies";
import { AddContingencyForm } from "@/components/contingencies/AddContingencyForm";
import Image from "next/image";
import IntakeCard from "@/components/intake/IntakeCard";
import PropertyInsights from "@/components/deal/PropertyInsights";
import DealInviteModal from "@/components/DealInviteModal";
import { Calendar, CheckCircle2, Circle, AlertCircle, Loader2, MessageSquare, Zap, ChevronDown, Mail, RefreshCw, Pencil, Plus, X, Star, Users, ExternalLink, Home, Link as LinkIcon, Lock, DollarSign, LogOut, Shield, ShieldCheck, ShieldOff } from "lucide-react";
import { STAGE_LABELS, FLAG_LABELS } from "@/components/deal/shared";
// #426 — the agent's enrollment cards resolve add-on ids to names/prices through
// these display modules, which derive their dollars from the shared catalogs.
// Never hand-type a price here: that is exactly how displayed copy drifts from
// what Stripe charges (#78/#430).
import { fastPassUpsellsFor, fastPassPaymentOptionLabel } from "@/lib/fast-pass-display";
import {
  smoothExitUpsellsFor,
  smoothExitPaymentOptionLabel,
  NEXT_STEP_LABELS,
} from "@/lib/smooth-exit-display";

function SellerShowingAvailabilityCard({ dealId }: { dealId: string }) {
  const { slots: availability, saveSlots } = useShowingAvailability(dealId);
  const [editing, setEditing] = useState(false);
  const [enabled, setEnabled] = useState<Set<DayOfWeek>>(new Set());
  const [times, setTimes] = useState<Record<DayOfWeek, { from: string; to: string }>>({
    Mon: { from: '09:00', to: '18:00' }, Tue: { from: '09:00', to: '18:00' },
    Wed: { from: '09:00', to: '18:00' }, Thu: { from: '09:00', to: '18:00' },
    Fri: { from: '09:00', to: '18:00' }, Sat: { from: '10:00', to: '15:00' },
    Sun: { from: '12:00', to: '15:00' },
  });

  const TIME_OPTIONS = [
    '07:00','08:00','09:00','10:00','11:00','12:00',
    '13:00','14:00','15:00','16:00','17:00','18:00','19:00','20:00',
  ];

  function fmt(t: string) {
    const [h] = t.split(':');
    const n = parseInt(h);
    return n === 12 ? '12pm' : n > 12 ? `${n - 12}pm` : `${n}am`;
  }

  function toggleDay(day: DayOfWeek) {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day); else next.add(day);
      return next;
    });
  }

  async function save() {
    const newSlots: ShowingSlot[] = DAYS_OF_WEEK
      .filter((d) => enabled.has(d))
      .map((d) => ({ day: d, from: times[d].from, to: times[d].to }));
    await saveSlots(newSlots).catch(() => {});
    setEditing(false);
  }

  function startEdit() {
    setEnabled(new Set(availability.map((s) => s.day)));
    const curr: Record<DayOfWeek, { from: string; to: string }> = {
      Mon: { from: '09:00', to: '18:00' }, Tue: { from: '09:00', to: '18:00' },
      Wed: { from: '09:00', to: '18:00' }, Thu: { from: '09:00', to: '18:00' },
      Fri: { from: '09:00', to: '18:00' }, Sat: { from: '10:00', to: '15:00' },
      Sun: { from: '12:00', to: '15:00' },
    };
    for (const slot of availability) {
      curr[slot.day] = { from: slot.from, to: slot.to };
    }
    setTimes(curr);
    setEditing(true);
  }

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Calendar size={14} className="text-brand-navy" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Showing Availability</h3>
        </div>
        {!editing && (
          <button
            onClick={startEdit}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <Pencil size={11} /> {availability.length > 0 ? 'Edit' : 'Set'}
          </button>
        )}
      </div>

      {!editing ? (
        availability.length === 0 ? (
          <div className="px-5 py-4 text-center">
            <p className="text-sm text-gray-400">No availability set by seller yet.</p>
            <button
              onClick={startEdit}
              className="mt-2 rounded-lg bg-brand-navy px-4 py-2 text-xs font-bold text-white hover:bg-brand-navy/80 transition-colors"
            >
              Set for them
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {availability.map((slot) => (
              <div key={slot.day} className="flex items-center justify-between px-5 py-2.5">
                <span className="text-sm font-semibold text-brand-navy w-10">{slot.day}</span>
                <span className="text-sm text-gray-500">{fmt(slot.from)} – {fmt(slot.to)}</span>
              </div>
            ))}
          </div>
        )
      ) : (
        <div className="px-5 py-4 space-y-3">
          {DAYS_OF_WEEK.map((day) => {
            const on = enabled.has(day);
            return (
              <div key={day} className={`rounded-xl border transition-all ${on ? 'border-brand-navy/20 bg-brand-navy/5' : 'border-gray-100 bg-gray-50'}`}>
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <button
                    onClick={() => toggleDay(day)}
                    className={`flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${on ? 'bg-brand-navy' : 'bg-gray-200'}`}
                  >
                    <span className={`ml-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
                  </button>
                  <span className={`flex-1 text-sm font-semibold ${on ? 'text-brand-navy' : 'text-gray-400'}`}>{day}</span>
                  {on && (
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <select
                        value={times[day].from}
                        onChange={(e) => setTimes((p) => ({ ...p, [day]: { ...p[day], from: e.target.value } }))}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-brand-navy outline-none"
                      >
                        {TIME_OPTIONS.map((t) => <option key={t} value={t}>{fmt(t)}</option>)}
                      </select>
                      <span>to</span>
                      <select
                        value={times[day].to}
                        onChange={(e) => setTimes((p) => ({ ...p, [day]: { ...p[day], to: e.target.value } }))}
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-brand-navy outline-none"
                      >
                        {TIME_OPTIONS.map((t) => <option key={t} value={t}>{fmt(t)}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => setEditing(false)}
              className="flex-1 rounded-xl border border-gray-200 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="flex-1 rounded-xl bg-brand-navy py-2 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Seller: Offer Management ─────────────────────────────────────────────────

const CONTINGENCY_OPTIONS = ['Inspection', 'Financing', 'Appraisal', 'Sale of Home'];

function SellerOffersCard({ dealId }: { dealId: string }) {
  const { offers, addOffer, removeOffer } = useOffers(dealId);
  const [showForm, setShowForm] = useState(false);
  const [buyerName, setBuyerName] = useState('');
  const [offerPrice, setOfferPrice] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [contingencies, setContingencies] = useState<string[]>([]);
  const [agentNotes, setAgentNotes] = useState('');

  function toggleContingency(c: string) {
    setContingencies((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );
  }

  async function handleAdd() {
    if (!buyerName.trim() || !offerPrice) return;
    await addOffer({
      buyerName: buyerName.trim(),
      offerPrice: parseInt(offerPrice.replace(/\D/g, ''), 10) || 0,
      closeDate: closeDate || undefined,
      contingencies,
      agentNotes: agentNotes.trim(),
    }).catch(() => {});
    setBuyerName(''); setOfferPrice(''); setCloseDate('');
    setContingencies([]); setAgentNotes('');
    setShowForm(false);
  }

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <DollarSign size={14} className="text-brand-navy" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">
            Offers ({offers.length})
          </h3>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1 rounded-lg bg-brand-navy px-2.5 py-1.5 text-xs font-bold text-white hover:bg-brand-navy/80 transition-colors"
        >
          <Plus size={11} /> Add Offer
        </button>
      </div>

      {showForm && (
        <div className="px-5 py-4 bg-blue-50/40 border-b border-gray-100 space-y-3">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Buyer Name <span className="text-red-400">*</span></label>
            <input
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              placeholder="e.g. The Johnson Family"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy placeholder:text-gray-300"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Offer Price <span className="text-red-400">*</span></label>
            <input
              value={offerPrice}
              onChange={(e) => setOfferPrice(e.target.value)}
              placeholder="$385,000"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy placeholder:text-gray-300"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Close Date</label>
            <input
              type="date"
              value={closeDate}
              onChange={(e) => setCloseDate(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Contingencies</label>
            <div className="flex flex-wrap gap-2">
              {CONTINGENCY_OPTIONS.map((c) => (
                <button
                  key={c}
                  onClick={() => toggleContingency(c)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${
                    contingencies.includes(c)
                      ? 'border-brand-navy bg-brand-navy text-white'
                      : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Agent Notes (visible to seller)</label>
            <textarea
              value={agentNotes}
              onChange={(e) => setAgentNotes(e.target.value)}
              placeholder="Notes about this offer for the seller..."
              rows={2}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy resize-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setShowForm(false)}
              className="flex-1 rounded-lg border border-gray-200 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={!buyerName.trim() || !offerPrice}
              className="flex-1 rounded-lg bg-brand-navy py-2 text-sm font-bold text-white disabled:opacity-40 hover:bg-brand-navy/90 transition-colors"
            >
              Add Offer
            </button>
          </div>
        </div>
      )}

      {offers.length === 0 && !showForm ? (
        <div className="px-5 py-6 text-center">
          <p className="text-sm text-gray-400">No offers added yet.</p>
          <p className="text-xs text-gray-300 mt-0.5">Add offers here — they&apos;ll appear on the seller&apos;s portal.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-50">
          {offers.map((offer) => (
            <div key={offer.id} className="px-5 py-4">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1">
                  <p className="text-base font-black text-brand-navy">${offer.offerPrice.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">{offer.buyerName}{offer.closeDate ? ` · Close ${offer.closeDate}` : ''}</p>
                  {offer.contingencies.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {offer.contingencies.map((c) => (
                        <span key={c} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">{c}</span>
                      ))}
                    </div>
                  )}
                  {offer.agentNotes && (
                    <p className="text-xs text-gray-500 italic mt-1.5 leading-relaxed">&quot;{offer.agentNotes}&quot;</p>
                  )}
                </div>
                <button
                  onClick={() => removeOffer(offer.id)}
                  className="text-gray-300 hover:text-red-400 transition-colors flex-shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Seller: Buyer Status Setter ──────────────────────────────────────────────

/**
 * Agent-set "Buyer's Progress" (#184). Persisted server-side via
 * PATCH /api/deals/:id/buyer-status so the seller portal (a different
 * session) reads the same value from /api/me/deals — never a client store.
 */
export function SellerBuyerStatusCard({ deal, onRefresh }: { deal: Deal; onRefresh?: () => void }) {
  // Local echo of the last save so the select reflects the choice
  // immediately; null = show the server value from the deal payload.
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const current = pendingStatus ?? deal.buyerStatus ?? '';

  const save = async (value: string) => {
    setPendingStatus(value);
    setSaving(true);
    setSaveError(null);
    try {
      await api.patch(`/deals/${deal.id}/buyer-status`, { buyer_status: value || null });
      onRefresh?.();
    } catch {
      setSaveError('Could not save — try again.');
      setPendingStatus(null); // revert to the last persisted value
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-gray-100">
        <CheckCircle2 size={14} className="text-brand-navy" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Buyer&apos;s Progress</h3>
      </div>
      <div className="px-5 py-4">
        <p className="text-xs text-gray-400 mb-2">Set the buyer&apos;s current status — this shows up on the seller&apos;s portal.</p>
        <select
          value={current}
          disabled={saving}
          onChange={(e) => void save(e.target.value)}
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-brand-navy outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10 disabled:opacity-60"
        >
          <option value="">— Not set —</option>
          {BUYER_STATUS_STEPS.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        {saveError && (
          <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-red-50 border border-red-100 px-3 py-2">
            <AlertCircle size={12} className="text-red-500" />
            <span className="text-xs font-semibold text-red-700">{saveError}</span>
          </div>
        )}
        {current && !saveError && (
          <div className="mt-2.5 flex items-center gap-2 rounded-lg bg-green-50 border border-green-100 px-3 py-2">
            <CheckCircle2 size={12} className="text-green-500" />
            <span className="text-xs font-semibold text-green-700">Currently showing: {current}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Seller: Net Sheet Editor ─────────────────────────────────────────────────

function printNetSheet(deal: { clientName: string; property: { address: string } }, lines: NetSheetLine[], salePrice: number, netProceeds: number, closingDate: string | null) {
  const enabledLines = lines.filter((l) => l.enabled);
  const fmt = (n: number) => `$${Math.abs(n).toLocaleString()}`;
  const rows = enabledLines.map((l) => `
    <tr>
      <td style="padding:6px 0;color:#555;font-size:13px;">${l.label}${l.isPct && l.pct ? ` (${l.pct}%)` : ''}</td>
      <td style="padding:6px 0;text-align:right;color:#222;font-size:13px;">-${fmt(l.amount)}</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html><head><title>Net Sheet — ${deal.clientName}</title>
  <style>body{font-family:Arial,sans-serif;max-width:600px;margin:40px auto;color:#222;}
  h1{font-size:22px;color:#1a2e4a;margin-bottom:4px;}
  .sub{font-size:13px;color:#777;margin-bottom:24px;}
  table{width:100%;border-collapse:collapse;}
  .divider{border-top:2px solid #1a2e4a;margin:8px 0;}
  .net{font-size:18px;font-weight:bold;color:#1a2e4a;}
  @media print{@page{margin:1in}}
  </style></head><body>
  <h1>Estimated Net Sheet</h1>
  <p class="sub">${deal.clientName} · ${deal.property.address}${closingDate ? ' · Closing ' + closingDate : ''}</p>
  <table>
    <tr><td style="padding:6px 0;font-size:13px;color:#555;">Sale Price</td>
        <td style="padding:6px 0;text-align:right;font-size:13px;color:#222;">+${fmt(salePrice)}</td></tr>
    ${rows}
    <tr><td colspan="2" class="divider"></td></tr>
    <tr><td style="padding:8px 0;" class="net">Estimated Net Proceeds</td>
        <td style="padding:8px 0;text-align:right;" class="net">${fmt(netProceeds)}</td></tr>
  </table>
  <p style="margin-top:32px;font-size:11px;color:#aaa;">Generated by RealTourFlow · Estimate only — actual figures provided by title at closing.</p>
  </body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.onload = () => w.print();
}

function SellerNetSheetCard({ deal }: { deal: import("@/lib/types").Deal }) {
  const { sheet, loading, saveSheet, markReady } = useNetSheet(deal.id);
  const [lines, setLines] = useState<NetSheetLine[]>([]);
  // The net sheet is an editable worksheet, not a report: an unknown deal
  // price (#411) seeds the field at 0 for the agent to type over, which is
  // what it has always done — the arithmetic below needs a number.
  const [salePrice, setSalePrice] = useState(deal.property.price ?? 0);
  const [closingDate, setClosingDate] = useState<string>(deal.timeline.closingDate ?? '');
  const [annualTaxes, setAnnualTaxes] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showOptional, setShowOptional] = useState(false);

  // React 19 pattern for "hydrate local form state from a fetched record":
  // compare to previous value during render and call setState before returning
  // JSX. Avoids the set-state-in-effect anti-pattern.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevSheet, setPrevSheet] = useState(sheet);
  if (sheet !== prevSheet) {
    setPrevSheet(sheet);
    if (sheet) {
      setSalePrice(sheet.salePrice || (deal.property.price ?? 0));
      setClosingDate(sheet.closingDate ?? deal.timeline.closingDate ?? '');
      setAnnualTaxes(sheet.annualTaxes);
      setLines(recalcLines(sheet.lines, sheet.salePrice || (deal.property.price ?? 0), sheet.annualTaxes, sheet.closingDate));
    }
  }

  const liveLines = recalcLines(lines, salePrice, annualTaxes, closingDate || null);
  const netProceeds = calcNetProceeds(liveLines, salePrice);
  const isReady = sheet?.status === 'ready';

  function updateLine(id: string, patch: Partial<NetSheetLine>) {
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, ...patch } : l));
  }

  async function handleSave() {
    if (!sheet) return;
    setSaving(true);
    try {
      await saveSheet({ ...sheet, salePrice, closingDate: closingDate || null, annualTaxes, lines: liveLines });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleReady() {
    await markReady(!isReady).catch(() => {});
  }

  const requiredLines = liveLines.filter((l) => l.required);
  const optionalLines = liveLines.filter((l) => !l.required);
  const enabledOptional = optionalLines.filter((l) => l.enabled).length;

  if (loading) return (
    <div className="rounded-xl bg-white shadow-sm p-8 flex justify-center">
      <Loader2 size={20} className="animate-spin text-brand-navy/40" />
    </div>
  );

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <DollarSign size={14} className="text-brand-navy" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Net Sheet</h3>
          {isReady && (
            <span className="flex items-center gap-1 rounded-full bg-green-100 border border-green-200 px-2 py-0.5 text-[10px] font-bold text-green-700">
              <CheckCircle2 size={9} /> Sent to Client
            </span>
          )}
        </div>
        {saved && <span className="text-xs font-semibold text-green-600 flex items-center gap-1"><CheckCircle2 size={11} /> Saved</span>}
      </div>

      <div className="px-5 py-4 space-y-4">
        {/* Sale price + closing date */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Sale Price</label>
            <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="text-sm text-gray-400">$</span>
              <input type="number" value={salePrice}
                onChange={(e) => setSalePrice(parseInt(e.target.value) || 0)}
                className="flex-1 text-sm outline-none bg-transparent text-brand-navy min-w-0" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Closing Date</label>
            <input type="date" value={closingDate}
              onChange={(e) => setClosingDate(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy" />
          </div>
          <div className="col-span-2">
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Annual Property Taxes (for proration)</label>
            <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <span className="text-sm text-gray-400">$</span>
              <input type="number" value={annualTaxes}
                onChange={(e) => setAnnualTaxes(parseInt(e.target.value) || 0)}
                placeholder="0"
                className="flex-1 text-sm outline-none bg-transparent text-brand-navy min-w-0" />
            </div>
          </div>
        </div>

        {/* Required lines */}
        <div className="space-y-2">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide">Deductions</p>
          {requiredLines.map((line) => (
            <NetSheetLineRow key={line.id} line={line} salePrice={salePrice}
              onChange={(patch) => updateLine(line.id, patch)} />
          ))}
        </div>

        {/* Optional lines */}
        <div>
          <button
            onClick={() => setShowOptional((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-brand-navy hover:text-brand-navy/70 transition-colors"
          >
            <ChevronDown size={13} className={`transition-transform ${showOptional ? 'rotate-180' : ''}`} />
            Optional lines {enabledOptional > 0 ? `(${enabledOptional} active)` : ''}
          </button>
          {showOptional && (
            <div className="mt-2 space-y-2">
              {optionalLines.map((line) => (
                <NetSheetLineRow key={line.id} line={line} salePrice={salePrice}
                  onChange={(patch) => updateLine(line.id, patch)} />
              ))}
              {/* Custom deduction lines the defaults don't cover (#181) */}
              <AddCustomLineControl onAdd={(line) => setLines((prev) => [...prev, line])} />
            </div>
          )}
        </div>

        {/* Net proceeds */}
        <div className="rounded-xl bg-brand-navy/5 border border-brand-navy/10 px-4 py-3 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-gray-500">
            <span>Sale Price</span>
            <span className="font-semibold text-brand-navy">+${salePrice.toLocaleString()}</span>
          </div>
          {liveLines.filter((l) => l.enabled && l.amount > 0).map((l) => (
            <div key={l.id} className="flex items-center justify-between text-xs">
              <span className="text-gray-500">{l.label}{l.isPct && l.pct ? ` (${l.pct}%)` : ''}</span>
              <span className="text-gray-600">-${l.amount.toLocaleString()}</span>
            </div>
          ))}
          <div className="border-t border-brand-navy/10 pt-2 flex items-center justify-between">
            <span className="text-sm font-bold text-brand-navy">Est. Net Proceeds</span>
            <span className={`text-xl font-black ${netProceeds >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              ${netProceeds.toLocaleString()}
            </span>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          <button onClick={handleSave} disabled={saving}
            className="flex-1 rounded-xl bg-brand-navy py-2.5 text-sm font-bold text-white hover:bg-brand-navy/90 disabled:opacity-50 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={handleToggleReady}
            className={`flex-1 rounded-xl py-2.5 text-sm font-bold transition-colors ${isReady
              ? 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              : 'bg-green-600 text-white hover:bg-green-700'}`}
          >
            {isReady ? 'Revert to Draft' : 'Ready to Send →'}
          </button>
        </div>
        {isReady && (
          <button
            onClick={() => printNetSheet(deal, liveLines, salePrice, netProceeds, closingDate || null)}
            className="w-full rounded-xl border border-brand-navy/20 py-2.5 text-sm font-semibold text-brand-navy hover:bg-brand-navy/5 transition-colors"
          >
            Download / Print PDF
          </button>
        )}
      </div>
    </div>
  );
}

function NetSheetLineRow({ line, salePrice, onChange }: {
  line: NetSheetLine;
  salePrice: number;
  onChange: (patch: Partial<NetSheetLine>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const equivPct = !line.isPct && salePrice > 0 ? ((line.amount / salePrice) * 100).toFixed(2) : null;
  const equivAmt = line.isPct && line.pct ? Math.round(salePrice * line.pct / 100) : null;

  return (
    <div className={`rounded-lg border transition-all ${line.enabled ? 'border-gray-200 bg-white' : 'border-gray-100 bg-gray-50 opacity-60'}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        {!line.required && (
          <button onClick={() => onChange({ enabled: !line.enabled })}
            className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded ${line.enabled ? 'bg-brand-navy' : 'border border-gray-300'}`}>
            {line.enabled && <CheckCircle2 size={10} className="text-white" />}
          </button>
        )}
        <span className="flex-1 text-xs text-gray-700 font-medium">{line.label}</span>
        {line.enabled && (
          <button onClick={() => setEditing((v) => !v)}
            className="text-[10px] text-gray-400 hover:text-brand-navy transition-colors font-semibold">
            {line.isPct ? `${line.pct}% = $${line.amount.toLocaleString()}` : `$${line.amount.toLocaleString()}`}
          </button>
        )}
      </div>
      {editing && line.enabled && line.editable && (
        <div className="px-3 pb-2.5 pt-0 space-y-2 border-t border-gray-100">
          {/* Pct / Fixed toggle for commission + transfer tax lines */}
          {(line.category === 'commission' || line.id === 'transfer_taxes') && (
            <div className="flex rounded-lg overflow-hidden border border-gray-200 text-[10px]">
              <button onClick={() => onChange({ isPct: true })}
                className={`flex-1 py-1 font-bold ${line.isPct ? 'bg-brand-navy text-white' : 'bg-white text-gray-500'}`}>
                %
              </button>
              <button onClick={() => onChange({ isPct: false })}
                className={`flex-1 py-1 font-bold ${!line.isPct ? 'bg-brand-navy text-white' : 'bg-white text-gray-500'}`}>
                $
              </button>
            </div>
          )}
          {line.isPct ? (
            <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1.5">
              <input type="number" step="0.25" value={line.pct ?? ''} min="0"
                onChange={(e) => onChange({ pct: parseFloat(e.target.value) || 0 })}
                className="flex-1 text-xs outline-none text-brand-navy" />
              <span className="text-xs text-gray-400">%{equivAmt !== null ? ` = $${equivAmt.toLocaleString()}` : ''}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1.5">
              <span className="text-xs text-gray-400">$</span>
              <input type="number" value={line.amount} min="0"
                onChange={(e) => onChange({ amount: parseInt(e.target.value) || 0 })}
                className="flex-1 text-xs outline-none text-brand-navy" />
              {equivPct && <span className="text-xs text-gray-400">≈ {equivPct}%</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Overview Tab ───────────────────────────────────────────────────────────

// ─── Confetti Celebration ────────────────────────────────────────────────────

const CONFETTI_COLORS = ['#FFD700', '#00C49F', '#1a2d5a', '#FF6B6B', '#4ECDC4', '#A78BFA'];


function ConfettiCelebration({ onDismiss }: { onDismiss: () => void }) {
  // useState lazy initializer runs ONCE per mount; React 19's purity rule
  // disallows Math.random() inside useMemo's compute fn since useMemo can
  // recompute. The lazy initializer pattern is the canonical fix.
  const [pieces] = useState(() =>
    Array.from({ length: 60 }, (_, i) => ({
      id: i,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 1.5}s`,
      duration: `${2.5 + Math.random() * 2}s`,
      size: `${6 + Math.random() * 8}px`,
      round: Math.random() > 0.5,
    }))
  );

  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="fixed inset-0 z-[9998] overflow-hidden">
      <style>{`
        @keyframes confetti-fall {
          0%   { transform: translateY(-20px) rotate(0deg);   opacity: 1; }
          100% { transform: translateY(105vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
      {/* Confetti pieces */}
      <div className="pointer-events-none absolute inset-0">
        {pieces.map((p) => (
          <div
            key={p.id}
            style={{
              position: 'absolute',
              left: p.left,
              top: 0,
              width: p.size,
              height: p.size,
              backgroundColor: p.color,
              borderRadius: p.round ? '50%' : '2px',
              animation: `confetti-fall ${p.duration} ${p.delay} ease-in forwards`,
            }}
          />
        ))}
      </div>
      {/* Backdrop + card */}
      <div className="absolute inset-0 bg-black/40 flex items-center justify-center px-4">
        <div className="rounded-2xl bg-white shadow-2xl px-8 py-8 text-center max-w-sm w-full">
          <div className="text-6xl mb-3">🎉</div>
          <h2 className="text-2xl font-black text-brand-navy">Congrats, Closing!</h2>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            The loan has funded. Another one in the books — great work!
          </p>
          <button
            onClick={onDismiss}
            className="mt-6 rounded-xl bg-brand-navy px-8 py-3 text-sm font-bold text-white hover:bg-brand-navy/90 transition-all active:scale-[0.98]"
          >
            Let&apos;s go! 🚀
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Loan Milestones Card ────────────────────────────────────────────────────

function LoanMilestonesCard({ deal, onRefresh }: { deal: Deal; onRefresh?: () => void }) {
  const [milestones, setMilestones] = useState<LoanMilestones | null>(
    deal.loanMilestones ?? null
  );
  const [showCelebration, setShowCelebration] = useState(false);
  const [ariveInput, setAriveInput] = useState('');
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState('');

  const isArive = milestones?.source === 'arive';
  const isLinked = deal.flags.includes('mountain_mortgage');

  async function handleLink() {
    if (!ariveInput.trim()) return;
    setLinking(true);
    setLinkError('');
    try {
      await api.patch(`/deals/${deal.id}/arive`, { arive_loan_id: ariveInput.trim() });
      onRefresh?.();
    } catch {
      setLinkError('Failed to link — check the loan ID and try again.');
    } finally {
      setLinking(false);
    }
  }

  async function handleForceSync() {
    try {
      await api.post(`/deals/${deal.id}/arive/sync`, {});
      onRefresh?.();
    } catch { /* ignore */ }
  }

  if (!milestones && deal.type === 'buy') {
    return (
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">Loan Milestones</h3>
        {isLinked ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <LinkIcon size={14} className="text-green-500" />
              <span>ARIVE loan linked — milestones syncing</span>
            </div>
            <button
              onClick={handleForceSync}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
            >
              <RefreshCw size={12} /> Sync
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400 leading-relaxed">
              Link an ARIVE loan ID to auto-sync Mountain Mortgage milestones. Leave blank for manual milestone tracking.
            </p>
            <div className="flex gap-2">
              <input
                value={ariveInput}
                onChange={(e) => setAriveInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLink()}
                placeholder="ARIVE loan ID"
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-navy/40 focus:ring-2 focus:ring-brand-navy/10"
              />
              <button
                onClick={handleLink}
                disabled={!ariveInput.trim() || linking}
                className="rounded-lg bg-brand-navy px-4 py-2 text-sm font-bold text-white disabled:opacity-40 hover:bg-brand-navy/90 transition-colors"
              >
                {linking ? 'Linking…' : 'Link'}
              </button>
            </div>
            {linkError && <p className="text-xs text-red-500">{linkError}</p>}
          </div>
        )}
      </div>
    );
  }

  if (!milestones) return null;

  type BoolKey = 'loanSetup' | 'disclosuresOut' | 'disclosuresSignedSubmitted' | 'approvedWithConditions' | 'resubmittal' | 'clearToClose';

  function toggle(key: BoolKey) {
    if (isArive) return;
    setMilestones((prev) => prev ? { ...prev, [key]: !prev[key] } : prev);
  }

  function setAppraisal(val: LoanMilestones['appraisal']) {
    if (isArive) return;
    setMilestones((prev) => prev ? { ...prev, appraisal: val } : prev);
  }

  function markFunded() {
    setMilestones((prev) => prev ? { ...prev, funded: true } : prev);
    setShowCelebration(true);
  }

  const ORDERED_MILESTONES: { key: BoolKey; label: string }[] = [
    { key: 'loanSetup',                  label: 'Loan Setup' },
    { key: 'disclosuresOut',             label: 'Disclosures Out' },
    { key: 'disclosuresSignedSubmitted', label: 'Disclosures Signed & Submitted to Underwriting' },
    { key: 'approvedWithConditions',     label: 'Approved with Conditions' },
    { key: 'resubmittal',                label: 'Resubmittal' },
    { key: 'clearToClose',               label: 'Clear to Close' },
  ];

  const APPRAISAL_BADGE: Record<string, string> = {
    pending:   'bg-gray-100 text-gray-500',
    ordered:   'bg-blue-100 text-blue-700',
    scheduled: 'bg-amber-100 text-amber-700',
    complete:  'bg-green-100 text-green-700',
  };

  const completedCount = ORDERED_MILESTONES.filter(({ key }) => milestones[key]).length;

  return (
    <>
      {showCelebration && <ConfettiCelebration onDismiss={() => setShowCelebration(false)} />}

      <div className="rounded-xl bg-white p-5 shadow-sm">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Loan Milestones</h3>
            <div className="mt-0.5 text-[11px] text-gray-400">{completedCount} of {ORDERED_MILESTONES.length} complete</div>
          </div>
          <div className="flex items-center gap-2">
            {milestones.funded && (
              <span className="rounded-full bg-green-500 px-2.5 py-0.5 text-[10px] font-black text-white tracking-wide uppercase">
                Funded ✓
              </span>
            )}
            {isArive ? (
              <button
                onClick={handleForceSync}
                title="Force sync from ARIVE"
                className="flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-[10px] font-bold text-green-700 hover:bg-green-200 transition-colors"
              >
                <RefreshCw size={9} /> ARIVE
              </button>
            ) : (
              <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[10px] font-bold text-amber-700">
                <Pencil size={9} /> Manual
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mb-4 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-green-400 transition-all duration-500"
            style={{ width: `${(completedCount / ORDERED_MILESTONES.length) * 100}%` }}
          />
        </div>

        {/* Ordered milestone list */}
        <div className="space-y-1 mb-4">
          {ORDERED_MILESTONES.map(({ key, label }, i) => {
            const done = milestones[key];
            const isNext = !done && ORDERED_MILESTONES.slice(0, i).every(({ key: k }) => milestones[k]);
            return (
              <button
                key={key}
                onClick={() => toggle(key)}
                disabled={isArive}
                className={[
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                  done ? 'bg-green-50' : isNext ? 'bg-blue-50/60' : 'bg-gray-50/60',
                  !isArive ? 'hover:opacity-80 cursor-pointer' : 'cursor-default',
                ].join(' ')}
              >
                <span className="flex-shrink-0">
                  {done
                    ? <CheckCircle2 size={16} className="text-green-500" />
                    : isNext
                    ? <Circle size={16} className="text-blue-400" />
                    : <Circle size={16} className="text-gray-300" />}
                </span>
                <span className={`flex-1 text-sm ${done ? 'text-green-700 font-medium' : isNext ? 'text-blue-700 font-medium' : 'text-gray-400'}`}>
                  {label}
                </span>
                {isNext && !isArive && (
                  <span className="flex-shrink-0 text-[10px] font-bold text-blue-500 uppercase tracking-wide">Up next</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Appraisal — separate, API-tracked */}
        <div className="border-t border-gray-50 pt-3 flex items-center justify-between gap-2">
          <div>
            <span className="text-xs font-semibold text-gray-500">Appraisal Status</span>
            <div className="text-[10px] text-gray-400 mt-0.5">Tracked via appraisal API</div>
          </div>
          <div className="flex items-center gap-2">
            {isArive ? (
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${APPRAISAL_BADGE[milestones.appraisal ?? 'pending']}`}>
                {milestones.appraisal ?? 'Pending'}
              </span>
            ) : (
              <select
                value={milestones.appraisal ?? 'pending'}
                onChange={(e) => setAppraisal(e.target.value as LoanMilestones['appraisal'])}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-brand-navy outline-none"
              >
                <option value="pending">Pending</option>
                <option value="ordered">Ordered</option>
                <option value="scheduled">Scheduled</option>
                <option value="complete">Complete</option>
              </select>
            )}
          </div>
        </div>

        {/* ARIVE raw tracker grid — only when synced from ARIVE */}
        {isArive && milestones.ariveTrackers && milestones.ariveTrackers.length > 0 && (
          <div className="mt-3 border-t border-gray-50 pt-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">ARIVE Trackers</p>
            <div className="grid grid-cols-2 gap-1.5">
              {milestones.ariveTrackers.map((t) => {
                const s = t.currentTrackerStatus?.status?.toLowerCase() ?? '';
                const isTrackerDone = s === 'completed';
                const isTrackerActive = s !== '' && s !== 'not_started' && !isTrackerDone;
                return (
                  <div
                    key={t.name}
                    className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[11px] ${
                      isTrackerDone ? 'bg-green-50' : isTrackerActive ? 'bg-blue-50' : 'bg-gray-50'
                    }`}
                  >
                    <span className={`font-medium ${isTrackerDone ? 'text-green-700' : isTrackerActive ? 'text-blue-700' : 'text-gray-400'}`}>
                      {t.name.replace(/_/g, ' ')}
                    </span>
                    <span className={`text-[9px] font-bold uppercase ${isTrackerDone ? 'text-green-600' : isTrackerActive ? 'text-blue-500' : 'text-gray-300'}`}>
                      {t.currentTrackerStatus?.status?.replace(/_/g, ' ') || '—'}
                    </span>
                  </div>
                );
              })}
            </div>
            {milestones.ariveLoanStatus && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[10px] text-gray-400">Loan Status:</span>
                <span className="text-[10px] font-bold text-brand-navy uppercase tracking-wide">
                  {milestones.ariveLoanStatus.replace(/_/g, ' ')}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Mark as Funded — manual mode only, shown when CTC is done */}
        {!isArive && milestones.clearToClose && !milestones.funded && (
          <button
            onClick={markFunded}
            className="mt-3 w-full rounded-xl bg-green-500 py-2.5 text-sm font-bold text-white hover:bg-green-600 transition-colors"
          >
            🎉 Mark as Funded
          </button>
        )}
      </div>
    </>
  );
}

// ─── Property Tracking Card (agent side) ────────────────────────────────────

const AGENT_STATUS_CONFIG: Record<PropertyStatus, { label: string; style: string }> = {
  interested:       { label: 'Interested',       style: 'bg-blue-100 text-blue-700' },
  toured:           { label: 'Toured',           style: 'bg-purple-100 text-purple-700' },
  not_for_me:       { label: 'Not for me',       style: 'bg-gray-100 text-gray-400' },
  offer_submitted:  { label: 'Offer Submitted',  style: 'bg-green-100 text-green-700' },
};

function AgentPropertyRow({ prop, onRemove, onUpdateAgentNote }: { prop: TrackedProperty; onRemove: () => void; onUpdateAgentNote: (id: string, note: string) => void }) {
  const [imgErr, setImgErr] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(prop.agentPrivateNote ?? '');
  const cfg = AGENT_STATUS_CONFIG[prop.status];

  function saveNote() {
    onUpdateAgentNote(prop.id, noteDraft.trim());
    setNoteOpen(false);
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${prop.status === 'not_for_me' ? 'opacity-50 border-gray-100' : prop.offerRequested ? 'border-amber-300' : 'border-gray-100'}`}>
      {/* Offer request alert */}
      {prop.offerRequested && (
        <div className="flex items-center gap-2 bg-amber-50 border-b border-amber-200 px-3 py-2">
          <Star size={13} className="text-amber-500 flex-shrink-0" />
          <p className="text-xs font-bold text-amber-800">
            Buyer wants to make an offer on {prop.address}
          </p>
        </div>
      )}

      <div className="flex items-start gap-3 bg-gray-50 p-3">
        {/* Thumbnail */}
        <div className="h-14 w-14 flex-shrink-0 rounded-lg overflow-hidden bg-gray-200 flex items-center justify-center">
          {prop.thumbnailUrl && !imgErr ? (
            <Image src={prop.thumbnailUrl} alt="" width={56} height={56} unoptimized className="h-full w-full object-cover" onError={() => setImgErr(true)} />
          ) : (
            <Home size={20} className="text-gray-400" />
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold text-brand-navy truncate">{prop.address}</p>
            {prop.addedBy === 'agent' && (
              <span className="flex-shrink-0 rounded-full bg-brand-navy/10 px-1.5 py-0.5 text-[9px] font-bold text-brand-navy uppercase tracking-wide">You</span>
            )}
          </div>
          <p className="text-xs text-gray-400 truncate">{prop.city}{prop.state ? `, ${prop.state}` : ''}{prop.price > 0 ? ` · $${prop.price.toLocaleString()}` : ''}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${cfg.style}`}>{cfg.label}</span>
            {(prop.beds > 0 || prop.sqft > 0) && (
              <span className="text-[10px] text-gray-400">{prop.beds > 0 ? `${prop.beds}bd · ${prop.baths}ba` : ''}{prop.sqft > 0 ? ` · ${prop.sqft.toLocaleString()} sqft` : ''}</span>
            )}
          </div>

          {/* Agent's push note */}
          {prop.agentNote && (
            <p className="mt-1 text-[10px] text-amber-700 italic">&quot;{prop.agentNote}&quot;</p>
          )}

          {/* Buyer's thoughts */}
          {prop.buyerNote && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-purple-50 border border-purple-100 px-2 py-1.5">
              <MessageSquare size={10} className="text-purple-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-[9px] font-bold text-purple-400 uppercase tracking-wide mb-0.5">Buyer&apos;s thoughts</p>
                <p className="text-[11px] text-purple-700 leading-snug">{prop.buyerNote}</p>
              </div>
            </div>
          )}

          {/* Agent private note */}
          {!noteOpen && (
            <button
              onClick={() => setNoteOpen(true)}
              className="mt-1.5 flex items-center gap-1 text-[10px] text-gray-400 hover:text-brand-navy transition-colors"
            >
              <Pencil size={9} />
              {prop.agentPrivateNote ? 'Edit private note' : 'Add private note'}
            </button>
          )}
        </div>

        {/* Actions */}
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          {prop.sourceUrl && (
            <a href={prop.sourceUrl} target="_blank" rel="noopener noreferrer"
              className="text-gray-400 hover:text-brand-navy transition-colors">
              <ExternalLink size={13} />
            </a>
          )}
          <button onClick={onRemove} className="text-gray-300 hover:text-red-400 transition-colors">
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Private note (shown) */}
      {prop.agentPrivateNote && !noteOpen && (
        <div className="border-t border-gray-100 bg-white px-3 py-2 flex items-start gap-1.5">
          <Lock size={9} className="text-gray-300 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-gray-500 italic leading-snug">{prop.agentPrivateNote}</p>
        </div>
      )}

      {/* Private note editor */}
      {noteOpen && (
        <div className="border-t border-gray-100 bg-white px-3 py-3 space-y-2">
          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <Lock size={9} /> Private note (only you see this)
          </p>
          <textarea
            autoFocus
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Your internal notes on this property…"
            rows={2}
            className="w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs text-gray-700 outline-none focus:border-brand-navy/30 resize-none"
          />
          <div className="flex gap-2">
            <button onClick={saveNote}
              className="flex-1 rounded-lg bg-brand-navy py-1.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors">
              Save
            </button>
            <button onClick={() => { setNoteOpen(false); setNoteDraft(prop.agentPrivateNote ?? ''); }}
              className="rounded-lg border border-gray-200 px-3 text-xs text-gray-500 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Property AI insights — comp range + photo tags (#376) */}
      <PropertyInsights prop={prop} />
    </div>
  );
}

function PropertyTrackingCard({ deal }: { deal: Deal }) {
  const { properties, addProperty, removeProperty, updateAgentNote } = useProperties(deal.id);

  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState('');
  const [address, setAddress] = useState('');
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');

  async function handleAdd() {
    const trimAddr = address.trim();
    if (!trimAddr) return;
    const parts = trimAddr.split(',').map((s) => s.trim());
    await addProperty({
      dealId: deal.id,
      address: parts[0] ?? trimAddr,
      city: parts[1] ?? '',
      state: parts[2] ?? '',
      price: parseInt(price.replace(/\D/g, ''), 10) || 0,
      beds: 0,
      baths: 0,
      sqft: 0,
      thumbnailUrl: '',
      sourceUrl: url.trim(),
      status: 'interested',
      addedBy: 'agent',
      agentNote: note.trim() || undefined,
    }).catch(() => {});
    setUrl(''); setAddress(''); setPrice(''); setNote('');
    setShowForm(false);
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Property Tracker</h3>
          <p className="text-[11px] text-gray-400 mt-0.5">{properties.length} propert{properties.length === 1 ? 'y' : 'ies'} tracked</p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors"
        >
          <Plus size={13} />
          Push to buyer
        </button>
      </div>

      {/* Add form */}
      {showForm && (
        <div className="mb-4 rounded-xl border border-brand-navy/10 bg-blue-50/40 p-4 space-y-2.5">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Listing URL (MLS / Zillow / Realtor)</label>
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
              <LinkIcon size={13} className="text-gray-400 flex-shrink-0" />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.zillow.com/homedetails/..."
                className="flex-1 text-sm outline-none bg-transparent text-brand-navy placeholder:text-gray-300"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Address <span className="text-red-400">*</span></label>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="123 Main St, Birmingham, AL"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy placeholder:text-gray-300"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">List Price</label>
            <input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="$350,000"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy placeholder:text-gray-300"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wide mb-1">Note to buyer (optional)</label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Great neighborhood, matches your wishlist..."
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none text-brand-navy placeholder:text-gray-300"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={handleAdd}
              disabled={!address.trim()}
              className="flex-1 rounded-lg bg-brand-navy py-2 text-sm font-bold text-white disabled:opacity-40 hover:bg-brand-navy/90 transition-colors"
            >
              Push property →
            </button>
            <button
              onClick={() => { setShowForm(false); setUrl(''); setAddress(''); setPrice(''); setNote(''); }}
              className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Property list */}
      {properties.length > 0 ? (
        <div className="space-y-2">
          {properties.map((p) => (
            <AgentPropertyRow key={p.id} prop={p} onRemove={() => removeProperty(p.id)} onUpdateAgentNote={updateAgentNote} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <Home size={28} className="text-gray-200 mb-2" />
          <p className="text-sm font-medium text-gray-400">No properties tracked yet</p>
          <p className="text-xs text-gray-300 mt-0.5">Push a listing to start your buyer&apos;s property list</p>
        </div>
      )}
    </div>
  );
}

function CommissionRateField({ deal, onUpdated }: { deal: Deal; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [pct, setPct] = useState(String(deal.commissionPct ?? 3));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    const val = parseFloat(pct);
    if (isNaN(val) || val <= 0 || val > 20) return;
    setSaving(true);
    try {
      await api.patch(`/deals/${deal.id}/commission`, { commission_pct: val });
      setEditing(false);
      setSaved(true);
      onUpdated();
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // keep editing open
    } finally {
      setSaving(false);
    }
  }

  const price = deal.property.price ?? 0;
  const previewCommission = Math.round(price * (parseFloat(pct) / 100));

  return (
    <>
      <div>
        <dt className="text-gray-400 text-xs flex items-center gap-1">
          Est. Commission
          {saved && <span className="text-green-600 text-[10px] font-semibold">Saved</span>}
        </dt>
        <dd className="font-semibold text-green-700 mt-0.5">
          {editing ? (
            <div className="flex items-center gap-1.5 mt-0.5">
              <input
                type="number"
                step="0.1"
                min="0.1"
                max="20"
                value={pct}
                onChange={(e) => setPct(e.target.value)}
                className="w-16 rounded border border-gray-300 px-1.5 py-0.5 text-xs text-brand-navy focus:outline-none focus:border-brand-navy"
                autoFocus
              />
              <span className="text-xs text-gray-400">%</span>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded bg-brand-navy px-2 py-0.5 text-[10px] font-semibold text-white disabled:opacity-50"
              >
                {saving ? '…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditing(false); setPct(String(deal.commissionPct ?? 3)); }}
                className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="group flex items-center gap-1 hover:text-green-800 transition-colors"
              title="Edit commission rate"
            >
              {formatMoney(deal.estimatedCommission)}
              <span className="text-[10px] font-normal text-gray-400 group-hover:text-green-700">
                ({deal.commissionPct ?? 3}%)
              </span>
              <Pencil size={10} className="text-gray-300 group-hover:text-green-600 transition-colors" />
            </button>
          )}
        </dd>
      </div>
      {editing && !isNaN(parseFloat(pct)) && price > 0 && (
        <div>
          <dt className="text-gray-400 text-xs">Preview at {pct}%</dt>
          <dd className="font-semibold text-green-600 mt-0.5">${previewCommission.toLocaleString()}</dd>
        </div>
      )}
    </>
  );
}

function InternalNotesCard({ deal }: { deal: Deal }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(deal.notes ?? '');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/deals/${deal.id}/notes`, { notes });
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Keep editing open on failure
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-50">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Internal Notes</h3>
          <span className="flex items-center gap-1 rounded-full bg-brand-navy/8 px-2 py-0.5 text-[10px] font-semibold text-brand-navy/50">
            <X size={9} strokeWidth={3} className="rotate-45" />
            Not visible to clients
          </span>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <Pencil size={11} /> Edit
          </button>
        )}
        {saved && (
          <span className="flex items-center gap-1 text-xs font-semibold text-green-600">
            <CheckCircle2 size={12} /> Saved
          </span>
        )}
      </div>
      <div className="px-5 py-4">
        {editing ? (
          <div className="space-y-3">
            <textarea
              autoFocus
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Add internal notes about this deal — visible only to agents, TCs, and admins..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-brand-navy placeholder-gray-300 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10 resize-none leading-relaxed"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setEditing(false)}
                className="flex-1 rounded-xl border border-gray-200 py-2 text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex-1 rounded-xl bg-brand-navy py-2 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save Notes'}
              </button>
            </div>
          </div>
        ) : (
          <p
            onClick={() => setEditing(true)}
            className={`text-sm leading-relaxed cursor-text rounded-lg px-1 py-0.5 hover:bg-gray-50 transition-colors ${
              notes ? 'text-gray-700' : 'text-gray-300 italic'
            }`}
          >
            {notes || 'No notes yet — click to add'}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Concierge enrollment cards (#426 — US-08 of epic #441) ──────────────────
//
// These are the agent's ONLY window into what their client bought. They are
// deliberately READ-ONLY: an agent editing a client's paid enrollment is a
// separate product decision, so nothing here posts, patches or deletes.

/** A label/value row in an enrollment's detail panel. Renders nothing at all
 *  for a blank answer — a survey field the client skipped should be absent, not
 *  an empty box or a dash the concierge has to interpret. */
function DetailRow({
  label,
  value,
  wide = false,
}: {
  label: string;
  value: string | null | undefined;
  wide?: boolean;
}) {
  if (!value) return null;
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">{label}</div>
      <div className="text-xs text-gray-600">{value}</div>
    </div>
  );
}

/** Survey answers are stored as raw option keys ("full_service", "3_bedroom").
 *  There is no shipped key→label map for most of them, so humanize rather than
 *  show a snake_case token to an agent. */
function humanizeAnswer(value: string | null | undefined): string | null {
  if (!value) return null;
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : null;
}

function formatEnrollmentDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  // A survey can persist "" or a half-typed date; `new Date` happily yields
  // Invalid Date, which renders as the literal text "Invalid Date".
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function FastPassCard({ deal }: { deal: Deal }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const fp = deal.fastPass;

  const STATUS_STYLES: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    pending_payment: 'bg-amber-100 text-amber-700',
    complete: 'bg-gray-100 text-gray-500',
    collected: 'bg-gray-100 text-gray-500',
  };
  const STATUS_LABELS: Record<string, string> = {
    active: 'Active',
    pending_payment: 'Awaiting payment',
    complete: 'Complete',
    collected: 'Collected',
  };

  if (fp) {
    const upsells = fastPassUpsellsFor(fp.selectedUpsells);
    const survey = fp.surveyAnswers;
    const enrolledOn = formatEnrollmentDate(fp.enrolledAt);
    const moveDate = formatEnrollmentDate(survey?.targetMoveDate);
    // `paid` and `status` are independent (see the type): an `at_closing`
    // enrollment is Active and unpaid for weeks, so the money line is its own
    // statement rather than something inferred from the status pill.
    const paidLabel = fp.paid
      ? 'Paid'
      : fp.status === 'pending_payment'
        ? 'Not paid yet'
        : 'Due at closing';

    return (
      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Fast Pass details"
          className="w-full px-5 py-4 text-left hover:bg-gray-50/70 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-100">
                <Zap size={16} className="text-green-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-brand-navy">Fast Pass</h3>
                {enrolledOn && (
                  <p className="text-[11px] text-gray-400">Enrolled {enrolledOn}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end gap-1">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_STYLES[fp.status] ?? 'bg-gray-100 text-gray-500'}`}>
                  {STATUS_LABELS[fp.status] ?? fp.status}
                </span>
                <span className="text-xs text-gray-400">
                  ${fp.totalPaid.toLocaleString()} total
                </span>
              </div>
              <ChevronDown
                size={16}
                className={`text-gray-300 transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-gray-400">Payment</span>
            <span className="font-semibold text-brand-navy">
              {fastPassPaymentOptionLabel(fp.paymentOption)}
            </span>
            <span className="text-gray-200">·</span>
            <span className={fp.paid ? 'font-semibold text-green-600' : 'font-semibold text-amber-600'}>
              {paidLabel}
            </span>
            {fp.promoCode && (
              <>
                <span className="text-gray-200">·</span>
                <span className="rounded-full bg-green-50 px-2 py-0.5 font-semibold text-green-700">
                  {fp.promoCode}
                  {fp.discountCents ? ` −$${Math.round(fp.discountCents / 100).toLocaleString()}` : ''}
                </span>
              </>
            )}
          </div>
        </button>

        {/* Add-ons: always visible. This is the question the agent actually
            walked in with, so it must not be hidden behind the expander. */}
        <div className="border-t border-gray-100 px-5 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Add-ons {upsells.length > 0 && `(${upsells.length})`}
          </div>
          {upsells.length === 0 ? (
            <p className="text-xs text-gray-300">No add-ons — base package only</p>
          ) : (
            <ul className="space-y-1">
              {upsells.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-gray-600">
                    <CheckCircle2 size={12} className="text-green-500 flex-shrink-0" />
                    {u.name}
                  </span>
                  <span className="text-xs font-semibold text-gray-400 flex-shrink-0">
                    ${u.price.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {/* List prices, not the agreed ones: the enrollment stores its own
              total (that is what Stripe charges), and a later repricing — #430
              moved three of these — must not silently restate what the client
              agreed to pay. */}
          <p className="mt-2 text-[10px] text-gray-300">
            Current list prices. The client&apos;s agreed total is ${fp.totalPaid.toLocaleString()}.
          </p>
        </div>

        {open && (
          <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Client&apos;s Fast Pass survey
            </div>
            {survey ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <DetailRow label="Situation" value={humanizeAnswer(survey.currentSituation)} />
                <DetailRow label="Target move date" value={moveDate} />
                <DetailRow label="Date flexibility" value={humanizeAnswer(survey.dateFlexibility)} />
                <DetailRow label="Move size" value={humanizeAnswer(survey.moveSize)} />
                <DetailRow label="Movers" value={humanizeAnswer(survey.moverPreference)} />
                <DetailRow label="Packing" value={humanizeAnswer(survey.packingPreference)} />
                <DetailRow
                  label="Utilities to transfer"
                  value={survey.utilities?.length ? survey.utilities.join(', ') : null}
                  wide
                />
                <DetailRow label="Notes" value={survey.notes} wide />
              </div>
            ) : (
              <p className="text-xs text-gray-400">
                No survey answers on file — this enrollment was created without the
                onboarding survey.
              </p>
            )}
            <p className="mt-3 text-[10px] text-gray-300">
              Read-only. Ask the client to update their enrollment from their portal.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-dashed border-green-200 bg-green-50/40 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-green-100">
          <Zap size={18} className="text-green-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-brand-navy">Fast Pass</h3>
          <p className="mt-0.5 text-xs text-gray-500 leading-relaxed">
            White-glove concierge from pre-approval to move-in. 10-day close track + Mountain Mortgage 2% refi credit.
          </p>
        </div>
      </div>
      <button
        onClick={() => router.push(`/fast-pass?dealId=${deal.id}`)}
        className="mt-3 w-full rounded-lg bg-green-500 py-2.5 text-sm font-bold text-white hover:bg-green-600 transition-colors"
      >
        Enroll in Fast Pass
      </button>
    </div>
  );
}

export function SmoothExitCard({ deal }: { deal: Deal }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const se = deal.smoothExit;

  const STATUS_STYLES: Record<string, string> = {
    active: 'bg-purple-100 text-purple-700',
    pending: 'bg-amber-100 text-amber-700',
    complete: 'bg-gray-100 text-gray-500',
  };

  if (se) {
    const upsells = smoothExitUpsellsFor(se.selectedUpsells ?? []);
    const survey = se.surveyAnswers;
    const enrolledOn = formatEnrollmentDate(se.enrolledAt);
    const moveOut = formatEnrollmentDate(survey?.moveOutDate);
    const nextStep = se.nextStep ?? survey?.nextStep;

    return (
      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Smooth Exit details"
          className="w-full px-5 py-4 text-left hover:bg-gray-50/70 transition-colors"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-100">
                <LogOut size={16} className="text-purple-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-brand-navy">Smooth Exit</h3>
                {enrolledOn && (
                  <p className="text-[11px] text-gray-400">Enrolled {enrolledOn}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end gap-1">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold capitalize ${STATUS_STYLES[se.status] ?? 'bg-gray-100 text-gray-500'}`}>
                  {se.status}
                </span>
                <span className="text-xs text-gray-400">${se.fee.toLocaleString()} · 1%</span>
              </div>
              <ChevronDown
                size={16}
                className={`text-gray-300 transition-transform ${open ? 'rotate-180' : ''}`}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-gray-400">Fee</span>
            <span className="font-semibold text-brand-navy">
              {smoothExitPaymentOptionLabel(se.paymentOption)}
            </span>
            {upsells.length > 0 && (
              <>
                <span className="text-gray-200">·</span>
                <span className={se.upsellsPaid ? 'font-semibold text-green-600' : 'font-semibold text-amber-600'}>
                  {se.upsellsPaid ? 'Add-ons paid' : 'Add-ons not paid'}
                </span>
              </>
            )}
          </div>
        </button>

        <div className="border-t border-gray-100 px-5 py-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            Add-ons {upsells.length > 0 && `(${upsells.length})`}
          </div>
          {upsells.length === 0 ? (
            <p className="text-xs text-gray-300">No add-ons — 1% concierge fee only</p>
          ) : (
            <ul className="space-y-1">
              {upsells.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-xs text-gray-600">
                    <CheckCircle2 size={12} className="text-purple-500 flex-shrink-0" />
                    {u.name}
                  </span>
                  <span className="text-xs font-semibold text-gray-400 flex-shrink-0">
                    ${u.price.toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {upsells.length > 0 && (
            <p className="mt-2 text-[10px] text-gray-300">
              Current list prices. The seller&apos;s agreed add-on total is $
              {Math.round((se.upsellTotalCents ?? 0) / 100).toLocaleString()}.
            </p>
          )}
        </div>

        {open && (
          <div className="border-t border-gray-100 bg-gray-50/60 px-5 py-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Seller&apos;s Smooth Exit survey
            </div>
            {survey || nextStep ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <DetailRow
                  label="What's next"
                  value={nextStep ? NEXT_STEP_LABELS[nextStep] : null}
                />
                <DetailRow label="Move-out" value={moveOut} />
                <DetailRow label="Movers" value={humanizeAnswer(survey?.moverPreference)} />
                <DetailRow
                  label="Wants deep clean"
                  value={survey?.wantsDeepClean == null ? null : survey.wantsDeepClean ? 'Yes' : 'No'}
                />
                <DetailRow
                  label="Utilities to transfer"
                  value={survey?.utilities?.length ? survey.utilities.join(', ') : null}
                  wide
                />
                <DetailRow label="Notes" value={survey?.notes} wide />
              </div>
            ) : (
              <p className="text-xs text-gray-400">
                No survey answers on file — this enrollment was created without the
                onboarding survey.
              </p>
            )}
            <p className="mt-3 text-[10px] text-gray-300">
              Read-only. Ask the client to update their enrollment from their portal.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border-2 border-dashed border-purple-200 bg-purple-50/40 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-purple-100">
          <LogOut size={18} className="text-purple-600" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-brand-navy">Smooth Exit</h3>
          <p className="mt-0.5 text-xs text-gray-500 leading-relaxed">
            Seller concierge: move-out coordination, repair bid management, disclosure tracking, and title support. 1% of sale price at closing.
          </p>
        </div>
      </div>
      <button
        onClick={() => router.push(`/smooth-exit?dealId=${deal.id}`)}
        className="mt-3 w-full rounded-lg bg-purple-600 py-2.5 text-sm font-bold text-white hover:bg-purple-700 transition-colors"
      >
        Enroll in Smooth Exit
      </button>
    </div>
  );
}

// ─── Contingencies Card (#186) ───────────────────────────────────────────────

const CONTINGENCY_BADGE: Record<ContingencyStatus, { style: string; label: string }> = {
  active:  { style: 'bg-amber-100 text-amber-700', label: 'Active'  },
  waived:  { style: 'bg-green-100 text-green-700', label: 'Waived'  },
  removed: { style: 'bg-gray-100 text-gray-500',   label: 'Removed' },
};

function contingencyDaysUntil(dateStr: string): number {
  return Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

// Exported for tests (tests/components/contingency-add-form.test.tsx).
export function ContingenciesCard({ deal }: { deal: Deal }) {
  const { items, loading, addItem, updateStatus } = useContingencies(deal.id);
  const activeCount = items.filter((c) => c.status === 'active').length;

  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <Shield size={14} className="text-brand-navy" />
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Contingencies</h3>
        </div>
        {activeCount > 0 && <span className="text-xs text-gray-400">{activeCount} active</span>}
      </div>

      <div className="px-5 py-4 space-y-3">
        {loading ? (
          <p className="text-xs text-gray-300">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-xs text-gray-400 italic">
            No contingencies yet. Add the deadlines you need to protect this deal.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((c) => {
              const badge = CONTINGENCY_BADGE[c.status];
              const days = c.deadline ? contingencyDaysUntil(c.deadline) : null;
              const isActive = c.status === 'active';
              const isPast = isActive && days !== null && days < 0;
              const isUrgent = isActive && days !== null && days >= 0 && days <= 5;
              const BadgeIcon = c.status === 'waived' ? ShieldCheck : c.status === 'removed' ? ShieldOff : Shield;

              return (
                <div
                  key={c.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${isUrgent || isPast ? 'border-amber-200 bg-amber-50/50' : 'border-gray-100 bg-white'}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-sm font-semibold ${isActive ? 'text-brand-navy' : 'text-gray-400'}`}>
                        {c.label}
                      </span>
                      <span className={`flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${badge.style}`}>
                        <BadgeIcon size={9} className="inline" /> {badge.label}
                      </span>
                    </div>
                    {c.deadline && (
                      <div className={`text-xs mt-0.5 ${isPast ? 'text-red-600 font-semibold' : isUrgent ? 'text-amber-600 font-medium' : 'text-gray-400'}`}>
                        {!isActive
                          ? `Deadline was ${c.deadline}`
                          : isPast
                          ? `Expired ${Math.abs(days!)}d ago — ${c.deadline}`
                          : days === 0
                          ? `Expires today — ${c.deadline}`
                          : `Expires in ${days}d — ${c.deadline}`}
                      </div>
                    )}
                  </div>
                  {isActive && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => updateStatus(c.id, 'waived')}
                        className="rounded-lg border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 hover:bg-green-100 transition-colors"
                      >
                        Waive
                      </button>
                      <button
                        onClick={() => updateStatus(c.id, 'removed')}
                        className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-semibold text-gray-600 hover:bg-gray-100 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add contingency (#186) — wired to useContingencies.addItem */}
        <AddContingencyForm onAdd={addItem} />
      </div>
    </div>
  );
}

export function OverviewTab({ deal, tasks, onRefresh }: { deal: Deal; tasks: Task[]; onRefresh?: () => void }) {
  const completedCount = tasks.filter((t) => t.status === 'completed').length;
  const { participants } = useParticipants(deal.id);
  const clientParticipant = participants.find((p) => p.role === 'buyer' || p.role === 'seller');
  const [showInvite, setShowInvite] = useState(false);

  return (
    <div className="space-y-4">
      {/* Loan Milestones + ARIVE Linker */}
      <LoanMilestonesCard deal={deal} onRefresh={onRefresh} />

      {/* Deal Details */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">Deal Details</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-gray-400 text-xs">Type</dt>
            <dd className="font-semibold text-brand-navy capitalize mt-0.5">{deal.type === 'buy' ? 'Purchase' : 'Listing'}</dd>
          </div>
          <div>
            <dt className="text-gray-400 text-xs">Price</dt>
            <dd className="font-semibold text-brand-navy mt-0.5">{formatMoney(deal.property.price)}</dd>
          </div>
          <div>
            <dt className="text-gray-400 text-xs">Stage</dt>
            <dd className="font-semibold text-brand-navy mt-0.5">{STAGE_LABELS[deal.stage]}</dd>
          </div>
          <div>
            <dt className="text-gray-400 text-xs">Days in Stage</dt>
            <dd className="font-semibold text-brand-navy mt-0.5">{deal.timeline.daysInStage} days</dd>
          </div>
          {deal.timeline.closingDate && (
            <div>
              <dt className="text-gray-400 text-xs">Closing Date</dt>
              <dd className="font-semibold text-brand-navy mt-0.5">{deal.timeline.closingDate}</dd>
            </div>
          )}
          <CommissionRateField deal={deal} onUpdated={onRefresh ?? (() => {})} />
          <div>
            <dt className="text-gray-400 text-xs">Created</dt>
            <dd className="font-semibold text-brand-navy mt-0.5">
              {new Date(deal.timeline.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </dd>
          </div>
        </dl>
      </div>

      {/* Onboarding Info */}
      <div className="rounded-xl bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Onboarding Info</h3>
          <button
            onClick={() => setShowInvite(true)}
            className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-semibold text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <Mail size={11} /> Invite by email
          </button>
        </div>
        <dl className="space-y-3 text-sm">
          <div>
            <dt className="text-gray-400 text-xs mb-0.5">Client</dt>
            <dd className="font-semibold text-brand-navy">{deal.clientName}</dd>
          </div>
          {clientParticipant && (
            <>
              {clientParticipant.phone && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Phone</dt>
                  <dd>
                    <a href={`tel:${clientParticipant.phone}`} className="font-semibold text-brand-navy hover:text-blue-600 transition-colors">
                      {clientParticipant.phone}
                    </a>
                  </dd>
                </div>
              )}
              {clientParticipant.email && (
                <div>
                  <dt className="text-gray-400 text-xs mb-0.5">Email</dt>
                  <dd>
                    <a href={`mailto:${clientParticipant.email}`} className="font-semibold text-brand-navy hover:text-blue-600 transition-colors break-all">
                      {clientParticipant.email}
                    </a>
                  </dd>
                </div>
              )}
            </>
          )}
          {deal.flags.length > 0 && (
            <div>
              <dt className="text-gray-400 text-xs mb-1">Flags</dt>
              <dd className="flex flex-wrap gap-1.5">
                {deal.flags.map((flag) => (
                  <span key={flag} className="rounded-full bg-brand-navy/10 px-2.5 py-0.5 text-xs font-medium text-brand-navy">
                    {FLAG_LABELS[flag] ?? flag}
                  </span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-gray-400 text-xs mb-0.5">Task Progress</dt>
            <dd className="flex items-center gap-2">
              <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-green-400 rounded-full transition-all"
                  style={{ width: tasks.length ? `${(completedCount / tasks.length) * 100}%` : '0%' }}
                />
              </div>
              <span className="text-xs text-gray-400">{completedCount}/{tasks.length}</span>
            </dd>
          </div>
        </dl>
      </div>

      {/* Team & Participants — add co-agent / client by email, remove added participants */}
      <TeamParticipantsCard deal={deal} />

      {/* Client onboarding intake — persisted questionnaire answers (#175) */}
      <IntakeCard dealId={deal.id} />

      {/* Contingency deadlines — under_contract and beyond (#186) */}
      {['under_contract', 'pre_close', 'closing', 'post_close'].includes(deal.stage) && (
        <ContingenciesCard deal={deal} />
      )}

      {/* Property Tracker — buy deals only */}
      {deal.type === 'buy' && <PropertyTrackingCard deal={deal} />}

      {/* Seller-specific tools */}
      {deal.type === 'sell' && (
        <>
          {/* Showing Availability */}
          <SellerShowingAvailabilityCard dealId={deal.id} />

          {/* Offer Management */}
          <SellerOffersCard dealId={deal.id} />

          {/* Buyer Status — under_contract and beyond */}
          {['under_contract', 'pre_close', 'closing', 'post_close'].includes(deal.stage) && (
            <SellerBuyerStatusCard deal={deal} onRefresh={onRefresh} />
          )}

          {/* Net Sheet — pre_close and post_close */}
          {['pre_close', 'post_close'].includes(deal.stage) && (
            <SellerNetSheetCard deal={deal} />
          )}
        </>
      )}

      {/* Fast Pass — buy deals only */}
      {deal.type === 'buy' && <FastPassCard deal={deal} />}

      {/* Smooth Exit — sell deals only */}
      {deal.type === 'sell' && <SmoothExitCard deal={deal} />}

      {/* Internal Notes */}
      <InternalNotesCard deal={deal} />

      {/* Closing Fee — shown at post_close */}
      {deal.stage === 'post_close' && <ClosingFeeCard deal={deal} onRefresh={onRefresh} />}

      {/* Email-invite client to this deal */}
      {showInvite && (
        <DealInviteModal dealId={deal.id} onClose={() => setShowInvite(false)} />
      )}
    </div>
  );
}

// ─── Team & Participants Card ────────────────────────────────────────────────

// Roles an agent can attach to a deal. Values must match the user_role enum the
// participants route validates against (agent, buyer, seller, admin, tc,
// lending_partner). "Co-agent" maps to the `agent` role value.
const PARTICIPANT_ROLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'agent', label: 'Co-agent' },
  { value: 'buyer', label: 'Buyer' },
  { value: 'seller', label: 'Seller' },
  { value: 'tc', label: 'Transaction Coordinator' },
  { value: 'lending_partner', label: 'Lending Partner' },
];

const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  PARTICIPANT_ROLE_OPTIONS.map((o) => [o.value, o.label]),
);

function TeamParticipantsCard({ deal }: { deal: Deal }) {
  const activeUser = useAuthStore((s) => s.activeUser);
  // Match how other agent-only controls gate (e.g. canAdvanceStage). The server
  // still enforces agent-ownership; this is UX only.
  const canManage = ['agent', 'tc', 'admin'].includes(activeUser?.groupId ?? '');

  const { participants, addParticipant, removeParticipant, adding } = useParticipants(deal.id);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState(PARTICIPANT_ROLE_OPTIONS[0].value);
  const [err, setErr] = useState('');

  async function handleAdd() {
    const trimmed = email.trim();
    if (!trimmed) {
      setErr('Enter an email address.');
      return;
    }
    setErr('');
    try {
      await addParticipant({ email: trimmed, role });
      setEmail('');
    } catch (e: unknown) {
      // Surface the route's message (404 → "No RealTourFlow account…").
      setErr(e instanceof Error ? e.message : 'Could not add participant — please try again.');
    }
  }

  async function handleRemove(userId: string, name: string) {
    if (!confirm(`Remove ${name} from this deal?`)) return;
    try {
      await removeParticipant(userId);
    } catch {
      // Refetch on success handles the happy path; failures leave the row in place.
    }
  }

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Users size={14} className="text-gray-400" />
        <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Team &amp; Participants</h3>
      </div>

      {participants.length === 0 ? (
        <p className="text-sm text-gray-400">No participants yet.</p>
      ) : (
        <ul className="space-y-2">
          {participants.map((p) => {
            // Never offer remove on the deal's owning agent (the primary agent
            // is the deal.agentId, not normally a participant row — guard anyway).
            const isPrimaryAgent = p.id === deal.agentId;
            return (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-gray-100 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-brand-navy">{p.name}</p>
                  <p className="truncate text-xs text-gray-400">{p.email}</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="rounded-full bg-brand-navy/10 px-2.5 py-0.5 text-[11px] font-medium text-brand-navy">
                    {ROLE_LABELS[p.role] ?? p.role}
                  </span>
                  {canManage && !isPrimaryAgent && (
                    <button
                      onClick={() => handleRemove(p.id, p.name)}
                      title="Remove participant"
                      className="flex h-6 w-6 items-center justify-center rounded-full text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canManage && (
        <div className="mt-4 border-t pt-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-wide text-gray-500">
            Add participant / co-agent
          </p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 focus-within:border-brand-navy/40 focus-within:ring-2 focus-within:ring-brand-navy/10">
              <Mail size={14} className="flex-shrink-0 text-gray-400" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
                placeholder="person@email.com"
                className="min-w-0 flex-1 bg-transparent text-sm text-brand-navy outline-none placeholder:text-gray-300"
              />
            </div>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-brand-navy outline-none focus:border-brand-navy/40 focus:ring-2 focus:ring-brand-navy/10"
            >
              {PARTICIPANT_ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <button
              onClick={handleAdd}
              disabled={adding || !email.trim()}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-brand-navy px-4 py-2 text-sm font-bold text-white hover:bg-brand-navy/90 disabled:opacity-40 transition-colors"
            >
              <Plus size={14} /> {adding ? 'Adding…' : 'Add'}
            </button>
          </div>
          {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
          <p className="mt-2 text-[11px] text-gray-400">
            They must already have a RealTourFlow account. No account?{' '}
            <span className="font-medium text-brand-navy">Use “Invite by email”</span> above to send a join link.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Closing Fee Card ────────────────────────────────────────────────────────

function ClosingFeeCard({ deal, onRefresh }: { deal: Deal; onRefresh?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [waiving, setWaiving] = useState(false);
  const activeUser = useAuthStore((s) => s.activeUser);
  // Mirror the server route's allowedRoles: ["admin", "tc"] (fee/waive/route.ts).
  const canWaive = ['admin', 'tc'].includes(activeUser?.groupId ?? '');
  const feeStatus = deal.feeStatus ?? 'unpaid';
  const amount = ((deal.feeAmountCents ?? 7500) / 100).toFixed(2);
  const isOpen = feeStatus === 'unpaid' || feeStatus === 'pending';

  async function handlePay() {
    setLoading(true);
    try {
      const res = await api.post<{ checkout_url: string }>(`/deals/${deal.id}/fee/checkout`, {});
      window.location.href = res.checkout_url;
    } catch {
      setLoading(false);
    }
  }

  async function handleWaive() {
    if (!confirm('Waive the enrollment fee for this deal? This cannot be undone.')) return;
    setWaiving(true);
    try {
      await api.post<{ status: string }>(`/deals/${deal.id}/fee/waive`, {});
      onRefresh?.();
    } catch {
      // leave status unchanged; surface nothing destructive on failure
    } finally {
      setWaiving(false);
    }
  }

  const STATUS_STYLES: Record<string, string> = {
    paid:    'bg-green-100 text-green-700',
    waived:  'bg-gray-100 text-gray-500',
    pending: 'bg-amber-100 text-amber-700',
    unpaid:  'bg-red-50 text-red-600',
  };

  return (
    <div className="rounded-xl bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Closing Fee</h3>
          <p className="mt-1 text-2xl font-bold text-brand-navy">${amount}</p>
          {feeStatus === 'paid' && deal.feePaidAt && (
            <p className="text-[11px] text-gray-400 mt-0.5">
              Paid {new Date(deal.feePaidAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className={`rounded-full px-3 py-1 text-xs font-bold capitalize ${STATUS_STYLES[feeStatus] ?? STATUS_STYLES.unpaid}`}>
            {feeStatus}
          </span>
          {isOpen && (
            <button
              onClick={handlePay}
              disabled={loading}
              className="rounded-lg bg-brand-gold px-4 py-2 text-sm font-bold text-brand-navy hover:bg-brand-gold-dark transition-colors disabled:opacity-60"
            >
              {loading ? 'Redirecting…' : 'Pay Now'}
            </button>
          )}
          {/* Admin/TC-only fee waiver. Server enforces allowedRoles; this gate is UX. */}
          {isOpen && canWaive && (
            <button
              onClick={handleWaive}
              disabled={waiving}
              className="text-xs font-semibold text-gray-500 underline-offset-2 hover:text-gray-700 hover:underline disabled:opacity-60"
            >
              {waiving ? 'Waiving…' : 'Waive fee'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Tasks Tab ──────────────────────────────────────────────────────────────
