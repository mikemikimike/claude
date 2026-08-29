"use client";

import { useState } from 'react';
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { Deal, DealStage, Task } from "@/lib/types";
import { formatMoney } from "@/lib/deal-money";
import { STAGE_ORDER, openTaskCountsByStage } from "@/lib/stages";
import ClientNotifications from "@/components/ClientNotifications";
import { BUYER_STATUS_STEPS } from "@/lib/buyer-status";
import { useMyDeals } from "@/hooks/useMyDeals";
import { useNotifications } from "@/hooks/useNotifications";
import PortalDealDocuments from "@/components/portal/PortalDealDocuments";
import ClientIntakeCard from "@/components/portal/ClientIntakeCard";
// #422 — the same orienting frame the buyer portal uses; the guidance line
// lives once, in PortalStageHeader.
import PortalStageHeader from "@/components/portal/PortalStageHeader";
import PortalSection from "@/components/portal/PortalSection";
import { useTasks } from "@/hooks/useTasks";
import { useTaskCompletion } from "@/hooks/useTaskCompletion";
import { useMessages, postMessage } from "@/hooks/useMessages";
import { useShowingAvailability, DAYS_OF_WEEK, ShowingSlot, DayOfWeek } from "@/hooks/useShowingAvailability";
import { useOffers } from "@/hooks/useOffers";
import { useNetSheet, recalcLines, calcNetProceeds } from "@/hooks/useNetSheet";
import { useChecklist } from "@/hooks/useChecklist";
import {
  CheckCircle2, Circle, AlertCircle, Loader2, XCircle,
  MapPin, Calendar, MessageSquare, FileText,
  Phone, Mail, Home, Star,
  TrendingUp, Clock, DollarSign, Wrench, Send,
} from 'lucide-react';
import VendorDirectory from "@/components/VendorDirectory";

// ─── Constants ────────────────────────────────────────────────────────────────

const SELLER_STAGE_LABELS: Record<DealStage, string> = {
  intake:         'Getting Started',
  active_search:  'Listing Prep',
  offer_active:   'Listed & Active',
  under_contract: 'Under Contract',
  pre_close:      'Pre-Close',
  closing:        'Closing Day',
  post_close:     'Sold!',
};

/**
 * #422 — the seller half of "the portal has to explain itself".
 *
 * The buyer portal already had STAGE_DESCRIPTIONS (buried in its journey rail);
 * the seller portal had nothing at all, so a seller's only clue about where
 * they were was a two-word label in a pill.
 */
const SELLER_STAGE_DESCRIPTIONS: Record<DealStage, string> = {
  intake:         'Getting your file set up with your agent.',
  active_search:  'Getting the house ready to go on the market.',
  offer_active:   'Your home is live — showings and offers are coming in.',
  under_contract: 'Under contract and working through the buyer’s conditions.',
  pre_close:      'Final checks before closing day.',
  closing:        'Signing day is here!',
  post_close:     'Sold. Congratulations!',
};

/**
 * How each stage's own cards are introduced — a heading and one line saying who
 * is driving that work. Separate from the descriptions above: that one answers
 * "where am I", this one answers "whose job is what's below".
 */
const SELLER_STAGE_FOCUS: Record<DealStage, { title: string; blurb: string }> = {
  intake: {
    // NOT "Getting started" — the stage header above and the intake card below
    // both already say that.
    title: 'Your first step',
    blurb: 'Answer a few questions about your property. Your agent builds your listing plan from your answers.',
  },
  active_search: {
    title: 'Getting your home listed',
    blurb: 'Work through your prep checklist. Your agent handles pricing, photography and the listing itself.',
  },
  offer_active: {
    title: 'Your live listing',
    blurb: 'Your agent is running showings and bringing you every offer. Keep your showing availability up to date.',
  },
  under_contract: {
    title: 'Your transaction',
    blurb: 'Your agent is working the buyer’s inspection, appraisal and financing steps. Anything that needs you shows up in your to-do list.',
  },
  pre_close: {
    title: 'Getting to the closing table',
    blurb: 'Your agent is lining up the final paperwork with the title company.',
  },
  closing: {
    title: 'Closing day',
    blurb: 'Here’s what to bring. Your agent meets you at the table.',
  },
  post_close: {
    title: 'After closing',
    blurb: 'The sale is done. These are the loose ends you can tie up whenever suits you.',
  },
};

const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  completed:   <CheckCircle2 size={18} className="text-green-500 flex-shrink-0" />,
  in_progress: <Loader2 size={18} className="text-blue-500 flex-shrink-0 animate-spin" />,
  overdue:     <AlertCircle size={18} className="text-red-500 flex-shrink-0" />,
  pending:     <Circle size={18} className="text-gray-300 flex-shrink-0" />,
  blocked:     <AlertCircle size={18} className="text-orange-400 flex-shrink-0" />,
};

// ─── Shared: Task card ────────────────────────────────────────────────────────

