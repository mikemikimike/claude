"use client";

import { useState } from 'react';
import Link from "next/link";
import { useAuthStore } from "@/lib/store/authStore";
import { useSettings } from "@/hooks/useSettings";
import { Deal, Task } from "@/lib/types";
import { AGENT_STAGE_LABELS as STAGE_LABELS } from "@/lib/stages";
import { useDeals, CLOSED_DEAL_STATUSES } from "@/hooks/useDeals";
import { useAgentTasks } from "@/hooks/useTasks";
import { useNotifications, AppNotification } from "@/hooks/useNotifications";
import {
  formatCompactMoney,
  formatMoney,
  pipelineCommission,
  pipelinePrice,
  sumKnown,
} from "@/lib/deal-money";
import { TrendingUp, Layers, CheckSquare, ArrowRight, Clock, AlertCircle, CheckCircle2, DollarSign, Share2, X, Phone, Archive } from 'lucide-react';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Stat-card currency. Delegates to the shared helper (#411) so an amount the
 * app doesn't know renders as "—" rather than "$0"; the two-decimal millions
 * form is this dashboard's long-standing precision.
 */
function formatCurrency(n: number | null) {
  return formatCompactMoney(n, 2);
}

const HEALTH_BORDER: Record<string, string> = {
  green: 'border-l-4 border-l-green-400',
  yellow: 'border-l-4 border-l-amber-400',
  red: 'border-l-4 border-l-red-400',
};

const HEALTH_DOT: Record<string, string> = {
  green: 'bg-green-400',
  yellow: 'bg-amber-400',
  red: 'bg-red-400',
};

const TASK_STATUS_COLORS: Record<string, string> = {
  in_progress: 'text-blue-600 bg-blue-50',
  overdue: 'text-red-600 bg-red-50',
  pending: 'text-gray-600 bg-gray-100',
  completed: 'text-green-600 bg-green-50',
  blocked: 'text-orange-600 bg-orange-50',
};

// ─── Sub-components ─────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color }: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-white px-5 py-4 shadow-sm">
      <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg ${color}`}>
        <Icon size={20} className="text-white" />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-black text-brand-navy leading-none">{value}</div>
        <div className="mt-0.5 text-xs font-medium text-gray-400 uppercase tracking-wide truncate">{label}</div>
        {sub && <div className="mt-0.5 text-[11px] text-gray-400 truncate">{sub}</div>}
      </div>
    </div>
  );
}

function TaskRow({ task, deal }: { task: Task; deal?: Deal }) {
  return (
    <Link
      href={deal ? `/agent/deals/${deal.id}` : '#'}
      className="block rounded-xl px-4 py-3.5 hover:bg-brand-bg transition-colors group border border-transparent hover:border-gray-100"
    >
      {/* Client name — primary identifier */}
      {deal && (
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-sm font-bold text-brand-navy truncate group-hover:text-brand-navy/80">
            {deal.clientName}
          </span>
          <span className="flex-shrink-0 text-[10px] font-semibold text-gray-400 uppercase tracking-wide">
            {STAGE_LABELS[deal.stage]}
          </span>
        </div>
      )}
      {/* Task title */}
      <div className="text-xs text-gray-600 leading-relaxed truncate">{task.title}</div>
      {/* Footer: status pill + due date */}
      <div className="flex items-center gap-2 mt-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${TASK_STATUS_COLORS[task.status]}`}>
          {task.status.replace('_', ' ')}
        </span>
        {task.dueDate && (
          <span className="text-[10px] text-gray-300">Due {task.dueDate}</span>
        )}
        <ArrowRight size={12} className="ml-auto flex-shrink-0 text-gray-200 group-hover:text-brand-gold transition-colors" />
      </div>
    </Link>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const openTasks = deal.openTaskCount ?? 0;

  return (
    <Link
      href={`/agent/deals/${deal.id}`}
      className={`flex items-center gap-4 rounded-xl bg-white px-4 py-3 shadow-sm hover:shadow-md transition-shadow ${HEALTH_BORDER[deal.health]} group`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-semibold text-brand-navy text-sm truncate">{deal.clientName}</span>
          <span className={`flex-shrink-0 inline-block h-2 w-2 rounded-full ${HEALTH_DOT[deal.health]}`} />
        </div>
        <div className="text-xs text-gray-400 truncate">
          {[deal.property.address, deal.property.city].filter(Boolean).join(', ')}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-xs font-semibold text-brand-navy">{STAGE_LABELS[deal.stage]}</div>
        <div className="text-[11px] text-gray-400 mt-0.5">{openTasks} open task{openTasks !== 1 ? 's' : ''}</div>
      </div>
      <ArrowRight size={14} className="flex-shrink-0 text-gray-300 group-hover:text-brand-gold transition-colors" />
    </Link>
  );
}

