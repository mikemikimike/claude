"use client";

import { useState } from 'react';
import Link from "next/link";
import { useAuthStore } from "@/lib/store/authStore";
import { Deal, DealStage, DealType } from "@/lib/types";
import { AGENT_STAGE_LABELS as STAGE_LABELS, STAGE_ORDER } from "@/lib/stages";
import { useDeals, type ApiDeal } from "@/hooks/useDeals";
import { formatMoney } from "@/lib/deal-money";
import { api } from "@/lib/api-client";
import { ArrowRight, MapPin, Calendar, Clock, Zap, Plus, X } from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────────────────


const HEALTH_BORDER: Record<string, string> = {
  green: 'border-l-[4px] border-l-green-400',
  yellow: 'border-l-[4px] border-l-amber-400',
  red: 'border-l-[4px] border-l-red-400',
};

const HEALTH_BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
};

const FLAG_LABELS: Record<string, string> = {
  fast_pass: 'Fast Pass',
  disclosures_pending: 'Disclosures Pending',
  repair_request: 'Repair Request',
  mountain_mortgage: 'Mtn Mortgage',
  asap_timeline: 'ASAP',
  also_buying: 'Also Buying',
};

// ─── New Deal Modal ──────────────────────────────────────────────────────────

type NewDealForm = {
  clientName: string;
  type: DealType;
  address: string;
  city: string;
  state: string;
  zip: string;
  price: string;
  closingDate: string;
};

const EMPTY_FORM: NewDealForm = {
  clientName: '',
  type: 'buy',
  address: '',
  city: '',
  state: 'AL',
  zip: '',
  price: '',
  closingDate: '',
};