// `done` (#408) mirrors BuyerView: the caller overrides the server status while
// an optimistic completion is still in flight. A completed card is clickable —
// tapping it re-opens the task, so a mis-tap is no longer permanent.
function TaskCard({ task, done = false, onComplete, onUncomplete }: { task: Task; done?: boolean; onComplete?: (id: string) => void; onUncomplete?: (id: string) => void }) {
  const isOverdue = task.status === 'overdue';
  const isDone    = done || task.status === 'completed';
  return (
    <button
      onClick={() => (isDone ? onUncomplete?.(task.id) : onComplete?.(task.id))}
      className={`w-full text-left flex items-start gap-3 rounded-xl p-4 transition-all ${
        isOverdue ? 'bg-red-50 border border-red-100' :
        isDone    ? 'bg-gray-50 opacity-60' :
        'bg-white border border-gray-100 hover:border-green-200 hover:bg-green-50/40 active:scale-[0.99]'
      }`}
    >
      {isDone
        ? <CheckCircle2 size={18} className="text-green-500 flex-shrink-0" />
        : TASK_STATUS_ICON[task.status]}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${isDone ? 'line-through text-gray-400' : 'text-brand-navy'}`}>
          {task.title}
        </p>
        {task.description && !isDone && (
          <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">{task.description}</p>
        )}
        {task.dueDate && !isDone && (
          <p className={`mt-1 text-[11px] font-medium ${isOverdue ? 'text-red-500' : 'text-gray-400'}`}>
            {isOverdue ? 'Overdue — ' : 'Due '}{task.dueDate}
          </p>
        )}
        {isDone && (
          <p className="mt-0.5 text-[11px] text-green-600">
            Marked complete{onUncomplete ? ' — tap to undo' : ''}
          </p>
        )}
      </div>
    </button>
  );
}

// ─── Shared: Tab bar ──────────────────────────────────────────────────────────

type Tab = 'tasks' | 'messages' | 'documents';

function TabBar({ active, onChange, taskCount, msgCount }: {
  active: Tab; onChange: (t: Tab) => void; taskCount: number; msgCount: number;
}) {
  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: 'tasks',     label: 'Tasks',     icon: CheckCircle2, count: taskCount },
    { id: 'messages',  label: 'Messages',  icon: MessageSquare, count: msgCount },
    { id: 'documents', label: 'Documents', icon: FileText },
  ];
  return (
    <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm">
      {tabs.map(({ id, label, icon: Icon, count }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={[
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition-colors',
            active === id ? 'bg-brand-navy text-white shadow-sm' : 'text-gray-400 hover:bg-gray-50',
          ].join(' ')}
        >
          <Icon size={14} />
          {label}
          {count !== undefined && count > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
              active === id ? 'bg-white/20 text-white' : 'bg-brand-navy/10 text-brand-navy'
            }`}>{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Shared: Messages tab ─────────────────────────────────────────────────────

function MessagesTab({ dealId }: { dealId: string }) {
  const { messages, loading, refresh } = useMessages(dealId, 'client_thread');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  async function handleSend() {
    if (!draft.trim() || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await postMessage(dealId, 'client_thread', draft.trim());
      setDraft('');
      await refresh();
    } catch {
      // Keep the draft so the seller can retry instead of losing what they typed.
      setSendError('Message failed to send. Please try again.');
    }
    setSending(false);
  }

  return (
    <div className="space-y-3">
      {!loading && messages.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <MessageSquare size={28} className="mx-auto mb-2 text-gray-200" />
          <p className="text-sm text-gray-400">No messages yet</p>
        </div>
      )}
      {messages.map((msg) => {
        const isAgent = msg.senderRole === 'agent';
        return (
          <div key={msg.id} className={`flex gap-2.5 ${isAgent ? '' : 'flex-row-reverse'}`}>
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white text-xs font-bold ${
              isAgent ? 'bg-brand-navy' : 'bg-purple-500'
            }`}>
              {msg.senderName.charAt(0)}
            </div>
            <div className={`max-w-[78%] lg:max-w-md flex flex-col gap-1 ${isAgent ? 'items-start' : 'items-end'}`}>
              <div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                isAgent ? 'bg-gray-100 text-gray-800 rounded-tl-sm' : 'bg-purple-600 text-white rounded-tr-sm'
              }`}>{msg.content}</div>
              <span className="text-[10px] text-gray-300">
                {new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        );
      })}
      {sendError && (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
          <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
          <p className="text-xs font-medium text-red-600">{sendError}</p>
        </div>
      )}
      <div className="pt-1 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Message your agent…"
          className="flex-1 rounded-full border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
        />
        <button
          onClick={handleSend}
          disabled={!draft.trim() || sending}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-white hover:bg-brand-navy/80 transition-colors disabled:opacity-50"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Shared: Documents tab ────────────────────────────────────────────────────

// ─── Shared: Agent card ───────────────────────────────────────────────────────

function AgentCard({ agentName, agentEmail, agentPhone }: {
  agentName: string;
  agentEmail: string;
  agentPhone: string | null;
}) {
  const initials = agentName.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="rounded-2xl bg-brand-navy p-5 text-white">
      <p className="mb-3 text-xs font-bold uppercase tracking-widest text-white/50">Your Agent</p>
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-gold/20 ring-2 ring-brand-gold/40 text-brand-gold font-bold text-sm flex-shrink-0">
          {initials}
        </div>
        <div>
          <p className="font-bold text-white">{agentName}</p>
          <p className="text-xs text-white/60">RealTour Flow Agent</p>
        </div>
      </div>
      <div className="space-y-2">
        {agentPhone && (
          <a href={`tel:${agentPhone}`} className="flex items-center gap-2.5 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20 transition-colors">
            <Phone size={14} /> {agentPhone}
          </a>
        )}
        <a href={`mailto:${agentEmail}`} className="flex items-center gap-2.5 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20 transition-colors">
          <Mail size={14} /> {agentEmail}
        </a>
      </div>
    </div>
  );
}

// ─── Journey tracker ──────────────────────────────────────────────────────────

/**
 * #420 — a walked-past stage is not a finished stage.
 *
 * Same fix as the buyer portal's rail: every earlier stage used to be checked
 * off purely on position, so moving a deal on retroactively told the seller
 * that Listing Prep was done while their own prep tasks sat open. A past stage
 * with the seller's tasks still open gets an open ring and an honest count.
 *
 * `openTasks` is the seller's OWN open tasks — the rail must only show a number
 * they can actually act on.
 */
function JourneyTracker({ deal, openTasks = [] }: { deal: Deal; openTasks?: Task[] }) {
  const isFallenThrough = deal.status === 'fallen_through';
  const currentIdx = STAGE_ORDER.indexOf(
    isFallenThrough ? (deal.fellFromStage ?? deal.stage) : deal.stage
  );
  const openByStage = openTaskCountsByStage(openTasks);

  return (
    // #422 — the rail's own heading moved out to the PortalSection that wraps
    // it, so the secondary column reads as one labelled group instead of a
    // stack of separately-titled cards.
    <div className="rounded-2xl bg-white shadow-sm p-5">
      <div className="space-y-2">
        {STAGE_ORDER.map((stage, i) => {
          const isPast    = i < currentIdx;
          const isCurrent = i === currentIdx;
          const isFellHere = isFallenThrough && isCurrent;
          const stillOpen = isPast ? (openByStage[stage] ?? 0) : 0;
          const isDone = isPast && stillOpen === 0;
          const state =
            isFellHere ? 'fell-out' :
            isDone     ? 'complete' :
            isPast     ? 'open' :
            isCurrent  ? 'current' : 'upcoming';
          return (
            <div key={stage} data-testid={`stage-row-${stage}`} data-stage-state={state} className="flex items-center gap-3">
              <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full ${
                isFellHere ? 'bg-red-400' :
                isDone     ? 'bg-purple-400' :
                isPast     ? 'border-2 border-amber-300 bg-white' :
                isCurrent  ? 'bg-brand-gold ring-2 ring-brand-gold/30 ring-offset-1' :
                             'bg-gray-100'
              }`}>
                {isFellHere  && <XCircle size={14} className="text-white" />}
                {isDone      && <CheckCircle2 size={14} className="text-white" />}
                {isPast && !isDone && <div className="h-2 w-2 rounded-full bg-amber-400" />}
                {isCurrent && !isFallenThrough && <div className="h-2 w-2 rounded-full bg-brand-navy" />}
              </div>
              <span className={`text-sm ${
                isFellHere ? 'text-red-500 font-semibold' :
                isDone     ? 'text-purple-600 font-medium' :
                isPast     ? 'text-amber-700 font-medium' :
                isCurrent  ? 'font-bold text-brand-navy' :
                             'text-gray-300'
              }`}>
                {SELLER_STAGE_LABELS[stage]}
              </span>
              {isPast && !isDone && (
                <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                  {stillOpen} task{stillOpen !== 1 ? 's' : ''} open
                </span>
              )}
              {isCurrent && !isFallenThrough && (
                <span className="ml-auto rounded-full bg-brand-gold/20 px-2 py-0.5 text-[10px] font-bold text-brand-navy uppercase tracking-wide">Now</span>
              )}
              {isFellHere && (
                <span className="ml-auto rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-600 uppercase tracking-wide">Fell out</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Stage-specific cards ─────────────────────────────────────────────────────

// #407 — shared with the buyer portal (components/portal/ClientIntakeCard):
// once the seller's intake is on file the "Begin my onboarding" CTA is gone,
// whatever stage the deal is parked in.
function IntakeCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  return (
    <ClientIntakeCard
      role="seller"
      firstName={firstName}
      intakeSubmitted={deal.intakeSubmitted}
      onboardHref="/onboard/seller"
    />
  );
}

function ListingPrepCard({ deal }: { deal: Deal }) {
  // Backed by the persisted checklist API (#261): the seller's ticks survive
  // reload and are visible to the agent on the same deal checklist. We show the
  // seller-assigned items only (the TC/agent closing set seeds later at
  // under_contract+ and isn't the seller's to work). No fabricated pre-checks.
  const { items, loading, toggle } = useChecklist(deal.id);
  const prepItems = items.filter((i) => i.assignedTo === 'seller');
  const doneCount = prepItems.filter((i) => i.checked).length;
  const pct = prepItems.length > 0 ? Math.round((doneCount / prepItems.length) * 100) : 0;

  return (
    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
      <div className="bg-indigo-50 border-b border-indigo-100 px-5 py-3 flex items-center justify-between">
        <span className="text-sm font-bold text-indigo-800">Listing Prep Checklist</span>
        <span className="text-sm font-black text-indigo-700">{doneCount}/{prepItems.length} done</span>
      </div>
      <div className="h-1.5 bg-gray-100">
        <div className="h-full bg-indigo-400 transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="p-5 space-y-1">
        {loading && prepItems.length === 0 && (
          <p className="px-2 py-2.5 text-sm text-gray-400">Loading your checklist…</p>
        )}
        {!loading && prepItems.length === 0 && (
          <p className="px-2 py-2.5 text-sm text-gray-400">Your agent will add your prep checklist shortly.</p>
        )}
        {prepItems.map((item) => {
          const isDone = item.checked;
          return (
            <button
              key={item.id}
              onClick={() => toggle(item.id)}
              className="w-full flex items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-gray-50 active:bg-gray-100 transition-colors"
            >
              <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full transition-all ${
                isDone ? 'bg-green-400' : 'border-2 border-gray-200 hover:border-gray-300'
              }`}>
                {isDone && <CheckCircle2 size={12} className="text-white" />}
              </div>
              <span className={`text-sm transition-all ${isDone ? 'line-through text-gray-300' : 'text-gray-700'}`}>
                {item.label}
              </span>
            </button>
          );
        })}
        {prepItems.length > 0 && doneCount === prepItems.length && (
          <div className="mt-3 rounded-xl bg-green-50 border border-green-100 px-4 py-3 text-center">
            <p className="text-sm font-bold text-green-700">🎉 All prep items complete!</p>
            <p className="text-xs text-green-600 mt-0.5">Your agent will review and schedule your listing date.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ShowingAvailabilityModal ─────────────────────────────────────────────────

function ShowingAvailabilityModal({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const { saveSlots } = useShowingAvailability(dealId);
  const [enabled, setEnabled] = useState<Set<DayOfWeek>>(new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']));
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
    const slots: ShowingSlot[] = DAYS_OF_WEEK
      .filter((d) => enabled.has(d))
      .map((d) => ({ day: d, from: times[d].from, to: times[d].to }));
    await saveSlots(slots).catch(() => {});
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 px-4 pb-0">
      <div className="w-full max-w-lg rounded-t-2xl bg-white shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-xs font-bold uppercase tracking-widest text-gray-400">Showings</p>
          <h3 className="text-base font-black text-brand-navy">Set your showing availability</h3>
          <p className="text-xs text-gray-400 mt-0.5">Let your agent know when buyers can schedule tours of your home.</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {DAYS_OF_WEEK.map((day) => {
            const on = enabled.has(day);
            return (
              <div key={day} className={`rounded-xl border transition-all ${on ? 'border-brand-navy/20 bg-brand-navy/5' : 'border-gray-100 bg-gray-50'}`}>
                <div className="flex items-center gap-3 px-4 py-3">
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
        </div>
        <div className="border-t border-gray-100 px-5 py-4 space-y-2">
          <button
            onClick={save}
            disabled={enabled.size === 0}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-3.5 text-sm font-bold text-white disabled:opacity-40 hover:bg-brand-navy/90 transition-all"
          >
            Save my availability
          </button>
          <button onClick={onClose} className="w-full text-center text-xs text-gray-400 hover:text-gray-600 py-1 transition-colors">
            I&apos;ll do this later
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ListingActiveCard ────────────────────────────────────────────────────────

// Format an offer's close date defensively. `close_date` serializes to a
// UTC-midnight ISO string ("2026-08-15T00:00:00.000Z"); parsing that with
// `new Date(iso)` and formatting in a negative-offset timezone shifts the day
// backwards. Take the calendar-date PART only and build a local Date so the day
// can't drift. Falls back to the raw value if the shape is unexpected.
function formatCloseDate(value: string): string {
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return value;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function ListingActiveCard({ deal }: { deal: Deal }) {
  const [showAvailModal, setShowAvailModal] = useState(false);
  const { slots: availability } = useShowingAvailability(deal.id);
  const { offers, loading: offersLoading } = useOffers(deal.id);
  const daysOnMarket = deal.timeline.daysInStage ?? 0;

  function fmt(t: string) {
    const [h] = t.split(':');
    const n = parseInt(h);
    return n === 12 ? '12pm' : n > 12 ? `${n - 12}pm` : `${n}am`;
  }

  return (
    <div className="space-y-3">
      {/* Stats */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="bg-green-50 border-b border-green-100 px-5 py-3 flex items-center gap-2">
          <TrendingUp size={15} className="text-green-600" />
          <span className="text-sm font-bold text-green-800">You&apos;re live on the market</span>
        </div>
        <div className="p-5">
          <div className="rounded-xl bg-gray-50 px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock size={14} className="text-gray-400" />
              <span className="text-xs text-gray-400">Days Listed</span>
            </div>
            <p className="text-xl font-black text-brand-navy leading-none">{daysOnMarket}</p>
          </div>
        </div>
      </div>

      {/* Showing availability */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Calendar size={14} className="text-brand-navy" />
            <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Showing Availability</span>
          </div>
          <button
            onClick={() => setShowAvailModal(true)}
            className="text-xs font-semibold text-brand-navy hover:text-brand-navy/70 transition-colors"
          >
            {availability.length > 0 ? 'Edit' : 'Set availability'}
          </button>
        </div>
        {availability.length === 0 ? (
          <div className="px-5 py-5 text-center">
            <p className="text-sm text-gray-400">No availability set yet.</p>
            <button
              onClick={() => setShowAvailModal(true)}
              className="mt-2 rounded-lg bg-brand-navy px-4 py-2 text-xs font-bold text-white hover:bg-brand-navy/80 transition-colors"
            >
              Set my availability
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
        )}
      </div>

      {/* Offers — real offers only; an honest empty state when there are none */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-500">
            {offers.length > 0 ? `Offers Received (${offers.length})` : 'Offers'}
          </span>
        </div>
        {offers.length === 0 ? (
          !offersLoading && (
            <div className="px-5 py-6 text-center">
              <p className="text-sm text-gray-400">No offers yet.</p>
              <p className="mt-1 text-xs text-gray-300 leading-relaxed">
                When a buyer submits an offer, it will show up here and your agent will walk you through it.
              </p>
            </div>
          )
        ) : (
          <div className="divide-y divide-gray-50">
            {offers.map((offer) => (
              <div key={offer.id} className="px-5 py-4">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-lg font-black text-brand-navy">${offer.offerPrice.toLocaleString()}</p>
                    <p className="text-xs text-gray-400">
                      {offer.buyerName}{offer.closeDate ? ` · Close ${formatCloseDate(offer.closeDate)}` : ''}
                    </p>
                  </div>
                </div>
                {offer.contingencies.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {offer.contingencies.map((c) => (
                      <span key={c} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">{c}</span>
                    ))}
                  </div>
                )}
                {offer.agentNotes && (
                  <div className="rounded-lg bg-brand-navy/5 border border-brand-navy/10 px-3 py-2">
                    <p className="text-[11px] font-semibold text-brand-navy/60 uppercase tracking-wide mb-0.5">Agent Notes</p>
                    <p className="text-xs text-brand-navy leading-relaxed">{offer.agentNotes}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showAvailModal && (
        <ShowingAvailabilityModal dealId={deal.id} onClose={() => setShowAvailModal(false)} />
      )}
    </div>
  );
}

// ─── UnderContractCard ────────────────────────────────────────────────────────

function UnderContractCard({ deal }: { deal: Deal }) {
  const hasRepairRequest = deal.flags.includes('repair_request');
  // Agent-set "Buyer's Progress" (#184) — persisted server-side and delivered
  // on the /api/me/deals payload, so it survives reloads and reaches this
  // (seller) session. Steps come from the shared canonical list.
  const buyerStatus = deal.buyerStatus;

  const statusIdx = buyerStatus ? BUYER_STATUS_STEPS.indexOf(buyerStatus) : -1;

  return (
    <div className="space-y-3">
      {hasRepairRequest && (
        <div className="flex items-start gap-3 rounded-xl bg-orange-50 border border-orange-200 px-4 py-3">
          <Wrench size={18} className="text-orange-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-orange-800">Buyer submitted a repair request</p>
            <p className="text-xs text-orange-600 mt-0.5 leading-relaxed">
              Your agent is reviewing it. You&apos;ll need to respond — accept, reject, or counter — within the deadline. They&apos;ll be in touch shortly.
            </p>
          </div>
        </div>
      )}

      {deal.timeline.daysToClose !== undefined && (
        <div className="flex items-center justify-between rounded-xl bg-white border border-gray-100 shadow-sm px-5 py-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Calendar size={11} />
            <span>Target closing: {deal.timeline.closingDate}</span>
          </div>
          <div className="text-right">
            <span className="text-xl font-black text-brand-navy">{deal.timeline.daysToClose}</span>
            <span className="ml-1 text-xs text-gray-400">days to close</span>
          </div>
        </div>
      )}

      {/* Buyer status */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-5 py-3.5 border-b border-gray-100">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Buyer&apos;s Progress</span>
        </div>
        {!buyerStatus ? (
          <div className="px-5 py-4 text-center">
            <p className="text-sm text-gray-400">Your agent will update the buyer&apos;s status here.</p>
          </div>
        ) : (
          <div className="p-5 space-y-2">
            {BUYER_STATUS_STEPS.map((step, i) => {
              const isPast = i < statusIdx;
              const isCurrent = i === statusIdx;
              return (
                <div key={step} className="flex items-center gap-3">
                  <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                    isCurrent ? 'bg-brand-navy' : isPast ? 'bg-green-400' : 'border-2 border-gray-200'
                  }`}>
                    {isPast && <CheckCircle2 size={11} className="text-white" />}
                    {isCurrent && <div className="h-2 w-2 rounded-full bg-white" />}
                  </div>
                  <span className={`text-sm ${
                    isCurrent ? 'font-bold text-brand-navy' : isPast ? 'text-green-600 line-through' : 'text-gray-300'
                  }`}>{step}</span>
                  {isCurrent && (
                    <span className="ml-auto rounded-full bg-brand-gold/20 px-2 py-0.5 text-[10px] font-bold text-brand-navy">
                      Current
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <NetSheetReadOnlyCard dealId={deal.id} compact />
    </div>
  );
}

function PreCloseCard({ deal }: { deal: Deal }) {
  // Persisted, clickable pre-close checklist (#261) — seller-assigned items from
  // the same deal checklist the agent sees. Was a static, non-interactive array.
  const { items, loading, toggle } = useChecklist(deal.id);
  const preCloseItems = items.filter((i) => i.assignedTo === 'seller');
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="bg-blue-50 border-b border-blue-100 px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Star size={15} className="text-blue-600" />
            <span className="text-sm font-bold text-blue-800">Almost at the finish line</span>
          </div>
          {deal.timeline.daysToClose !== undefined && (
            <span className="text-sm font-black text-blue-700">{deal.timeline.daysToClose} days</span>
          )}
        </div>
        <div className="p-5 space-y-2.5">
          {loading && preCloseItems.length === 0 && (
            <p className="text-sm text-gray-400">Loading your checklist…</p>
          )}
          {!loading && preCloseItems.length === 0 && (
            <p className="text-sm text-gray-400">Your agent will add your pre-close checklist shortly.</p>
          )}
          {preCloseItems.map((item) => {
            const isDone = item.checked;
            return (
              <button
                key={item.id}
                onClick={() => toggle(item.id)}
                className="w-full flex items-center gap-3 text-left rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
              >
                <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                  isDone ? 'bg-green-400' : 'border-2 border-gray-200'
                }`}>
                  {isDone && <CheckCircle2 size={12} className="text-white" />}
                </div>
                <span className={`text-sm ${isDone ? 'line-through text-gray-300' : 'text-gray-700'}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <NetSheetReadOnlyCard dealId={deal.id} compact />
    </div>
  );
}

function ClosingCard({ deal }: { deal: Deal }) {
  const checklist = [
    'Government-issued photo ID',
    'All keys, garage openers & access codes',
    'Any manuals / warranty documents for the home',
    'Forward your mail before you leave',
  ];
  return (
    <div className="rounded-2xl overflow-hidden">
      <div className="bg-brand-gold px-5 py-4">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-navy/60">Closing Day</p>
        <p className="text-xl font-black text-brand-navy mt-0.5">Today&apos;s the day!</p>
        <p className="text-sm text-brand-navy/70 mt-1">
          Sale price: {formatMoney(deal.property.price)}
        </p>
      </div>
      <div className="bg-white border border-brand-gold/30 rounded-b-2xl p-5 space-y-2.5">
        {checklist.map((item, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-gold/20">
              <span className="text-[10px] font-bold text-brand-navy">{i + 1}</span>
            </div>
            <span className="text-sm text-gray-700">{item}</span>
          </div>
        ))}
        <div className="pt-2 border-t border-gray-100 mt-2">
          <p className="text-xs text-gray-400 leading-relaxed">
            Your agent will be at closing with you. Net proceeds will be wired to you within 1–2 business days.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── PostCloseCard ────────────────────────────────────────────────────────────

function NetSheetReadOnlyCard({ dealId, compact }: { dealId: string; compact?: boolean }) {
  const { sheet, loading, notReady } = useNetSheet(dealId);
  if (loading) return null;
  if (notReady || !sheet || sheet.status !== 'ready') return null;
  const lines = recalcLines(sheet.lines, sheet.salePrice, sheet.annualTaxes, sheet.closingDate);
  const netProceeds = calcNetProceeds(lines, sheet.salePrice);
  const enabledLines = lines.filter((l) => l.enabled && l.amount > 0);

  if (compact) {
    return (
      <div className="rounded-xl bg-white border border-gray-100 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Estimated Net Proceeds</span>
          <span className="text-sm font-black text-green-600">${netProceeds.toLocaleString()}</span>
        </div>
        <div className="px-4 py-2 text-[11px] text-gray-400">
          Your agent has shared your net sheet. See full breakdown on your post-close page.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 py-3.5 border-b border-gray-100">
        <span className="text-xs font-bold uppercase tracking-widest text-gray-500">Estimated Net Proceeds</span>
      </div>
      <div className="px-5 py-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Sale Price</span>
          <span className="text-sm font-semibold text-brand-navy">+${sheet.salePrice.toLocaleString()}</span>
        </div>
        {enabledLines.map((l) => (
          <div key={l.id} className="flex items-center justify-between">
            <span className="text-sm text-gray-600">{l.label}{l.isPct && l.pct ? ` (${l.pct}%)` : ''}</span>
            <span className="text-sm font-semibold text-gray-500">-${l.amount.toLocaleString()}</span>
          </div>
        ))}
        <div className="border-t border-gray-100 pt-2.5 flex items-center justify-between">
          <span className="text-base font-black text-brand-navy">Estimated Net</span>
          <span className={`text-2xl font-black ${netProceeds >= 0 ? 'text-green-600' : 'text-red-500'}`}>
            ${netProceeds.toLocaleString()}
          </span>
        </div>
        <p className="text-[10px] text-gray-300 leading-relaxed">
          Estimate only — actual figures provided by title at closing.
        </p>
      </div>
    </div>
  );
}

function PostCloseCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  const [showReferral, setShowReferral] = useState(false);
  const [copied, setCopied] = useState(false);
  const referralUrl = 'realtourflow.com/refer';

  async function copyReferral() {
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can reject (insecure context / permission denied). Leave the
      // link on screen so the seller can still select and copy it manually.
    }
  }

  return (
    <div className="space-y-3">
      {/* Hero */}
      <div className="rounded-2xl bg-gradient-to-br from-purple-600 to-indigo-700 p-5 text-white">
        <div className="flex items-center gap-2 mb-2">
          <DollarSign size={20} className="text-white" />
          <p className="text-xs font-bold uppercase tracking-widest text-white/60">Congratulations!</p>
        </div>
        <p className="text-xl font-black">{firstName}, you sold it!</p>
        <p className="text-sm text-white/70 mt-1">{deal.property.address}</p>
        <div className="mt-3 rounded-xl bg-white/10 px-4 py-3">
          <p className="text-xs text-white/60">Final sale price</p>
          <p className="text-2xl font-black">{formatMoney(deal.property.price)}</p>
        </div>
      </div>

      {/* Net sheet */}
      <NetSheetReadOnlyCard dealId={deal.id} />

      {/* Review ask */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-5">
        <p className="text-sm font-black text-brand-navy mb-1">Leave us a quick review ⭐</p>
        <p className="text-xs text-gray-500 leading-relaxed mb-3">
          It only takes 23 seconds — and it means the world to us. Your review helps other families find the same great experience you had.
        </p>
        <a
          href="https://g.page/r/Cc0FtBCr37KfEBM/review"
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
        >
          ⭐ Leave a 5-Star Review (23 seconds)
        </a>
      </div>

      {/* Referral ask */}
      <div className="rounded-2xl border-2 border-brand-gold/40 bg-brand-gold/5 p-5">
        <p className="text-sm font-black text-brand-navy mb-1">Earn $50 per referral 🤝</p>
        <p className="text-xs text-gray-600 leading-relaxed mb-3">
          Know someone buying or selling? Send them our way and we&apos;ll pay you $50 for every referral who completes a transaction with us.
        </p>
        <button
          onClick={() => setShowReferral(true)}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-gold py-3 text-sm font-bold text-brand-navy hover:bg-brand-gold/90 transition-colors"
        >
          Refer a friend →
        </button>
      </div>

      {/* What's next */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">What&apos;s Next</p>
        <div className="space-y-2.5">
          {[
            { icon: Mail,     label: 'Update your mailing address everywhere' },
            { icon: Home,     label: 'Transfer or cancel utilities' },
            { icon: FileText, label: 'Keep your closing documents (tax time)' },
          ].map(({ icon: Icon, label }, i) => (
            <div key={i} className="flex items-center gap-3">
              <Icon size={14} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Referral modal */}
      {showReferral && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl p-6">
            <div className="text-center mb-4">
              <div className="text-4xl mb-2">🤝</div>
              <h3 className="text-xl font-black text-brand-navy">Refer a Friend, Earn $50</h3>
            </div>
            <p className="text-sm text-gray-600 leading-relaxed text-center mb-5">
              Please refer us to all your friends and family who would love to share the same awesome experience you had with your home transaction. We will pay you <strong>$50 for every referral</strong> you send our way who completes a transaction with us.
            </p>
            <div className="rounded-xl bg-gray-50 border border-gray-200 px-4 py-3 mb-4 flex items-center gap-2">
              <p className="flex-1 text-xs font-mono text-gray-600 truncate">{referralUrl}</p>
              <button
                onClick={copyReferral}
                className="text-xs font-bold text-brand-navy hover:text-brand-navy/70 transition-colors flex-shrink-0"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <button
              onClick={() => setShowReferral(false)}
              className="w-full rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
            >
              Got it!
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FallenThroughCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-gray-800 p-5 text-white">
        <div className="flex items-center gap-2 mb-2">
          <XCircle size={18} className="text-red-400" />
          <p className="text-xs font-bold uppercase tracking-widest text-white/50">Deal Fell Through</p>
        </div>
        <p className="text-lg font-bold">We&apos;re sorry, {firstName}.</p>
        {deal.fallReason && (
          <p className="text-sm text-white/60 mt-2 leading-relaxed">{deal.fallReason}</p>
        )}
      </div>
      <div className="rounded-2xl border border-purple-100 bg-purple-50 px-5 py-4">
        <p className="text-sm font-bold text-purple-800 mb-1">What happens next</p>
        <p className="text-xs text-purple-600 leading-relaxed">
          Your agent will discuss your options — whether that means going back on the market,
          re-negotiating, or a different approach. You&apos;re still in good hands.
        </p>
        <div className="mt-3 flex gap-2">
          <a href="tel:+12055550100"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-bold text-white hover:bg-purple-700 transition-colors">
            <Phone size={12} /> Call Agent
          </a>
          <a href="mailto:sarah@realtourflow.com"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-white border border-purple-200 px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-50 transition-colors">
            <Mail size={12} /> Email Agent
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── Stage card dispatcher ────────────────────────────────────────────────────

function StageCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  if (deal.status === 'fallen_through') return <FallenThroughCard deal={deal} firstName={firstName} />;
  switch (deal.stage) {
    case 'intake':         return <IntakeCard deal={deal} firstName={firstName} />;
    case 'active_search':  return <ListingPrepCard deal={deal} />;
    case 'offer_active':   return <ListingActiveCard deal={deal} />;
    case 'under_contract': return <UnderContractCard deal={deal} />;
    case 'pre_close':      return <PreCloseCard deal={deal} />;
    case 'closing':        return <ClosingCard deal={deal} />;
    case 'post_close':     return <PostCloseCard deal={deal} firstName={firstName} />;
  }
}

// ─── Smooth Exit pitch ────────────────────────────────────────────────────────

function SmoothExitPitch({ dealId }: { dealId: string }) {
  const router = useRouter();
  return (
    <div className="rounded-2xl overflow-hidden border-2 border-purple-200 bg-purple-50">
      <div className="p-5">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🚪</span>
          <span className="text-xs font-bold uppercase tracking-widest text-purple-600">Seller Concierge</span>
        </div>
        <div className="text-lg font-black text-purple-900">Smooth Exit</div>
        <p className="mt-1.5 text-sm text-purple-800/80 leading-relaxed">
          We coordinate your move-out, handle utility cancellations, get repair bids, and support you all the way through closing — so you can focus on what&apos;s next.
        </p>
        <div className="mt-3 inline-block rounded-lg bg-purple-100 px-3 py-1.5 text-sm font-black text-purple-800">
          1% of sale price · paid from proceeds
        </div>
        <div className="mt-2 rounded-lg bg-white border border-purple-200 px-3 py-2 text-xs text-purple-700 font-medium">
          🏡 Includes Buy Before You Sell — buy your next home before this one closes
        </div>
      </div>
      <div className="border-t border-purple-200 px-5 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push(`/smooth-exit?dealId=${dealId}`)}
          className="text-xs font-semibold text-purple-700 hover:text-purple-900 transition-colors"
        >
          Learn more →
        </button>
        <button
          onClick={() => router.push(`/smooth-exit/survey?dealId=${dealId}`)}
          className="ml-auto rounded-xl bg-purple-700 px-5 py-2 text-xs font-bold text-white hover:bg-purple-800 transition-colors active:scale-[0.98]"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SellerView() {
  const activeUser = useAuthStore((s) => s.activeUser);
  const [activeTab, setActiveTab] = useState<Tab>('tasks');
  const [showWelcome, setShowWelcome] = useState(() => {
    const flag = sessionStorage.getItem('seller_welcomed');
    if (flag) { sessionStorage.removeItem('seller_welcomed'); return true; }
    return false;
  });

  // Notifications feed both <ClientNotifications /> and the Messages tab badge below.
  const { notifications, markRead } = useNotifications();
  const { deals, loading: dealsLoading, error: dealsError, refresh: refreshDeals } = useMyDeals();
  const deal = deals.find((d) => d.type === 'sell');
  const { tasks, refresh: refreshTasks } = useTasks(deal?.id ?? '');
  const { completedIds, error: completeError, complete: handleComplete, uncomplete: handleUncomplete } = useTaskCompletion(refreshTasks);
  const sellerTasks = tasks.filter((t) => t.assignedTo === 'seller');
  // Real status ∪ the in-flight optimistic check. Partitioning the same array
  // two ways also de-dupes the count a refetched 'completed' task used to inflate.
  const isTaskDone = (t: Task) => t.status === 'completed' || completedIds.has(t.id);
  const openTasks = sellerTasks.filter((t) => !isTaskDone(t));
  // #408: completed tasks are RENDERED, not just counted.
  const doneTasks = sellerTasks.filter(isTaskDone);
  const completedCount = doneTasks.length;
  const { slots: availability } = useShowingAvailability(deal?.id);
  const [showingModalDismissed, setShowingModalDismissed] = useState(
    () => !!sessionStorage.getItem(`showing_avail_prompted_${deal?.id ?? ''}`)
  );

  if (dealsLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Loader2 size={24} className="text-brand-navy animate-spin" />
      </div>
    );
  }

  if (dealsError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <p className="text-sm text-gray-400">Unable to load your deal.</p>
        <button
          onClick={refreshDeals}
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-gray-400 text-sm">No active deal found.</p>
      </div>
    );
  }

  const firstName = activeUser?.name.split(' ')[0] ?? 'there';
  const isFallenThrough = deal.status === 'fallen_through';

  // Unread "new_message" notifications for THIS deal drive the Messages tab badge.
  const unreadMessageNotifications = notifications.filter(
    (n) => n.dealId === deal.id && n.type === 'new_message' && !n.read,
  );
  const handleTabChange = (t: Tab) => {
    setActiveTab(t);
    // Opening Messages clears the badge — mark this deal's unread messages read.
    if (t === 'messages') {
      unreadMessageNotifications.forEach((n) => { void markRead(n.id); });
    }
  };

  // ── #422: what goes in which section, and which section leads ──────────────
  const hasOverdue = !isFallenThrough && sellerTasks.some((t) => t.status === 'overdue');
  const showTabs = !isFallenThrough && deal.stage !== 'post_close';
  // A fallen-through deal has no tabs but does still get the message thread, so
  // the client's section is never a heading over nothing.
  const showActions = showTabs || isFallenThrough || hasOverdue;
  const actionsFirst = hasOverdue || openTasks.length > 0;
  const stageFocus = SELLER_STAGE_FOCUS[deal.stage];

  const actionsSection = showActions ? (
    <PortalSection
      key="actions"
      testId="portal-actions"
      title={isFallenThrough ? 'Talk to your agent' : 'What you need to do'}
      blurb={
        isFallenThrough
          ? "The sale didn't close. Your agent will walk you through what happens next."
          : "Your side of the sale — your to-do list, your messages, and your paperwork. Everything else is your agent's to handle."
      }
    >
      {/* Overdue alert */}
      {hasOverdue && (
        <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">You have overdue tasks</p>
            <p className="text-xs text-red-400">Your agent is waiting — take a look below</p>
          </div>
        </div>
      )}

      {/* Tabs */}
      {showTabs && (
        <>
          <TabBar
            active={activeTab}
            onChange={handleTabChange}
            taskCount={openTasks.length}
            msgCount={unreadMessageNotifications.length}
          />
          {activeTab === 'tasks' && (
            <div className="space-y-2">
              {completeError && (
                <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                  <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
                  <p className="text-xs font-medium text-red-600">{completeError}</p>
                </div>
              )}
              {openTasks.length === 0 && (
                <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-green-400" />
                  <p className="text-sm font-medium text-gray-500">
                    {deal.stage === 'intake' ? 'Tasks unlock after your consultation.' : 'All caught up — great work!'}
                  </p>
                </div>
              )}
              {openTasks.filter((t) => t.status === 'overdue').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} />)}
              {openTasks.filter((t) => t.status === 'in_progress').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} />)}
              {openTasks.filter((t) => t.status === 'pending').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} />)}
              {completedCount > 0 && (
                <p className="text-center text-xs text-gray-300 pt-1">
                  {completedCount} task{completedCount !== 1 ? 's' : ''} completed
                </p>
              )}
              {doneTasks.map((t) => <TaskCard key={t.id} task={t} done onUncomplete={handleUncomplete} />)}
            </div>
          )}
          {activeTab === 'messages' && <MessagesTab dealId={deal.id} />}
          {activeTab === 'documents' && <PortalDealDocuments dealId={deal.id} />}
        </>
      )}

      {isFallenThrough && <MessagesTab dealId={deal.id} />}
    </PortalSection>
  ) : null;

  const stageSection = (
    <PortalSection
      key="stage"
      testId="portal-stage"
      title={isFallenThrough ? 'Where things stand' : stageFocus.title}
      blurb={
        isFallenThrough
          ? 'This sale fell through. Your agent is working out the next move with you.'
          : stageFocus.blurb
      }
    >
      <StageCard deal={deal} firstName={firstName} />

      {/* Smooth Exit pitch — only if not enrolled */}
      {!deal.smoothExit?.status && !isFallenThrough && deal.stage !== 'post_close' && (
        <SmoothExitPitch dealId={deal.id} />
      )}
    </PortalSection>
  );

  return (
    /*
     * Responsive shell (#421) — mirrors BuyerView, with #422's content
     * placement on top of it. Below `lg` one narrow column; at `lg` a
     * two-column grid.
     *
     * THE TRAP: the columns are placed EXPLICITLY — `lg:row-start-2` hard-codes
     * the band as row 1, so a fourth top-level wrapper would overlap rather
     * than flow. This stays at exactly three grid children (band / primary /
     * secondary); everything #422 adds goes INSIDE one of them. Both modals are
     * `position: fixed`, so they're out of flow and never become grid items.
     */
    <div
      data-testid="portal-root"
      className="mx-auto max-w-lg space-y-4 pb-10 md:max-w-2xl lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-x-6 lg:gap-y-4 lg:space-y-0"
    >
      {/* Auto showing availability modal for offer_active stage */}
      {deal.stage === 'offer_active' && availability.length === 0 && !showingModalDismissed && (
        <ShowingAvailabilityModal
          dealId={deal.id}
          onClose={() => {
            sessionStorage.setItem(`showing_avail_prompted_${deal.id}`, '1');
            setShowingModalDismissed(true);
          }}
        />
      )}

      {/* Full-width band above the columns */}
      <div className="space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
      <ClientNotifications />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-brand-navy">
          {isFallenThrough ? `Hi, ${firstName}` : `Hi, ${firstName}!`}
        </h1>
        <div className={`mt-3 rounded-2xl bg-white shadow-sm p-4 ${
          isFallenThrough ? 'border-l-4 border-l-gray-400' :
          deal.health === 'green'  ? 'border-l-4 border-l-green-400' :
          deal.health === 'yellow' ? 'border-l-4 border-l-amber-400' :
                                     'border-l-4 border-l-red-400'
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5">
                <MapPin size={11} />
                <span className="truncate">{deal.property.address}, {deal.property.city}</span>
              </div>
              <p className="font-bold text-brand-navy text-lg">{formatMoney(deal.property.price)}</p>
              {deal.smoothExit?.status === 'active' && (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-purple-100 border border-purple-200 px-2 py-0.5 text-[11px] font-bold text-purple-700">
                  Smooth Exit Active
                </span>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                isFallenThrough
                  ? 'bg-gray-100 text-gray-500 border-gray-200'
                  : deal.health === 'green'  ? 'bg-green-100 text-green-700 border-green-200'
                  : deal.health === 'yellow' ? 'bg-amber-100 text-amber-700 border-amber-200'
                  :                            'bg-red-100 text-red-700 border-red-200'
              }`}>
                {isFallenThrough ? 'Fell Through' : SELLER_STAGE_LABELS[deal.stage]}
              </span>
              {deal.timeline.closingDate && !isFallenThrough && (
                <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-gray-400">
                  <Calendar size={10} /> Closing {deal.timeline.closingDate}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Where you are + who moves this on (#422) — on every stage. */}
      <PortalStageHeader
        accent="purple"
        stageLabel={isFallenThrough ? 'Fell Through' : SELLER_STAGE_LABELS[deal.stage]}
        description={
          isFallenThrough
            ? "This sale didn't close. Your agent will talk you through your options."
            : SELLER_STAGE_DESCRIPTIONS[deal.stage]
        }
      />
      </div>

      {/* Primary column — the seller's own work, and the stage's own cards. */}
      <div data-testid="portal-primary" className="space-y-6 lg:col-start-1 lg:row-start-2">
        {actionsFirst ? [actionsSection, stageSection] : [stageSection, actionsSection]}
      </div>

      {/* Secondary column — reference. Nothing here needs the seller to act. */}
      <div data-testid="portal-secondary" className="space-y-6 lg:col-start-2 lg:row-start-2">
        <PortalSection
          testId="portal-progress"
          title="Your selling journey"
          blurb="Every step of the sale, and where you are in it."
        >
          <JourneyTracker deal={deal} openTasks={openTasks} />
        </PortalSection>

        <PortalSection
          testId="portal-team"
          title="Your team"
          blurb="The people working your sale, and how to reach them."
        >
          <VendorDirectory dealId={deal.id} />
          <AgentCard agentName={deal.agentName} agentEmail={deal.agentEmail} agentPhone={deal.agentPhone} />
        </PortalSection>
      </div>

      {/* Welcome modal — shown once after onboarding completes */}
      {showWelcome && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl bg-white shadow-2xl overflow-hidden">
            <div className="bg-gradient-to-br from-purple-600 to-indigo-700 px-6 pt-8 pb-6 text-center">
              <div className="text-5xl mb-3">🏡</div>
              <h2 className="text-2xl font-black text-white leading-snug">
                You&apos;re all set!
              </h2>
            </div>
            <div className="px-6 py-6 text-center">
              <p className="text-base text-gray-700 leading-relaxed">
                Thank you so much. Your agent will reach out with next steps. They are starting to prepare your house to sell like a pro.
              </p>
              <button
                onClick={() => setShowWelcome(false)}
                className="mt-6 w-full rounded-xl bg-purple-700 py-3.5 text-base font-bold text-white hover:bg-purple-800 transition-all active:scale-[0.98]"
              >
                Got it!
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