function Section({ icon: Icon, title, color, children, count, id, emptyText }: {
  icon: React.ElementType;
  title: string;
  color: string;
  children: React.ReactNode;
  count: number;
  /** Anchor target, so other pages can deep-link straight to a section. */
  id?: string;
  emptyText?: string;
}) {
  return (
    <section id={id} className="rounded-xl bg-white shadow-sm overflow-hidden">
      <div className={`flex items-center gap-2.5 px-5 py-3.5 border-b ${color}`}>
        <Icon size={16} />
        <h2 className="font-semibold text-sm tracking-wide">{title}</h2>
        <span className="ml-auto rounded-full bg-white/60 px-2 py-0.5 text-xs font-bold">{count}</span>
      </div>
      <div className="p-2">
        {count === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-400 text-center">
            {emptyText ?? 'Nothing here — nice work!'}
          </p>
        ) : (
          children
        )}
      </div>
    </section>
  );
}

// ─── Completed deals (#417) ─────────────────────────────────────────────────

/**
 * How a closed deal ended.
 *
 * There is deliberately no `completed` lifecycle status: `deals.stage` already
 * records the successful ending, so "we closed it" is `archived` reached from
 * `post_close`, and "I filed it away" is `archived` from anywhere earlier. The
 * distinction is derived rather than stored — see the PR for #417.
 */
function closedOutcome(deal: Deal): { label: string; className: string } {
  if (deal.status === 'fallen_through') {
    return { label: 'Fell through', className: 'bg-red-50 text-red-600 border-red-200' };
  }
  if (deal.stage === 'post_close') {
    return { label: 'Closed', className: 'bg-green-50 text-green-700 border-green-200' };
  }
  return { label: 'Archived', className: 'bg-gray-100 text-gray-500 border-gray-200' };
}