export function NewDealModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState<NewDealForm>(EMPTY_FORM);
  const [addressTbd, setAddressTbd] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function set(field: keyof NewDealForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    const price = parseFloat(form.price.replace(/[^0-9.]/g, ''));
    const fullAddress = addressTbd
      ? null
      : [
          form.address.trim(),
          [form.city.trim(), form.state.trim(), form.zip.trim()].filter(Boolean).join(' '),
        ]
          .filter(Boolean)
          .join(', ') || null;

    try {
      await api.post<ApiDeal>('/deals', {
        title: form.clientName.trim(),
        type: form.type,
        address: fullAddress,
        price: isNaN(price) ? null : price,
        arive_linked: false,
        // Persist the entered "Est. Closing Date" (#253) — previously dropped.
        // The <input type="date"> value is already YYYY-MM-DD; blank → null.
        closing_date: form.closingDate || null,
      });
      setSubmitted(true);
      onCreated();
    } catch {
      setSubmitError('Failed to create deal. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl p-8 text-center">
          <div className="mb-4 flex justify-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-3xl">✓</span>
          </div>
          <h2 className="text-xl font-bold text-brand-navy mb-2">Deal Created</h2>
          <p className="text-sm text-gray-500 mb-6">
            <span className="font-semibold text-brand-navy">{form.clientName}</span> has been added to your pipeline
            at <span className="font-semibold">Intake</span> stage.
          </p>
          <button
            onClick={onClose}
            className="w-full rounded-xl bg-brand-navy px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-navy/90 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-bold text-brand-navy">New Deal</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form id="new-deal-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Deal type toggle */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
              Deal Type
            </label>
            <div className="flex rounded-xl border border-gray-200 overflow-hidden">
              {(['buy', 'sell'] as DealType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => set('type', t)}
                  className={[
                    'flex-1 py-2.5 text-sm font-semibold transition-colors',
                    form.type === t
                      ? 'bg-brand-navy text-white'
                      : 'text-gray-500 hover:bg-gray-50',
                  ].join(' ')}
                >
                  {t === 'buy' ? 'Buyer' : 'Seller'}
                </button>
              ))}
            </div>
          </div>

          {/* Client name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
              Client Name <span className="text-red-400">*</span>
            </label>
            <input
              required
              type="text"
              placeholder="e.g. Jane Doe"
              value={form.clientName}
              onChange={(e) => set('clientName', e.target.value)}
              className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
            />
          </div>

          {/* Address */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Property Address
              </label>
              <button
                type="button"
                onClick={() => setAddressTbd((v) => !v)}
                className={[
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition-colors',
                  addressTbd
                    ? 'bg-brand-navy text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                ].join(' ')}
              >
                TBD
              </button>
            </div>

            {addressTbd ? (
              <div className="flex items-center gap-2 rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-3">
                <span className="text-sm text-gray-400 italic">Address to be determined</span>
              </div>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="123 Main Street"
                  value={form.address}
                  onChange={(e) => set('address', e.target.value)}
                  className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy mb-3"
                />
                <div className="grid grid-cols-5 gap-3">
                  <div className="col-span-2">
                    <input
                      type="text"
                      placeholder="City"
                      value={form.city}
                      onChange={(e) => set('city', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
                    />
                  </div>
                  <div className="col-span-1">
                    <input
                      type="text"
                      maxLength={2}
                      placeholder="AL"
                      value={form.state}
                      onChange={(e) => set('state', e.target.value.toUpperCase())}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
                    />
                  </div>
                  <div className="col-span-2">
                    <input
                      type="text"
                      placeholder="ZIP"
                      value={form.zip}
                      onChange={(e) => set('zip', e.target.value)}
                      className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
                    />
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Price */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
              {form.type === 'sell' ? 'Est. Listing Price' : 'Purchase Price'} <span className="text-red-400">*</span>
            </label>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-semibold text-gray-400">$</span>
              <input
                required
                type="text"
                placeholder="350,000"
                value={form.price}
                onChange={(e) => set('price', e.target.value)}
                className="w-full rounded-xl border border-gray-200 pl-8 pr-4 py-2.5 text-sm text-brand-navy placeholder-gray-300 focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
              />
            </div>
          </div>

          {/* Est. Close Date */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1.5">
              Est. Closing Date
            </label>
            <input
              type="date"
              value={form.closingDate}
              onChange={(e) => set('closingDate', e.target.value)}
              className="w-full rounded-xl border border-gray-200 px-4 py-2.5 text-sm text-brand-navy focus:border-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-navy"
            />
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-100 space-y-3">
          {submitError && (
            <p className="text-xs text-red-500 text-center">{submitError}</p>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="new-deal-form"
              disabled={submitting}
              className="flex-1 rounded-xl bg-brand-gold px-4 py-2.5 text-sm font-bold text-brand-navy hover:bg-brand-gold-dark transition-colors shadow-sm disabled:opacity-40"
            >
              {submitting ? 'Creating…' : 'Create Deal'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Deal Card ───────────────────────────────────────────────────────────────

export function DealCard({ deal }: { deal: Deal }) {
  const openTasks = deal.openTaskCount ?? 0;
  const overdueTasks = deal.overdueTaskCount ?? 0;

  return (
    <Link
      href={`/agent/deals/${deal.id}`}
      className={`group block rounded-xl bg-white shadow-sm hover:shadow-md transition-all ${HEALTH_BORDER[deal.health]}`}
    >
      <div className="px-4 py-4">
        {/* Top row: name + stage */}
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="font-bold text-brand-navy text-base truncate">{deal.clientName}</span>
              {overdueTasks > 0 && (
                <span className="flex-shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600 uppercase">
                  {overdueTasks} overdue
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-400">
              <MapPin size={11} className="flex-shrink-0" />
              <span className="truncate">
                {[deal.property.address, deal.property.city, deal.property.state].filter(Boolean).join(', ')}
              </span>
            </div>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className={`rounded-full px-2.5 py-1 text-xs font-semibold ${HEALTH_BADGE[deal.health]}`}>
              {STAGE_LABELS[deal.stage]}
            </div>
          </div>
        </div>

        {/* Middle row: price + timeline */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-3 text-sm">
          <span className="font-semibold text-brand-navy">{formatMoney(deal.property.price)}</span>
          <span className="flex items-center gap-1 text-gray-400 text-xs">
            <Clock size={11} />
            {deal.timeline.daysInStage}d in stage
          </span>
          {deal.timeline.closingDate && (
            <span className="flex items-center gap-1 text-gray-400 text-xs">
              <Calendar size={11} />
              Closes {deal.timeline.closingDate}
            </span>
          )}
        </div>

        {/* Bottom row: tasks + flags + arrow */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {/* Task summary pill */}
            {openTasks > 0 ? (
              <span className="rounded-full bg-brand-bg px-2.5 py-0.5 text-[11px] font-medium text-gray-600">
                {openTasks} open task{openTasks !== 1 ? 's' : ''}
              </span>
            ) : (
              <span className="rounded-full bg-green-50 px-2.5 py-0.5 text-[11px] font-medium text-green-600">
                All tasks done
              </span>
            )}
            {/* Concierge badges */}
            {deal.fastPass?.status === 'active' && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-green-100 border border-green-200 px-2 py-0.5 text-[11px] font-bold text-green-700">
                <Zap size={9} /> Fast Pass
              </span>
            )}
            {deal.smoothExit?.status === 'active' && (
              <span className="rounded-full bg-purple-100 border border-purple-200 px-2 py-0.5 text-[11px] font-bold text-purple-700">
                Smooth Exit
              </span>
            )}
            {/* Other flags */}
            {deal.flags.filter((f) => f !== 'fast_pass').slice(0, 2).map((flag) => (
              <span
                key={flag}
                className="rounded-full bg-brand-navy/10 px-2.5 py-0.5 text-[11px] font-medium text-brand-navy"
              >
                {FLAG_LABELS[flag] ?? flag}
              </span>
            ))}
          </div>
          <ArrowRight
            size={15}
            className="flex-shrink-0 text-gray-300 group-hover:text-brand-gold transition-colors"
          />
        </div>
      </div>
    </Link>
  );
}

// ─── Stage Group ─────────────────────────────────────────────────────────────

function StageGroup({ stage, deals }: { stage: DealStage; deals: Deal[] }) {
  if (deals.length === 0) return null;
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">
          {STAGE_LABELS[stage]}
        </h3>
        <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-semibold text-gray-500">
          {deals.length}
        </span>
      </div>
      <div className="space-y-2">
        {deals.map((deal) => (
          <DealCard key={deal.id} deal={deal} />
        ))}
      </div>
    </div>
  );
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

type FilterType = 'all' | 'buy' | 'sell';

function TypeToggle({ value, onChange }: { value: FilterType; onChange: (v: FilterType) => void }) {
  const options: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'buy', label: 'Buyers' },
    { key: 'sell', label: 'Sellers' },
  ];

  return (
    <div className="flex rounded-lg bg-white shadow-sm border border-gray-200 overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          className={[
            'flex-1 px-4 py-2 text-sm font-semibold transition-colors',
            value === opt.key
              ? 'bg-brand-navy text-white'
              : 'text-gray-500 hover:bg-gray-50',
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function Pipeline() {
  const activeUser = useAuthStore((s) => s.activeUser);
  const [filter, setFilter] = useState<FilterType>('all');
  const [showNewDeal, setShowNewDeal] = useState(false);
  const { deals, loading, error, refresh } = useDeals();

  const filteredDeals = deals.filter((d) => {
    if (filter === 'buy') return d.type === 'buy';
    if (filter === 'sell') return d.type === 'sell';
    return true;
  });

  // Group by stage in order
  const dealsByStage = STAGE_ORDER.reduce<Record<string, Deal[]>>((acc, stage) => {
    acc[stage] = filteredDeals.filter((d) => d.stage === stage);
    return acc;
  }, {});

  const buyCount = deals.filter((d) => d.type === 'buy').length;
  const sellCount = deals.filter((d) => d.type === 'sell').length;

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Pipeline</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {loading ? 'Loading…' : `${deals.length} active deal${deals.length !== 1 ? 's' : ''} · ${buyCount} buyer${buyCount !== 1 ? 's' : ''} · ${sellCount} seller${sellCount !== 1 ? 's' : ''}`}
          </p>
          {/* #417 — this list is active-only, and used to be a one-way door:
              nothing on the page admitted that closed deals existed, let alone
              where they went. */}
          <Link
            href="/agent#completed"
            className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-gray-400 hover:text-brand-navy transition-colors"
          >
            View completed deals <ArrowRight size={11} />
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <TypeToggle value={filter} onChange={setFilter} />
          <button
            onClick={() => setShowNewDeal(true)}
            className="flex items-center gap-1.5 rounded-xl bg-brand-gold px-3.5 py-2 text-sm font-bold text-brand-navy hover:bg-brand-gold-dark transition-colors shadow-sm"
          >
            <Plus size={15} />
            New Deal
          </button>
        </div>
      </div>

      {/* Deals grouped by stage */}
      {error ? (
        <div className="rounded-xl bg-red-50 p-6 text-center shadow-sm">
          <p className="text-sm text-red-700 font-semibold">We couldn&apos;t load your pipeline.</p>
          <p className="mt-1 text-xs text-red-500">{error}</p>
          <button
            onClick={refresh}
            className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 transition-colors"
          >
            Try again
          </button>
        </div>
      ) : loading ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-sm">
          <p className="text-gray-400">Loading deals…</p>
        </div>
      ) : filteredDeals.length === 0 ? (
        <div className="rounded-xl bg-white p-10 text-center shadow-sm">
          <p className="text-gray-400">No deals match this filter.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {STAGE_ORDER.map((stage) => (
            <StageGroup key={stage} stage={stage} deals={dealsByStage[stage]} />
          ))}
        </div>
      )}

      {showNewDeal && activeUser && (
        <NewDealModal
          onClose={() => setShowNewDeal(false)}
          onCreated={refresh}
        />
      )}
    </div>
  );
}