function CompletedDealRow({ deal }: { deal: Deal }) {
  const outcome = closedOutcome(deal);
  return (
    <Link
      href={`/agent/deals/${deal.id}`}
      className="flex items-center gap-4 rounded-xl bg-white px-4 py-3 shadow-sm hover:shadow-md transition-shadow border border-gray-100 group"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className="font-semibold text-brand-navy text-sm truncate">{deal.clientName}</span>
          <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${outcome.className}`}>
            {outcome.label}
          </span>
        </div>
        <div className="text-xs text-gray-400 truncate">
          {[deal.property.address, deal.property.city].filter(Boolean).join(', ')}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        {/* #411 — an unpriced deal shows the em-dash, never a confident "$0". */}
        <div className="text-xs font-semibold text-brand-navy">{formatMoney(deal.property.price)}</div>
        <div className="text-[11px] text-gray-400 mt-0.5">
          {deal.timeline.closingDate ? `Closed ${deal.timeline.closingDate}` : 'No close date'}
        </div>
      </div>
      <ArrowRight size={14} className="flex-shrink-0 text-gray-300 group-hover:text-brand-gold transition-colors" />
    </Link>
  );
}

// ─── Notification Banner ─────────────────────────────────────────────────────

function NotificationBanner({ notification, onDismiss }: {
  notification: AppNotification;
  onDismiss: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-brand-navy px-5 py-4 text-white shadow-lg">
      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand-gold text-brand-navy">
        <Phone size={15} strokeWidth={2.5} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-brand-gold">
          Action Needed — Call Now
        </div>
        <div className="font-bold leading-snug">{notification.title}</div>
        <div className="mt-0.5 text-sm text-white/70">{notification.body}</div>
      </div>
      <button
        onClick={onDismiss}
        className="mt-0.5 flex-shrink-0 text-white/40 transition-colors hover:text-white"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}

// ─── Share Fast Pass Button ───────────────────────────────────────────────────

function ShareFastPassButton() {
  const [copied, setCopied] = useState(false);

  function handleShare() {
    const url = `${window.location.origin}/fast-pass`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleShare}
      className={[
        'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold shadow-sm transition-all',
        copied
          ? 'bg-green-500 text-white'
          : 'bg-brand-gold text-brand-navy hover:bg-brand-gold-dark',
      ].join(' ')}
    >
      {copied ? (
        <><CheckCircle2 size={13} /> Link Copied!</>
      ) : (
        <><Share2 size={13} /> Share Fast Pass</>
      )}
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

function firstNameFor(activeUser: { name?: string; email?: string } | undefined, settingsName: string | undefined): string {
  const candidates = [settingsName, activeUser?.name]
    .map((n) => (n ?? '').trim())
    .filter(Boolean)
    .filter((n) => n !== activeUser?.email && !/@/.test(n));
  const fullName = candidates[0];
  if (fullName) return fullName.split(/\s+/)[0];
  // Fall back to the local-part of the email so we never greet someone with their full email.
  const email = (activeUser?.email ?? '').split('@')[0];
  if (!email) return 'there';
  // Strip dots/underscores, capitalize.
  const cleaned = email.replace(/[._-]/g, ' ').split(/\s+/)[0];
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export default function AgentDashboard() {
  const activeUser = useAuthStore((s) => s.activeUser);
  const { settings } = useSettings();
  const { notifications, markRead } = useNotifications();
  const unread = notifications.filter((n) => !n.read);

  const { tasks: allTasks } = useAgentTasks();
  const { deals: agentDeals } = useDeals();
  // #417 — a second, separately cached query for the deals that are over.
  // Kept out of `agentDeals` on purpose: every stat and section above is the
  // ACTIVE pipeline, and folding closed deals in would silently change them.
  const { deals: completedDeals } = useDeals(CLOSED_DEAL_STATUSES);

  // ── Stats ────────────────────────────────────────────────────────────────
  // #459 — a deal counts toward Pipeline Value once it is UNDER CONTRACT, at
  // its contract price; an offer that could still be rejected is not pipeline.
  // #411 — and total only the deals whose price the app actually knows: a
  // pipeline with nothing under contract is `null`, which the stat card
  // renders as "—" instead of a confident "$0".
  const pipelineValue = sumKnown(agentDeals.map(pipelinePrice));
  const activeDeals = agentDeals.length;

  const today = new Date().toISOString().slice(0, 10);
  const tasksDueToday = allTasks.filter(
    (t) => t.status !== 'completed' &&
           (t.dueDate === today || t.status === 'overdue')
  ).length;

  // ── Needs Your Action ───────────────────────────────────────────────────
  // Tasks assigned to agent that are in_progress or overdue
  const needsActionTasks = allTasks.filter(
    (t) =>
      t.assignedTo === 'agent' &&
      (t.status === 'in_progress' || t.status === 'overdue' ||
       (t.status === 'pending' && t.priority === 'high'))
  );

  // ── Waiting on Client ───────────────────────────────────────────────────
  // Tasks assigned to buyer/seller that are overdue, in_progress, or high-priority pending
  const waitingTasks = allTasks.filter(
    (t) =>
      (t.assignedTo === 'buyer' || t.assignedTo === 'seller') &&
      (t.status === 'overdue' || t.status === 'in_progress' || (t.status === 'pending' && t.priority === 'high'))
  );

  // ── On Track ────────────────────────────────────────────────────────────
  // Deals with health=green OR all open tasks are normal pending (no overdue/in_progress urgency)
  const onTrackDeals = agentDeals.filter((deal) => {
    if (deal.health === 'green') return true;
    const dealTasks = allTasks.filter((t) => t.dealId === deal.id);
    const hasUrgent = dealTasks.some(
      (t) => t.status === 'overdue' || t.status === 'in_progress'
    );
    return !hasUrgent;
  });

  const getDealForTask = (task: Task) => agentDeals.find((d) => d.id === task.dealId);

  // Exactly the deals Pipeline Value counts, by construction (#459).
  const estCommission = sumKnown(agentDeals.map(pipelineCommission));
  const fastPassCount = agentDeals.filter((d) => d.fastPass?.status === 'active').length;

  return (
    <div className="max-w-4xl space-y-6">
      {/* Notification banners */}
      {unread.map((n) => (
        <NotificationBanner key={n.id} notification={n} onDismiss={() => markRead(n.id)} />
      ))}

      {/* Greeting */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">
            Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, {firstNameFor(activeUser, settings.name as string | undefined)}
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>
        {/* Quick actions */}
        <div className="flex items-center gap-2">
          <Link
            href="/agent/pipeline"
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 shadow-sm hover:bg-gray-50 transition-colors"
          >
            <Layers size={13} /> Pipeline
          </Link>
          <Link
            href="/agent/messages"
            className="flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-600 shadow-sm hover:bg-gray-50 transition-colors"
          >
            <Clock size={13} /> Messages
          </Link>
          <ShareFastPassButton />
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={TrendingUp}
          label="Pipeline Value"
          value={formatCurrency(pipelineValue)}
          color="bg-brand-navy"
        />
        <StatCard
          icon={Layers}
          label="Active Deals"
          value={String(activeDeals)}
          sub={`${agentDeals.filter(d => d.type === 'buy').length} buy · ${agentDeals.filter(d => d.type === 'sell').length} sell`}
          color="bg-blue-500"
        />
        <StatCard
          icon={CheckSquare}
          label="Tasks Due"
          value={String(tasksDueToday)}
          sub="overdue + due today"
          color={tasksDueToday > 0 ? 'bg-red-500' : 'bg-green-500'}
        />
        <StatCard
          icon={DollarSign}
          label="Est. Commission"
          value={formatCurrency(estCommission)}
          sub={fastPassCount > 0 ? `${fastPassCount} Fast Pass active` : 'deals under contract'}
          color="bg-brand-gold-dark"
        />
      </div>

      {/* 3-Section Layout */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Needs Your Action */}
        <Section
          icon={AlertCircle}
          title="Needs Your Action"
          color="bg-red-50 text-red-700 border-red-100"
          count={needsActionTasks.length}
        >
          <div className="space-y-0.5">
            {needsActionTasks.map((task) => (
              <TaskRow key={task.id} task={task} deal={getDealForTask(task)} />
            ))}
          </div>
        </Section>

        {/* Waiting on Client */}
        <Section
          icon={Clock}
          title="Waiting on Client"
          color="bg-amber-50 text-amber-700 border-amber-100"
          count={waitingTasks.length}
        >
          <div className="space-y-0.5">
            {waitingTasks.map((task) => (
              <TaskRow key={task.id} task={task} deal={getDealForTask(task)} />
            ))}
          </div>
        </Section>

        {/* On Track */}
        <Section
          icon={CheckCircle2}
          title="On Track"
          color="bg-green-50 text-green-700 border-green-100"
          count={onTrackDeals.length}
        >
          <div className="space-y-2">
            {onTrackDeals.map((deal) => (
              <DealCard key={deal.id} deal={deal} />
            ))}
          </div>
        </Section>
      </div>

      {/* Completed Deals (#417) — the back door for a deal that has been
          closed out. Without this, archiving a deal made it disappear with
          nothing anywhere in the app able to show it again. */}
      <Section
        id="completed"
        icon={Archive}
        title="Completed Deals"
        color="bg-gray-50 text-gray-600 border-gray-100"
        count={completedDeals.length}
        emptyText="No completed deals yet — finished deals land here when you mark them complete."
      >
        <div className="space-y-2">
          {completedDeals.map((deal) => (
            <CompletedDealRow key={deal.id} deal={deal} />
          ))}
        </div>
      </Section>
    </div>
  );
}
