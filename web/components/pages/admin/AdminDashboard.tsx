"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from 'react';
import { api } from "@/lib/api-client";
import { useDeals } from "@/hooks/useDeals";
import { useUsers, AppUser } from "@/hooks/useUsers";
import { useAgentInvites, AgentInvite } from "@/hooks/useAgentInvites";
import { useSystemConfig, usePromoCodes, useAuditLog, SystemConfig, CreatePromoCodeInput } from "@/hooks/useAdmin";
import { Deal } from "@/lib/types";
import { formatCompactMoney, formatMoney, sumKnown } from "@/lib/deal-money";
import { FormReview } from "@/components/pages/admin/FormReview";
import {
  AlertTriangle,
  TrendingUp,
  DollarSign,
  Zap,
  FileWarning,
  CalendarClock,
  CheckSquare,
  Users,
  Check,
  Mail,
  ShieldCheck,
  UserX,
  UserPlus,
  Settings,
  Tag,
  Plus,
  Trash2,
  Save,
  ScrollText,
  Clock,
  X,
  Copy,
  CheckCheck,
} from 'lucide-react';
import { FAST_PASS_UPSELLS } from "@/lib/fast-pass-display";
import { NEXT_STEP_LABELS, SMOOTH_EXIT_UPSELLS, nextStepQualifiesForBridge } from "@/lib/smooth-exit-display";
import { marketLabel } from "@/lib/markets";
import { AGENT_STAGE_LABELS as STAGE_LABELS, STAGE_ORDER } from "@/lib/stages";

// ─── Shared helpers ────────────────────────────────────────────────────────────


const HEALTH_DOT: Record<string, string> = {
  green: 'bg-green-400',
  yellow: 'bg-amber-400',
  red: 'bg-red-500',
};

const HEALTH_BORDER: Record<string, string> = {
  green: 'border-l-green-400',
  yellow: 'border-l-amber-400',
  red: 'border-l-red-500',
};

const HEALTH_BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
};

/**
 * Stat-card currency. Delegates to the shared helper (#411) so this dashboard
 * and the agent one agree on what "no price" means — "—", not "$0".
 */
function fmt$(n: number | null) {
  return formatCompactMoney(n, 1);
}

function initials(name: string) {
  return name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
}

// ─── Stat Card ─────────────────────────────────────────────────────────────────

type StatProps = {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
};

function StatCard({ label, value, icon, accent = 'text-brand-navy' }: StatProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl bg-white px-5 py-4 shadow-sm">
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-brand-navy/5 text-brand-navy">
        {icon}
      </div>
      <div>
        <div className={`text-xl font-bold ${accent}`}>{value}</div>
        <div className="text-xs text-gray-400 font-medium">{label}</div>
      </div>
    </div>
  );
}

// ─── Deal Row (compact) ────────────────────────────────────────────────────────

function DealRow({ deal }: { deal: Deal }) {
  const overdueTasks = deal.overdueTaskCount ?? 0;
  const openTasks = deal.openTaskCount ?? 0;

  return (
    <div className={`flex items-center gap-4 border-l-4 ${HEALTH_BORDER[deal.health]} bg-white px-5 py-3 rounded-r-xl shadow-sm`}>
      <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${HEALTH_DOT[deal.health]}`} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-brand-navy text-sm">{deal.clientName}</span>
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${deal.type === 'buy' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
            {deal.type}
          </span>
          {overdueTasks > 0 && (
            <span className="flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600">
              <AlertTriangle size={9} />
              {overdueTasks} overdue
            </span>
          )}
          {deal.flags.includes('fast_pass') && (
            <span className="flex items-center gap-1 rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">
              <Zap size={9} />
              FastPass
            </span>
          )}
        </div>
        <div className="text-xs text-gray-400 truncate">
          {deal.property.address}, {deal.property.city}
        </div>
      </div>

      <div className="hidden sm:block text-xs text-gray-500 w-28 text-center">
        {STAGE_LABELS[deal.stage]}
      </div>

      <div className="text-sm font-semibold text-brand-navy w-20 text-right">
        {fmt$(deal.property.price)}
      </div>

      {deal.agentName && (
        <Link
          href="/admin/users"
          title={`View ${deal.agentName}'s profile`}
          className="flex items-center gap-1.5 group"
        >
          <div className="h-6 w-6 rounded-full bg-brand-navy/10 flex items-center justify-center text-[10px] font-bold text-brand-navy ring-2 ring-transparent group-hover:ring-brand-navy/30 transition-all">
            {initials(deal.agentName)}
          </div>
          <span className="hidden lg:block text-xs text-gray-500 group-hover:text-brand-navy transition-colors">
            {deal.agentName.split(' ')[0]}
          </span>
        </Link>
      )}

      <div className="text-xs text-gray-400 w-12 text-right">{openTasks} tasks</div>
    </div>
  );
}

// ─── Pipeline Overview ─────────────────────────────────────────────────────────

function PipelineOverview({ deals }: { deals: Deal[] }) {
  const activeDeals = deals.filter((d) => d.stage !== 'post_close');
  // #411 — same rule as the agent dashboard: total the deals whose price the
  // app knows, and stay `null` (rendered "—") when it knows none of them.
  const totalPipeline = sumKnown(activeDeals.map((d) => d.property.price));
  const totalCommission = sumKnown(activeDeals.map((d) => d.estimatedCommission));
  const overdueTaskCount = activeDeals.reduce((s, d) => s + (d.overdueTaskCount ?? 0), 0);
  const pendingDisclosures = activeDeals.filter(
    (d) => d.loanMilestones?.disclosuresOut && !d.loanMilestones?.disclosuresSignedSubmitted,
  );
  const fastPassDeals = activeDeals.filter((d) => d.flags.includes('fast_pass'));
  const redDeals = activeDeals.filter((d) => d.health === 'red');
  // Closing-soon list. React 19's compiler memoizes automatically, so we
  // no longer wrap this in useMemo (the rule complains that
  // `activeDeals` may be mutated later, blocking optimization). The
  // Date.now() / new Date() reads are unavoidable for a "next 30 days"
  // filter — the per-line disable documents intent.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const closingSoon = activeDeals.filter((d) => {
    if (!d.timeline.closingDate) return false;
    const closeMs = new Date(d.timeline.closingDate).getTime();
    const days = Math.ceil((closeMs - nowMs) / 86_400_000);
    return days >= 0 && days <= 30;
  });

  const byStage = STAGE_ORDER.map((stage) => ({
    stage,
    deals: activeDeals.filter((d) => d.stage === stage),
  })).filter((g) => g.deals.length > 0);

  // Derive agents from deals
  const agentMap = new Map<string, { name: string; email: string; deals: Deal[] }>();
  activeDeals.forEach((d) => {
    if (!d.agentId) return;
    if (!agentMap.has(d.agentId)) {
      agentMap.set(d.agentId, { name: d.agentName ?? 'Unknown', email: d.agentEmail ?? '', deals: [] });
    }
    agentMap.get(d.agentId)!.deals.push(d);
  });
  const agentEntries = Array.from(agentMap.entries());

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Pipeline Overview</h1>
        <p className="text-sm text-gray-400 mt-0.5">System-wide view across all agents and deals</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <StatCard label="Total Pipeline Value" value={fmt$(totalPipeline)} icon={<TrendingUp size={18} />} />
        <StatCard label="Active Deals" value={activeDeals.length} icon={<CheckSquare size={18} />} />
        <StatCard label="Est. Commission" value={fmt$(totalCommission)} icon={<DollarSign size={18} />} accent="text-green-600" />
        <StatCard
          label="Overdue Tasks"
          value={overdueTaskCount}
          icon={<AlertTriangle size={18} />}
          accent={overdueTaskCount > 0 ? 'text-red-600' : 'text-brand-navy'}
        />
        <StatCard
          label="Pending Disclosures"
          value={pendingDisclosures.length}
          icon={<FileWarning size={18} />}
          accent={pendingDisclosures.length > 0 ? 'text-amber-600' : 'text-brand-navy'}
        />
        <StatCard
          label="Closing ≤ 30 Days"
          value={closingSoon.length}
          icon={<CalendarClock size={18} />}
          accent={closingSoon.length > 0 ? 'text-brand-navy' : 'text-gray-400'}
        />
        <StatCard label="Active Fast Pass" value={fastPassDeals.length} icon={<Zap size={18} />} accent="text-green-600" />
        <StatCard label="Agents" value={agentEntries.length} icon={<Users size={18} />} />
      </div>

      {(redDeals.length > 0 || overdueTaskCount > 0) && (
        <section>
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle size={15} className="text-red-500" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-red-600">Needs Attention</h2>
          </div>
          <div className="space-y-2">
            {redDeals.map((d) => <DealRow key={d.id} deal={d} />)}
            {deals.filter(
              (d) => d.health !== 'red' && d.stage !== 'post_close' && (d.overdueTaskCount ?? 0) > 0,
            ).map((d) => <DealRow key={d.id} deal={d} />)}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-gray-400">Deals by Stage</h2>
        <div className="space-y-5">
          {byStage.map(({ stage, deals: stageDeals }) => (
            <div key={stage}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  {STAGE_LABELS[stage]}
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-500">
                  {stageDeals.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {stageDeals.map((d) => <DealRow key={d.id} deal={d} />)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-gray-400">By Agent</h2>
        <div className="space-y-2">
          {agentEntries.map(([agentId, { name, email, deals: agentDeals }]) => {
            const agentCommission = sumKnown(agentDeals.map((d) => d.estimatedCommission));
            const agentOverdue = agentDeals.reduce((s, d) => s + (d.overdueTaskCount ?? 0), 0);
            const healthCounts = {
              green: agentDeals.filter((d) => d.health === 'green').length,
              yellow: agentDeals.filter((d) => d.health === 'yellow').length,
              red: agentDeals.filter((d) => d.health === 'red').length,
            };
            return (
              <Link
                key={agentId}
                href="/admin/users"
                className="flex items-center gap-4 rounded-xl bg-white px-5 py-4 shadow-sm hover:shadow-md transition-shadow group"
              >
                <div className="h-10 w-10 rounded-full bg-brand-navy/10 flex items-center justify-center text-sm font-bold text-brand-navy ring-2 ring-brand-navy/10 group-hover:ring-brand-navy/30 transition-all flex-shrink-0">
                  {initials(name)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-brand-navy text-sm">{name}</div>
                  <div className="text-xs text-gray-400">{email}</div>
                </div>
                <div className="flex items-center gap-2.5">
                  {healthCounts.green > 0 && (
                    <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                      <span className="h-2 w-2 rounded-full bg-green-400 inline-block" />
                      {healthCounts.green}
                    </span>
                  )}
                  {healthCounts.yellow > 0 && (
                    <span className="flex items-center gap-1 text-xs font-medium text-amber-600">
                      <span className="h-2 w-2 rounded-full bg-amber-400 inline-block" />
                      {healthCounts.yellow}
                    </span>
                  )}
                  {healthCounts.red > 0 && (
                    <span className="flex items-center gap-1 text-xs font-medium text-red-600">
                      <span className="h-2 w-2 rounded-full bg-red-500 inline-block" />
                      {healthCounts.red}
                    </span>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-brand-navy">{fmt$(agentCommission)}</div>
                  <div className="text-xs text-gray-400">{agentDeals.length} active deals</div>
                </div>
                {agentOverdue > 0 && (
                  <div className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-600">
                    <AlertTriangle size={11} />
                    {agentOverdue} overdue
                  </div>
                )}
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ─── All Deals ─────────────────────────────────────────────────────────────────

function AllDeals({ deals }: { deals: Deal[] }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">All Deals</h1>
        <p className="text-sm text-gray-400 mt-0.5">{deals.length} deals total</p>
      </div>
      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
              <th className="px-5 py-3">Client</th>
              <th className="px-5 py-3">Property</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Stage</th>
              <th className="px-5 py-3">Health</th>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Closing</th>
              <th className="px-5 py-3 text-right">Commission</th>
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr key={deal.id} className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
                <td className="px-5 py-3 font-medium text-brand-navy">{deal.clientName}</td>
                <td className="px-5 py-3 text-gray-600">
                  {deal.property.address}
                  {deal.property.city && <span className="ml-1 text-gray-400 text-xs">{deal.property.city}</span>}
                </td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${deal.type === 'buy' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                    {deal.type}
                  </span>
                </td>
                <td className="px-5 py-3 text-gray-600">{STAGE_LABELS[deal.stage]}</td>
                <td className="px-5 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${HEALTH_BADGE[deal.health]}`}>
                    {deal.health}
                  </span>
                </td>
                <td className="px-5 py-3">
                  {deal.agentName && (
                    <Link href="/admin/users" className="flex items-center gap-1.5 group w-fit">
                      <div className="h-5 w-5 rounded-full bg-brand-navy/10 flex items-center justify-center text-[9px] font-bold text-brand-navy ring-2 ring-transparent group-hover:ring-brand-navy/30 transition-all">
                        {initials(deal.agentName)}
                      </div>
                      <span className="text-gray-600 text-xs group-hover:text-brand-navy transition-colors">
                        {deal.agentName}
                      </span>
                    </Link>
                  )}
                </td>
                <td className="px-5 py-3 text-gray-500 text-xs">
                  {deal.timeline.closingDate ?? '—'}
                </td>
                <td className="px-5 py-3 text-right font-medium text-brand-navy">
                  {formatMoney(deal.estimatedCommission)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Pending Disclosures ───────────────────────────────────────────────────────

function PendingDisclosures({ deals }: { deals: Deal[] }) {
  const [remindedIds, setRemindedIds] = useState<Set<string>>(new Set());
  const pending = deals.filter(
    (d) => d.loanMilestones?.disclosuresOut && !d.loanMilestones?.disclosuresSignedSubmitted,
  );

  async function sendReminder(dealId: string) {
    try {
      await api.post<{ ok: boolean }>(`/deals/${dealId}/disclosure-reminder`, {});
      setRemindedIds((prev) => new Set([...prev, dealId]));
    } catch {
      // Silently ignore — admin can retry.
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Pending Disclosures</h1>
        <p className="text-sm text-gray-400 mt-0.5">Disclosures sent but not yet signed</p>
      </div>
      {pending.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No pending disclosures
        </div>
      ) : (
        <div className="space-y-2">
          {pending.map((d) => (
            <div key={d.id} className="flex items-center gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border-l-4 border-l-amber-400">
              <FileWarning size={18} className="text-amber-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-brand-navy text-sm">{d.clientName}</div>
                <div className="text-xs text-gray-400">{d.property.address}, {d.property.city}</div>
              </div>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${HEALTH_BADGE[d.health]}`}>
                {d.health}
              </span>
              <span className="text-xs text-gray-400">{STAGE_LABELS[d.stage]}</span>
              <button
                onClick={() => sendReminder(d.id)}
                disabled={remindedIds.has(d.id)}
                className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600 transition-colors disabled:opacity-60 disabled:cursor-default"
              >
                {remindedIds.has(d.id) ? 'Reminder Sent' : 'Send Reminder'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Pre-Approval Queue ────────────────────────────────────────────────────────

function PreApprovalQueue({ deals }: { deals: Deal[] }) {
  const mmDeals = deals.filter((d) => d.flags.includes('mountain_mortgage'));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Pre-Approval Queue</h1>
        <p className="text-sm text-gray-400 mt-0.5">Buyers in the Mountain Mortgage pre-approval pipeline</p>
      </div>
      {mmDeals.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No buyers in pre-approval queue
        </div>
      ) : (
        <div className="space-y-2">
          {mmDeals.map((d) => (
            <div key={d.id} className="flex items-center gap-4 rounded-xl bg-white px-5 py-4 shadow-sm border-l-4 border-l-blue-400">
              <CheckSquare size={18} className="text-blue-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-brand-navy text-sm">{d.clientName}</div>
                <div className="text-xs text-gray-400 truncate">
                  {(d.openTaskCount ?? 0) > 0 ? `${d.openTaskCount} open task${d.openTaskCount !== 1 ? 's' : ''}` : 'No open tasks'}
                </div>
              </div>
              <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-semibold text-blue-700">
                {STAGE_LABELS[d.stage]}
              </span>
              <div className="text-right">
                <div className="text-sm font-bold text-brand-navy">{fmt$(d.property.price)}</div>
                <div className="text-xs text-gray-400">target price</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stuck Deals ──────────────────────────────────────────────────────────────

function StuckDeals({ deals }: { deals: Deal[] }) {
  const stuck = deals.filter(
    (d) => d.stage !== 'post_close' && d.timeline.daysInStage >= 14,
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Stuck Deals</h1>
        <p className="text-sm text-gray-400 mt-0.5">Deals that haven&apos;t progressed in 14+ days</p>
      </div>
      {stuck.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No stuck deals
        </div>
      ) : (
        <div className="space-y-2">
          {stuck.map((d) => (
            <div key={d.id} className={`flex items-center gap-4 border-l-4 ${HEALTH_BORDER[d.health]} bg-white px-5 py-4 rounded-r-xl shadow-sm`}>
              <AlertTriangle size={18} className="text-amber-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-brand-navy text-sm">{d.clientName}</div>
                <div className="text-xs text-gray-400">{d.property.address}, {d.property.city}</div>
              </div>
              <div className="text-center">
                <div className="text-lg font-bold text-amber-600">{d.timeline.daysInStage}</div>
                <div className="text-xs text-gray-400">days in stage</div>
              </div>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                {STAGE_LABELS[d.stage]}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Fees Collected ────────────────────────────────────────────────────────────

const FEE_BADGE: Record<string, string> = {
  paid:     'bg-green-100 text-green-700',
  waived:   'bg-gray-100 text-gray-400',
  pending:  'bg-amber-100 text-amber-700',
  unpaid:   'bg-red-50 text-red-600',
  refunded: 'bg-gray-200 text-gray-600',
};

function FeesCollected({ deals }: { deals: Deal[] }) {
  const postCloseDeals = deals.filter((d) => d.stage === 'post_close');
  const paidDeals      = postCloseDeals.filter((d) => d.feeStatus === 'paid');
  const unpaidDeals    = postCloseDeals.filter((d) => d.feeStatus === 'unpaid' || d.feeStatus === 'pending');
  // #364: a refunded/disputed fee is neither collected nor outstanding — it was
  // paid then reversed. Excluded from Collected (which only sums 'paid') and
  // surfaced distinctly so a reversal isn't silently counted as revenue.
  const refundedDeals  = postCloseDeals.filter((d) => d.feeStatus === 'refunded');

  const totalCollected = paidDeals.reduce((s, d) => s + (d.feeAmountCents ?? 7500), 0);
  const totalOutstanding = unpaidDeals.reduce((s, d) => s + (d.feeAmountCents ?? 7500), 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Fees Collected</h1>
        <p className="text-sm text-gray-400 mt-0.5">$75 closing fee per completed deal</p>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-white px-5 py-5 shadow-sm">
          <div className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1">Collected</div>
          <div className="text-2xl font-bold text-green-600">${(totalCollected / 100).toFixed(2)}</div>
          <div className="text-xs text-gray-400 mt-1">
            {paidDeals.length} deals paid{refundedDeals.length > 0 ? ` · ${refundedDeals.length} refunded` : ''}
          </div>
        </div>
        <div className="rounded-xl bg-white px-5 py-5 shadow-sm">
          <div className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1">Outstanding</div>
          <div className="text-2xl font-bold text-red-500">${(totalOutstanding / 100).toFixed(2)}</div>
          <div className="text-xs text-gray-400 mt-1">{unpaidDeals.length} deals unpaid</div>
        </div>
        <div className="rounded-xl bg-white px-5 py-5 shadow-sm">
          <div className="text-xs text-gray-400 font-medium uppercase tracking-wide mb-1">Post-Close Total</div>
          <div className="text-2xl font-bold text-brand-navy">{postCloseDeals.length}</div>
          <div className="text-xs text-gray-400 mt-1">completed deals</div>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="border-b px-5 py-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Post-Close Deals — Closing Fee Status</h2>
        </div>
        {postCloseDeals.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-gray-400">No post-close deals yet</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
                <th className="px-5 py-3">Client</th>
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Type</th>
                <th className="px-5 py-3 text-right">Fee</th>
                <th className="px-5 py-3 text-right">Paid On</th>
                <th className="px-5 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {postCloseDeals.map((d) => (
                <tr key={d.id} className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
                  <td className="px-5 py-3 font-medium text-brand-navy">{d.clientName}</td>
                  <td className="px-5 py-3 text-gray-500 text-xs">{d.agentName ?? '—'}</td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${d.type === 'buy' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                      {d.type}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-brand-navy">
                    ${((d.feeAmountCents ?? 7500) / 100).toFixed(2)}
                  </td>
                  <td className="px-5 py-3 text-right text-xs text-gray-400">
                    {d.feePaidAt ? new Date(d.feePaidAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${FEE_BADGE[d.feeStatus ?? 'unpaid']}`}>
                      {d.feeStatus ?? 'unpaid'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Active Fast Pass ──────────────────────────────────────────────────────────

const STATUS_STYLES: Record<string, { badge: string; border: string; label: string }> = {
  pending_payment: {
    badge: 'bg-amber-100 text-amber-700',
    border: 'border-l-amber-400',
    label: 'Pending Payment',
  },
  active: {
    badge: 'bg-green-100 text-green-700',
    border: 'border-l-green-400',
    label: 'Active',
  },
  complete: {
    badge: 'bg-gray-100 text-gray-500',
    border: 'border-l-gray-300',
    label: 'Complete',
  },
};

const PAYMENT_OPTION_LABELS: Record<string, string> = {
  now: 'Paid upfront',
  at_closing: 'Collect at closing (+15%)',
  seller_concession: 'Seller concession',
};

function ActiveFastPass({ deals, refresh }: { deals: Deal[]; refresh: () => void }) {
  const [collectedIds, setCollectedIds] = useState<Set<string>>(new Set());

  async function collectFastPass(dealId: string) {
    try {
      await api.post<{ ok: boolean }>(`/deals/${dealId}/fastpass/collect`, {});
      setCollectedIds((prev) => new Set([...prev, dealId]));
    } catch {
      // Silently ignore — user can retry
    }
  }

  async function markFastPassPaid(dealId: string) {
    try {
      await api.post<{ ok: boolean }>(`/deals/${dealId}/fastpass/mark-paid`, {});
      // Status flips pending_payment → active; refetch so the row re-buckets.
      refresh();
    } catch {
      // Silently ignore — admin can retry.
    }
  }

  const fpDeals = deals.filter((d) => {
    if (!d.flags.includes('fast_pass') || !d.fastPass) return false;
    if (d.fastPass.status === 'collected' || collectedIds.has(d.id)) return false;
    if (d.stage === 'post_close' && d.fastPass.paymentOption === 'now') return false;
    return true;
  });
  const pendingPayment = fpDeals.filter((d) => d.fastPass?.status === 'pending_payment');
  const awaitingCollection = fpDeals.filter(
    (d) =>
      d.stage === 'post_close' &&
      d.fastPass?.status === 'active' &&
      (d.fastPass.paymentOption === 'at_closing' || d.fastPass.paymentOption === 'seller_concession'),
  );
  const active = fpDeals.filter((d) => d.fastPass?.status === 'active' && d.stage !== 'post_close');
  const noEnrollment = fpDeals.filter((d) => !d.fastPass && d.stage !== 'post_close');

  function FPDealCard({ d }: { d: Deal }) {
    const fp = d.fastPass;
    const style = fp ? STATUS_STYLES[fp.status] : STATUS_STYLES.active;
    const upsellItems = fp
      ? FAST_PASS_UPSELLS.filter((u) => fp.selectedUpsells.includes(u.id))
      : [];

    return (
      <div className={`rounded-xl bg-white shadow-sm border-l-4 ${style.border} overflow-hidden`}>
        <div className="flex items-center gap-3 px-5 py-4">
          <Zap size={18} className="text-green-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-brand-navy text-sm">{d.clientName}</span>
              {fp && (
                <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${style.badge}`}>
                  {style.label}
                </span>
              )}
            </div>
            <div className="text-xs text-gray-400 truncate">
              {d.property.address}, {d.property.city}
            </div>
            {d.agentName && (
              <div className="text-[10px] text-gray-300 mt-0.5">Agent: {d.agentName}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            {fp && (
              <>
                <div className="text-sm font-black text-brand-navy">
                  ${fp.totalPaid.toLocaleString()}
                </div>
                <div className="text-xs text-gray-400">paid</div>
              </>
            )}
          </div>
          {fp?.status === 'pending_payment' && (
            <button
              onClick={() => markFastPassPaid(d.id)}
              className="ml-2 rounded-lg bg-green-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-600 transition-colors"
            >
              Mark Paid
            </button>
          )}
        </div>

        {upsellItems.length > 0 && (
          <div className="border-t border-gray-50 px-5 py-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
              Add-ons
            </div>
            <div className="flex flex-wrap gap-1.5">
              {upsellItems.map((u) => (
                <span key={u.id} className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">
                  <Check size={9} strokeWidth={3} />
                  {u.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {fp?.surveyAnswers && (
          <div className="border-t border-gray-50 px-5 py-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Move date</div>
              <div className="text-xs text-gray-600">
                {new Date(fp.surveyAnswers.targetMoveDate).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Situation</div>
              <div className="text-xs text-gray-600 capitalize">{fp.surveyAnswers.currentSituation}</div>
            </div>
            {fp.surveyAnswers.utilities.length > 0 && (
              <div className="col-span-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Utilities</div>
                <div className="text-xs text-gray-600">{fp.surveyAnswers.utilities.join(', ')}</div>
              </div>
            )}
            {fp.surveyAnswers.notes && (
              <div className="col-span-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Notes</div>
                <div className="text-xs text-gray-600 italic">{fp.surveyAnswers.notes}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const allFpDeals = deals.filter((d) => d.fastPass);
  const totalRevenue = allFpDeals.reduce((sum, d) => sum + (d.fastPass?.totalPaid ?? 0), 0);

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Active Fast Pass</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Deals enrolled in the Mountain Mortgage Fast Pass program
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-brand-navy">{allFpDeals.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">Total Enrolled</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-green-700">${totalRevenue.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">Total Paid</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-amber-600">{awaitingCollection.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">Awaiting Collection</p>
        </div>
      </div>

      {fpDeals.length === 0 && awaitingCollection.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No active Fast Pass deals
        </div>
      ) : (
        <>
          {awaitingCollection.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <DollarSign size={14} className="text-green-600" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-green-600">
                  Awaiting Collection at Closing ({awaitingCollection.length})
                </h2>
              </div>
              <div className="space-y-3">
                {awaitingCollection.map((d) => (
                  <div key={d.id} className="rounded-xl bg-white shadow-sm border-l-4 border-l-green-400 overflow-hidden">
                    <div className="flex items-center gap-3 px-5 py-4">
                      <Zap size={18} className="text-green-500 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-brand-navy text-sm">{d.clientName}</span>
                          <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-green-700">
                            Post-Close
                          </span>
                          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                            {PAYMENT_OPTION_LABELS[d.fastPass?.paymentOption ?? 'at_closing']}
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 truncate">
                          {d.property.address}, {d.property.city}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-black text-brand-navy">
                          ${d.fastPass?.totalPaid.toLocaleString()}
                        </div>
                        <div className="text-xs text-gray-400">due</div>
                      </div>
                      <button
                        onClick={() => collectFastPass(d.id)}
                        className="ml-2 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 transition-colors"
                      >
                        Mark Collected
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {pendingPayment.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-500" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-amber-600">
                  Awaiting Stripe Payment ({pendingPayment.length})
                </h2>
              </div>
              <div className="space-y-3">
                {pendingPayment.map((d) => <FPDealCard key={d.id} d={d} />)}
              </div>
            </section>
          )}

          {active.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-400">
                Active ({active.length})
              </h2>
              <div className="space-y-3">
                {active.map((d) => <FPDealCard key={d.id} d={d} />)}
              </div>
            </section>
          )}

          {noEnrollment.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-400">
                Flagged — No Enrollment Data
              </h2>
              <div className="space-y-3">
                {noEnrollment.map((d) => <FPDealCard key={d.id} d={d} />)}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ─── Smooth Exit ──────────────────────────────────────────────────────────────

function SmoothExitQueue({ deals, refresh }: { deals: Deal[]; refresh: () => void }) {
  async function activateSmoothExit(dealId: string) {
    try {
      await api.post<{ ok: boolean }>(`/deals/${dealId}/smoothexit/activate`, {});
      // Status flips pending → active; refetch so the row re-buckets.
      refresh();
    } catch {
      // Silently ignore — admin can retry.
    }
  }

  const allSeDeals = deals.filter((d) => d.smoothExit);
  const seDeals = allSeDeals.filter((d) => d.stage !== 'post_close');
  const completed = allSeDeals.filter((d) => d.stage === 'post_close');
  const pending = seDeals.filter((d) => d.smoothExit?.status === 'pending');
  const active = seDeals.filter((d) => d.smoothExit?.status === 'active');
  const totalFees = allSeDeals.reduce((sum, d) => sum + (d.smoothExit?.fee ?? 0), 0);
  const totalUpsells = allSeDeals.reduce((sum, d) => sum + Math.round((d.smoothExit?.upsellTotalCents ?? 0) / 100), 0);

  function SECard({ d }: { d: Deal }) {
    const se = d.smoothExit!;
    const qualifies = se.nextStep ? nextStepQualifiesForBridge(se.nextStep) : false;

    return (
      <div className={`rounded-xl bg-white shadow-sm border-l-4 overflow-hidden ${se.status === 'pending' ? 'border-l-amber-400' : 'border-l-purple-400'}`}>
        <div className="flex items-center gap-3 px-5 py-4">
          <span className="text-xl flex-shrink-0">🚪</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-brand-navy text-sm">{d.clientName}</span>
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${se.status === 'pending' ? 'bg-amber-100 text-amber-700' : se.status === 'complete' ? 'bg-gray-100 text-gray-500' : 'bg-purple-100 text-purple-700'}`}>
                {se.status === 'pending' ? 'Pending' : se.status === 'complete' ? 'Complete' : 'Active'}
              </span>
              {qualifies && (
                <span className="rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-bold text-purple-600">
                  Buy Before Sell
                </span>
              )}
            </div>
            <div className="text-xs text-gray-400 truncate">
              {d.property.address}, {d.property.city}
            </div>
            {d.agentName && (
              <div className="text-[10px] text-gray-300 mt-0.5">Agent: {d.agentName}</div>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-black text-brand-navy">${se.fee.toLocaleString()}</div>
            <div className="text-xs text-gray-400">1% fee</div>
          </div>
          {se.status === 'pending' && (
            <button
              onClick={() => activateSmoothExit(d.id)}
              className="ml-2 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700 transition-colors"
            >
              Activate
            </button>
          )}
        </div>
        {(se.selectedUpsells && se.selectedUpsells.length > 0) && (
          <div className="border-t border-gray-50 px-5 py-3">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Add-ons</div>
              {se.upsellsPaid ? (
                <span className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold text-green-700">
                  <Check size={9} strokeWidth={3} /> Paid
                </span>
              ) : (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-600">Unpaid</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SMOOTH_EXIT_UPSELLS.filter((u) => se.selectedUpsells!.includes(u.id)).map((u) => (
                <span key={u.id} className="flex items-center gap-1 rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                  <Check size={9} strokeWidth={3} /> {u.name}
                </span>
              ))}
            </div>
          </div>
        )}
        {se.surveyAnswers && (
          <div className="border-t border-gray-50 px-5 py-3 grid grid-cols-2 gap-x-4 gap-y-1.5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">What&apos;s next</div>
              <div className="text-xs text-gray-600">
                {se.nextStep ? NEXT_STEP_LABELS[se.nextStep] : '—'}
              </div>
            </div>
            {se.surveyAnswers.moveOutDate && (
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Move-out</div>
                <div className="text-xs text-gray-600">
                  {new Date(se.surveyAnswers.moveOutDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            )}
            {se.surveyAnswers.notes && (
              <div className="col-span-2">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-300">Notes</div>
                <div className="text-xs text-gray-600 italic">{se.surveyAnswers.notes}</div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Smooth Exit</h1>
        <p className="text-sm text-gray-400 mt-0.5">Seller concierge enrollments — move-out coordination and bridge financing</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-brand-navy">{allSeDeals.length}</p>
          <p className="text-xs text-gray-400 mt-0.5">Total Enrolled</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-purple-700">${totalFees.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">1% Fees Due</p>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm text-center">
          <p className="text-2xl font-black text-green-700">${totalUpsells.toLocaleString()}</p>
          <p className="text-xs text-gray-400 mt-0.5">Upsell Revenue</p>
        </div>
      </div>

      {allSeDeals.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No active Smooth Exit enrollments
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber-500" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-amber-600">Pending Activation ({pending.length})</h2>
              </div>
              <div className="space-y-3">{pending.map((d) => <SECard key={d.id} d={d} />)}</div>
            </section>
          )}
          {active.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-400">Active ({active.length})</h2>
              <div className="space-y-3">{active.map((d) => <SECard key={d.id} d={d} />)}</div>
            </section>
          )}
          {completed.length > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-gray-400">Closed ({completed.length})</h2>
              <div className="space-y-3">{completed.map((d) => <SECard key={d.id} d={d} />)}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

// ─── ARIVE Status ──────────────────────────────────────────────────────────────

const ARIVE_CHECKS: { key: keyof NonNullable<Deal['loanMilestones']>; label: string }[] = [
  { key: 'loanSetup',                  label: 'Loan Setup' },
  { key: 'disclosuresOut',             label: 'Disclosures Out' },
  { key: 'disclosuresSignedSubmitted', label: 'Signed & Submitted' },
  { key: 'approvedWithConditions',     label: 'Approved w/ Conditions' },
  { key: 'resubmittal',                label: 'Resubmittal' },
  { key: 'clearToClose',               label: 'Clear to Close' },
];

function AriveStatus({ deals }: { deals: Deal[] }) {
  const dealsWithArive = deals.filter((d) => d.loanMilestones != null);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">ARIVE Status</h1>
        <p className="text-sm text-gray-400 mt-0.5">Loan milestone tracking across active deals</p>
      </div>
      {dealsWithArive.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No deals with ARIVE data
        </div>
      ) : (
        <div className="space-y-3">
          {dealsWithArive.map((d) => {
            const a = d.loanMilestones!;
            const checks = [a.loanSetup, a.disclosuresOut, a.disclosuresSignedSubmitted, a.approvedWithConditions, a.resubmittal, a.clearToClose];
            const done = checks.filter(Boolean).length;
            const pct = Math.round((done / checks.length) * 100);

            return (
              <div key={d.id} className="rounded-xl bg-white px-5 py-4 shadow-sm">
                <div className="flex items-center gap-3 mb-3">
                  <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${HEALTH_DOT[d.health]}`} />
                  <div className="flex-1">
                    <span className="font-semibold text-brand-navy text-sm">{d.clientName}</span>
                    <span className="ml-2 text-xs text-gray-400">{d.property.address}</span>
                  </div>
                  <span className="text-xs text-gray-400">{STAGE_LABELS[d.stage]}</span>
                  <span className="text-xs font-semibold text-brand-navy">{pct}%</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {ARIVE_CHECKS.map(({ key, label }) => {
                    const val = a[key];
                    const checked = val === true;
                    return (
                      <div
                        key={key}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${checked ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-400'}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${checked ? 'bg-green-400' : 'bg-gray-300'}`} />
                        {label}
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-3 mt-2">
                  <div className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium ${a.appraisal === 'complete' ? 'bg-green-50 text-green-700' : a.appraisal === 'scheduled' ? 'bg-amber-50 text-amber-600' : a.appraisal === 'ordered' ? 'bg-blue-50 text-blue-600' : 'bg-gray-50 text-gray-400'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${a.appraisal === 'complete' ? 'bg-green-400' : a.appraisal === 'scheduled' ? 'bg-amber-400' : a.appraisal === 'ordered' ? 'bg-blue-400' : 'bg-gray-300'}`} />
                    Appraisal: {a.appraisal ?? 'pending'}
                  </div>
                  {a.funded && (
                    <div className="flex items-center gap-1.5 rounded-lg bg-green-500 px-2.5 py-1.5 text-xs font-black text-white">
                      Funded ✓
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── User Management ──────────────────────────────────────────────────────────

const ROLE_STYLES: Record<string, { badge: string; label: string }> = {
  agent:           { badge: 'bg-blue-100 text-blue-700',    label: 'Agent' },
  tc:              { badge: 'bg-amber-100 text-amber-700',  label: 'TC' },
  buyer:           { badge: 'bg-green-100 text-green-700',  label: 'Buyer' },
  seller:          { badge: 'bg-purple-100 text-purple-700', label: 'Seller' },
  admin:           { badge: 'bg-red-100 text-red-700',      label: 'Admin' },
  lending_partner: { badge: 'bg-blue-100 text-blue-700',    label: 'Lending Partner' },
};

function InviteAgentModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      const result = await api.post<{ token: string }>('/admin/agent-invites', { email: email.trim(), name: name.trim() });
      setInviteLink(`${window.location.origin}/agent-signup/${result.token}`);
    } catch {
      // silent — link still usable if email fails
    } finally {
      setSubmitting(false);
    }
  }

  function copyLink() {
    if (!inviteLink) return;
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div className="flex items-center gap-2.5">
            <UserPlus size={18} className="text-brand-navy" />
            <h2 className="text-base font-bold text-brand-navy">Invite Agent</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={18} />
          </button>
        </div>

        {!inviteLink ? (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
            <p className="text-sm text-gray-500">
              Enter the agent&apos;s email and we&apos;ll send them a signup link. They&apos;ll create their account and land directly in onboarding.
            </p>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Email address *</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="agent@example.com"
                required
                className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Name (optional)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full rounded-xl border border-gray-200 px-3.5 py-2.5 text-sm outline-none focus:border-brand-navy focus:ring-1 focus:ring-brand-navy/20"
              />
            </div>
            <div className="flex gap-2.5 pt-1">
              <button type="button" onClick={onClose} className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={submitting || !email.trim()} className="flex-1 rounded-xl bg-brand-navy py-2.5 text-sm font-bold text-white hover:bg-brand-navy/80 disabled:opacity-50 transition-colors">
                {submitting ? 'Sending…' : 'Send Invite'}
              </button>
            </div>
          </form>
        ) : (
          <div className="px-6 py-5 space-y-4">
            <div className="flex items-start gap-3 rounded-xl bg-green-50 p-3.5">
              <CheckCheck size={18} className="mt-0.5 flex-shrink-0 text-green-600" />
              <div>
                <p className="text-sm font-semibold text-green-800">Invite sent to {email}</p>
                <p className="text-xs text-green-600 mt-0.5">They&apos;ll receive an email with a signup link. You can also copy the link below to share directly.</p>
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-gray-600">Signup link</label>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={inviteLink}
                  className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-xs text-gray-600 outline-none"
                />
                <button
                  onClick={copyLink}
                  className="flex-shrink-0 flex items-center gap-1.5 rounded-xl border border-gray-200 px-3.5 py-2.5 text-xs font-semibold text-brand-navy hover:bg-gray-50 transition-colors"
                >
                  {copied ? <><CheckCheck size={13} className="text-green-600" /> Copied</> : <><Copy size={13} /> Copy</>}
                </button>
              </div>
            </div>
            <button onClick={onClose} className="w-full rounded-xl bg-brand-navy py-2.5 text-sm font-bold text-white hover:bg-brand-navy/80 transition-colors">
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Lists agent invites (pending / claimed) and lets an admin revoke an
// unclaimed one. The GET/DELETE endpoints already existed — this is the UI
// that finally calls them (#304). A claimed invite exposes no Revoke action.
function AgentInvitesSection() {
  const { invites, loading, error, revokeInvite } = useAgentInvites();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  // Snapshot "now" once (lazy init) so the expiry check stays pure across renders.
  const [now] = useState(() => Date.now());

  async function handleRevoke(invite: AgentInvite) {
    setRevokingId(invite.id);
    try {
      await revokeInvite(invite.id);
    } catch {
      // leave the row in place if the revoke fails
    } finally {
      setRevokingId(null);
    }
  }

  function fmtDate(iso: string) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? '—'
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">Agent Invites</h2>
        {invites.length > 0 && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-500">{invites.length}</span>
        )}
      </div>
      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">Loading invites…</div>
        ) : error ? (
          <div className="px-5 py-6 text-center text-sm text-red-500">{error}</div>
        ) : invites.length === 0 ? (
          <div className="px-5 py-6 text-center text-sm text-gray-400">No agent invites yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
                <th className="px-5 py-3">Invitee</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Sent</th>
                <th className="px-5 py-3">Expires</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((inv) => {
                const expired = !inv.claimed && new Date(inv.expiresAt).getTime() < now;
                return (
                  <tr key={inv.id} className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-semibold text-brand-navy text-sm">{inv.name || '—'}</div>
                      <a href={`mailto:${inv.email}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand-navy transition-colors">
                        <Mail size={11} /> {inv.email}
                      </a>
                    </td>
                    <td className="px-5 py-3">
                      {inv.claimed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
                          <ShieldCheck size={11} /> Claimed
                        </span>
                      ) : expired ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-600">
                          <Clock size={11} /> Expired
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                          <Clock size={11} /> Pending
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">{fmtDate(inv.createdAt)}</td>
                    <td className="px-5 py-3 text-xs text-gray-500">{fmtDate(inv.expiresAt)}</td>
                    <td className="px-5 py-3 text-right">
                      {inv.claimed ? (
                        <span className="text-xs text-gray-300">—</span>
                      ) : (
                        <button
                          onClick={() => handleRevoke(inv)}
                          disabled={revokingId === inv.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-100 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 disabled:opacity-50 transition-colors"
                        >
                          <Trash2 size={11} /> {revokingId === inv.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export function UserManagement() {
  const { users, loading, deactivateUser, activateUser } = useUsers();
  const [showInviteModal, setShowInviteModal] = useState(false);

  const groups = [
    { id: 'agent',  label: 'Agents' },
    { id: 'tc',     label: 'Transaction Coordinators' },
    { id: 'buyer',  label: 'Buyers' },
    { id: 'seller', label: 'Sellers' },
  ] as const;

  const stats = groups.map((g) => ({
    ...g,
    count: users.filter((u) => u.role === g.id).length,
  }));

  function UserRow({ user }: { user: AppUser }) {
    const isDeactivated = !!user.deactivatedAt;
    const style = ROLE_STYLES[user.role] ?? ROLE_STYLES.agent;
    const userInitials = initials(user.name);

    return (
      <tr className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
        <td className="px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-brand-navy/10 flex items-center justify-center text-xs font-bold text-brand-navy flex-shrink-0">
              {userInitials}
            </div>
            <div>
              <div className="font-semibold text-brand-navy text-sm">{user.name}</div>
              <div className="text-xs text-gray-400">{user.id.slice(0, 8)}…</div>
            </div>
          </div>
        </td>
        <td className="px-5 py-3">
          <a href={`mailto:${user.email}`} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-brand-navy transition-colors">
            <Mail size={11} /> {user.email}
          </a>
        </td>
        <td className="px-5 py-3">
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.badge}`}>
            {style.label}
          </span>
        </td>
        <td className="px-5 py-3">
          {user.role === 'agent' ? (
            <div className="min-w-0">
              <div className="text-xs font-medium text-brand-navy">{marketLabel(user.market ?? '')}</div>
              <div className="text-[11px] text-gray-400 truncate">{user.brokerage || 'No brokerage'}</div>
            </div>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </td>
        <td className="px-5 py-3">
          {isDeactivated ? (
            <span className="flex items-center gap-1 text-xs font-medium text-red-400">
              <UserX size={13} /> Deactivated
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs font-medium text-green-600">
              <ShieldCheck size={13} /> Active
            </span>
          )}
        </td>
        <td className="px-5 py-3 text-right">
          <div className="flex items-center justify-end gap-2">
            {isDeactivated ? (
              <button
                onClick={() => activateUser(user.id).catch(() => {})}
                className="flex items-center gap-1 rounded-lg border border-green-200 px-2.5 py-1 text-xs font-medium text-green-600 hover:bg-green-50 transition-colors"
              >
                <ShieldCheck size={11} /> Reactivate
              </button>
            ) : (
              <button
                onClick={() => deactivateUser(user.id).catch(() => {})}
                className="flex items-center gap-1 rounded-lg border border-red-100 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                <UserX size={11} /> Deactivate
              </button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-brand-navy">User Management</h1>
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Loading users…</div>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">User Management</h1>
        <p className="text-sm text-gray-400 mt-0.5">All platform users across every role</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(({ label, count, id }) => (
          <div key={id} className="rounded-xl bg-white px-5 py-4 shadow-sm">
            <div className={`text-2xl font-bold mb-0.5 ${
              id === 'agent' ? 'text-blue-600' :
              id === 'tc' ? 'text-amber-600' :
              id === 'buyer' ? 'text-green-600' : 'text-purple-600'
            }`}>{count}</div>
            <div className="text-xs text-gray-400 font-medium">{label}</div>
          </div>
        ))}
      </div>

      {groups.map(({ id, label }) => {
        const roleUsers = users.filter((u) => u.role === id);
        if (roleUsers.length === 0) return null;
        return (
          <section key={id}>
            <div className="mb-3 flex items-center gap-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">{label}</h2>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold text-gray-500">{roleUsers.length}</span>
            </div>
            <div className="rounded-xl bg-white shadow-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
                    <th className="px-5 py-3">User</th>
                    <th className="px-5 py-3">Email</th>
                    <th className="px-5 py-3">Role</th>
                    <th className="px-5 py-3">Market / Brokerage</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {roleUsers.map((u) => <UserRow key={u.id} user={u} />)}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <AgentInvitesSection />

      <div className="rounded-xl border-2 border-dashed border-gray-200 px-5 py-6 text-center">
        <UserPlus size={20} className="mx-auto mb-2 text-gray-300" />
        <p className="text-sm font-medium text-gray-500 mb-3">Invite a new agent to join RealTour Flow</p>
        <button
          onClick={() => setShowInviteModal(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand-navy/80 transition-colors"
        >
          <UserPlus size={14} /> Invite Agent
        </button>
      </div>

      {showInviteModal && <InviteAgentModal onClose={() => setShowInviteModal(false)} />}
    </div>
  );
}

// ─── System Config ────────────────────────────────────────────────────────────

const STAGE_THRESHOLD_LABELS: Record<string, string> = {
  intake: 'Intake',
  active_search: 'Active Search',
  offer_active: 'Offer Active',
  under_contract: 'Under Contract',
  pre_close: 'Pre-Close',
  closing: 'Closing',
  post_close: 'Post-Close',
};

const STAGE_THRESHOLD_KEYS = [
  'intake', 'active_search', 'offer_active', 'under_contract', 'pre_close', 'closing', 'post_close',
] as const;

const DEFAULT_CONFIG: SystemConfig = {
  stage_thresholds: { intake: 5, active_search: 30, offer_active: 10, under_contract: 35, pre_close: 10, closing: 5, post_close: 21 },
  closing_fee_amount: 500,
  fast_pass_base_price: 1500,
  smooth_exit_pct: 1.0,
};

function AdminSystemConfig() {
  const { config, updatedAt, loading, saving, saveConfig } = useSystemConfig();
  const [form, setForm] = useState<SystemConfig>(config ?? DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);

  // React 19 pattern for "reset local state when a prop changes": compare to
  // previous value during render and call setState before returning JSX. This
  // avoids the set-state-in-effect anti-pattern and is the documented fix.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevConfig, setPrevConfig] = useState(config);
  if (config !== prevConfig) {
    setPrevConfig(config);
    if (config) setForm(config);
  }

  function setThreshold(stage: string, val: string) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 0) return;
    setForm((prev) => ({
      ...prev,
      stage_thresholds: { ...prev.stage_thresholds, [stage]: n },
    }));
  }

  async function handleSave() {
    await saveConfig(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-brand-navy">System Config</h1>
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">System Config</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Global platform settings — stage thresholds and fee configuration
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {updatedAt && (
            <span className="text-xs text-gray-400">
              Last saved {new Date(updatedAt).toLocaleDateString()}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand-navy/80 transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="border-b px-5 py-3 flex items-center gap-2">
          <Settings size={14} className="text-gray-400" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Stage Thresholds (days before deal is considered stuck)
          </h2>
        </div>
        <div className="grid grid-cols-2 gap-px bg-gray-100 sm:grid-cols-4">
          {STAGE_THRESHOLD_KEYS.map((stage) => (
            <div key={stage} className="bg-white px-5 py-4">
              <label className="block text-xs font-semibold text-gray-500 mb-1.5">
                {STAGE_THRESHOLD_LABELS[stage]}
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min="1"
                  value={form.stage_thresholds[stage]}
                  onChange={(e) => setThreshold(stage, e.target.value)}
                  className="w-20 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-brand-navy focus:border-brand-navy focus:outline-none"
                />
                <span className="text-xs text-gray-400">days</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm overflow-hidden">
        <div className="border-b px-5 py-3 flex items-center gap-2">
          <DollarSign size={14} className="text-gray-400" />
          <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">
            Fee Configuration
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-gray-100 sm:grid-cols-3">
          <div className="bg-white px-5 py-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">
              Closing Fee Amount
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-gray-400">$</span>
              <input
                type="number"
                min="0"
                value={form.closing_fee_amount}
                onChange={(e) => setForm((prev) => ({ ...prev, closing_fee_amount: parseFloat(e.target.value) || 0 }))}
                className="w-28 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-brand-navy focus:border-brand-navy focus:outline-none"
              />
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Charged at post-close per deal</p>
          </div>

          <div className="bg-white px-5 py-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">
              Fast Pass Base Price
            </label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-gray-400">$</span>
              <input
                type="number"
                min="0"
                value={form.fast_pass_base_price}
                onChange={(e) => setForm((prev) => ({ ...prev, fast_pass_base_price: parseFloat(e.target.value) || 0 }))}
                className="w-28 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-brand-navy focus:border-brand-navy focus:outline-none"
              />
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Base price before upsell add-ons</p>
          </div>

          <div className="bg-white px-5 py-4">
            <label className="block text-xs font-semibold text-gray-500 mb-1.5">
              Smooth Exit Fee
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={form.smooth_exit_pct}
                onChange={(e) => setForm((prev) => ({ ...prev, smooth_exit_pct: parseFloat(e.target.value) || 0 }))}
                className="w-20 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-semibold text-brand-navy focus:border-brand-navy focus:outline-none"
              />
              <span className="text-sm text-gray-400">% of sale price</span>
            </div>
            <p className="text-xs text-gray-400 mt-1.5">Applied as % of closing sale price</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Promotions ────────────────────────────────────────────────────────────────

const APPLIES_TO_STAGES = [
  { value: 'intake',          label: 'Intake' },
  { value: 'active_search',   label: 'Active Search' },
  { value: 'offer_active',    label: 'Offer Active' },
  { value: 'under_contract',  label: 'Under Contract' },
  { value: 'pre_close',       label: 'Pre-Close' },
  { value: 'closing',         label: 'Closing' },
  { value: 'post_close',      label: 'Post-Close' },
  { value: 'fast_pass',       label: 'Fast Pass' },
  { value: 'smooth_exit',     label: 'Smooth Exit' },
];

function Promotions() {
  const { codes, loading, createCode, deleteCode } = usePromoCodes();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    code: '',
    discountType: 'pct' as 'pct' | 'fixed',
    discountValue: '',
    appliesTo: [] as string[],
    maxUses: '',
    expiresAt: '',
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  function toggleAppliesTo(val: string) {
    setForm((prev) => ({
      ...prev,
      appliesTo: prev.appliesTo.includes(val)
        ? prev.appliesTo.filter((s) => s !== val)
        : [...prev.appliesTo, val],
    }));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const input: CreatePromoCodeInput = {
        code: form.code.toUpperCase().trim(),
        discountType: form.discountType,
        discountValue: parseFloat(form.discountValue) || 0,
        appliesTo: form.appliesTo,
        maxUses: form.maxUses ? parseInt(form.maxUses, 10) : null,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      };
      await createCode(input);
      setShowCreate(false);
      setForm({ code: '', discountType: 'pct', discountValue: '', appliesTo: [], maxUses: '', expiresAt: '' });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create promo code');
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-brand-navy">Promotions</h1>
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  const activeCodes = codes.filter((c) => !c.expiresAt || new Date(c.expiresAt) > new Date());

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Promotions</h1>
          <p className="text-sm text-gray-400 mt-0.5">Manage discount codes for Fast Pass, Smooth Exit, and closing fees</p>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white hover:bg-brand-navy/80 transition-colors flex-shrink-0"
        >
          <Plus size={14} />
          New Code
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
          <div className="text-2xl font-bold text-brand-navy">{codes.length}</div>
          <div className="text-xs text-gray-400 font-medium">Total Codes</div>
        </div>
        <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
          <div className="text-2xl font-bold text-green-600">{activeCodes.length}</div>
          <div className="text-xs text-gray-400 font-medium">Active Codes</div>
        </div>
        <div className="rounded-xl bg-white px-5 py-4 shadow-sm">
          <div className="text-2xl font-bold text-brand-navy">
            {codes.reduce((s, c) => s + c.usesCount, 0)}
          </div>
          <div className="text-xs text-gray-400 font-medium">Total Uses</div>
        </div>
      </div>

      {showCreate && (
        <div className="rounded-xl bg-white shadow-sm overflow-hidden">
          <div className="border-b px-5 py-3 flex items-center gap-2">
            <Tag size={14} className="text-gray-400" />
            <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400">Create Promo Code</h2>
          </div>
          <form onSubmit={handleCreate} className="px-5 py-5 space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Code</label>
                <input
                  required
                  value={form.code}
                  onChange={(e) => setForm((p) => ({ ...p, code: e.target.value.toUpperCase() }))}
                  placeholder="SUMMER25"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-mono font-semibold uppercase focus:border-brand-navy focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Type</label>
                <select
                  value={form.discountType}
                  onChange={(e) => setForm((p) => ({ ...p, discountType: e.target.value as 'pct' | 'fixed' }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                >
                  <option value="pct">Percentage (%)</option>
                  <option value="fixed">Fixed ($)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Value</label>
                <div className="flex items-center gap-1">
                  <span className="text-sm text-gray-400">{form.discountType === 'fixed' ? '$' : ''}</span>
                  <input
                    required
                    type="number"
                    min="0"
                    step={form.discountType === 'pct' ? '1' : '0.01'}
                    value={form.discountValue}
                    onChange={(e) => setForm((p) => ({ ...p, discountValue: e.target.value }))}
                    placeholder={form.discountType === 'pct' ? '10' : '100'}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                  />
                  <span className="text-sm text-gray-400">{form.discountType === 'pct' ? '%' : ''}</span>
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Max Uses (optional)</label>
                <input
                  type="number"
                  min="1"
                  value={form.maxUses}
                  onChange={(e) => setForm((p) => ({ ...p, maxUses: e.target.value }))}
                  placeholder="Unlimited"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Expires (optional)</label>
                <input
                  type="date"
                  value={form.expiresAt}
                  onChange={(e) => setForm((p) => ({ ...p, expiresAt: e.target.value }))}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-2">Applies To (leave empty for all)</label>
              <div className="flex flex-wrap gap-2">
                {APPLIES_TO_STAGES.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleAppliesTo(value)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      form.appliesTo.includes(value)
                        ? 'bg-brand-navy text-white'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {createError && (
              <p className="text-xs text-red-500">{createError}</p>
            )}

            <div className="flex items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-brand-navy px-5 py-2 text-sm font-semibold text-white hover:bg-brand-navy/80 transition-colors disabled:opacity-50"
              >
                {creating ? 'Creating…' : 'Create Code'}
              </button>
              <button
                type="button"
                onClick={() => { setShowCreate(false); setCreateError(null); }}
                className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {codes.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center text-gray-400 shadow-sm">
          No promo codes yet. Create one to get started.
        </div>
      ) : (
        <div className="rounded-xl bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
                <th className="px-5 py-3">Code</th>
                <th className="px-5 py-3">Discount</th>
                <th className="px-5 py-3">Applies To</th>
                <th className="px-5 py-3 text-center">Uses</th>
                <th className="px-5 py-3">Expires</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => {
                const expired = c.expiresAt && new Date(c.expiresAt) <= new Date();
                const exhausted = c.maxUses !== null && c.usesCount >= c.maxUses;
                const inactive = expired || exhausted;
                return (
                  <tr key={c.id} className={`border-b last:border-0 ${inactive ? 'opacity-50' : 'hover:bg-gray-50/50'} transition-colors`}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-brand-navy">{c.code}</span>
                        {inactive && (
                          <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 uppercase">
                            {expired ? 'expired' : 'exhausted'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3 font-semibold text-green-600">
                      {c.discountType === 'pct' ? `${c.discountValue}%` : `$${c.discountValue}`}
                    </td>
                    <td className="px-5 py-3">
                      {c.appliesTo.length === 0 ? (
                        <span className="text-xs text-gray-400 italic">All</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {c.appliesTo.map((s) => (
                            <span key={s} className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                              {s.replace(/_/g, ' ')}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-3 text-center">
                      <span className="text-sm font-semibold text-brand-navy">{c.usesCount}</span>
                      {c.maxUses !== null && (
                        <span className="text-xs text-gray-400"> / {c.maxUses}</span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-xs text-gray-500">
                      {c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <button
                        onClick={() => deleteCode(c.id)}
                        className="flex items-center gap-1 ml-auto rounded-lg border border-red-100 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 transition-colors"
                      >
                        <Trash2 size={11} /> Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, { label: string; color: string }> = {
  stage_change:    { label: 'Stage Change',    color: 'bg-blue-100 text-blue-700' },
  fee_waive:       { label: 'Fee Waived',      color: 'bg-green-100 text-green-700' },
  user_deactivate: { label: 'User Deactivated', color: 'bg-red-100 text-red-600' },
  user_activate:   { label: 'User Activated',  color: 'bg-green-100 text-green-700' },
  config_update:   { label: 'Config Updated',  color: 'bg-purple-100 text-purple-700' },
  promo_create:    { label: 'Promo Created',   color: 'bg-amber-100 text-amber-700' },
  promo_delete:    { label: 'Promo Deleted',   color: 'bg-red-100 text-red-600' },
  brokerage_approve: { label: 'Brokerage Approved', color: 'bg-green-100 text-green-700' },
  brokerage_reject:  { label: 'Brokerage Rejected', color: 'bg-red-100 text-red-600' },
  fastpass_mark_paid:  { label: 'Fast Pass Marked Paid', color: 'bg-green-100 text-green-700' },
  smoothexit_activate: { label: 'Smooth Exit Activated', color: 'bg-purple-100 text-purple-700' },
  disclosure_reminder: { label: 'Disclosure Reminder',   color: 'bg-amber-100 text-amber-700' },
};

const EVENT_TYPE_OPTIONS = [
  { value: '', label: 'All Events' },
  { value: 'stage_change',    label: 'Stage Changes' },
  { value: 'fee_waive',       label: 'Fee Waives' },
  { value: 'user_deactivate', label: 'User Deactivations' },
  { value: 'user_activate',   label: 'User Activations' },
  { value: 'config_update',   label: 'Config Updates' },
  { value: 'promo_create',    label: 'Promo Creations' },
  { value: 'promo_delete',    label: 'Promo Deletions' },
  { value: 'brokerage_approve', label: 'Brokerage Approvals' },
  { value: 'brokerage_reject',  label: 'Brokerage Rejections' },
  { value: 'fastpass_mark_paid',  label: 'Fast Pass Marked Paid' },
  { value: 'smoothexit_activate', label: 'Smooth Exit Activations' },
  { value: 'disclosure_reminder', label: 'Disclosure Reminders' },
];

function describeEntry(e: ReturnType<typeof useAuditLog>['entries'][number]): string {
  const actor = e.actorName ?? 'Unknown';
  const deal = e.dealTitle ? ` on deal "${e.dealTitle}"` : '';
  switch (e.eventType) {
    case 'stage_change': {
      const from = (e.metadata?.from_stage as string | null)?.replace(/_/g, ' ') ?? '?';
      const to = (e.metadata?.to_stage as string | null)?.replace(/_/g, ' ') ?? '?';
      return `${actor} moved${deal} from ${from} → ${to}`;
    }
    case 'fee_waive':       return `${actor} waived the closing fee${deal}`;
    case 'user_deactivate': return `${actor} deactivated a user`;
    case 'user_activate':   return `${actor} reactivated a user`;
    case 'config_update':   return `${actor} updated system config`;
    case 'promo_create': {
      const code = e.metadata?.code as string | null;
      return `${actor} created promo code${code ? ` "${code}"` : ''}`;
    }
    case 'promo_delete': return `${actor} deleted a promo code`;
    case 'brokerage_approve': {
      const name = e.metadata?.name as string | null;
      return `${actor} approved brokerage${name ? ` "${name}"` : ''}`;
    }
    case 'brokerage_reject': {
      const name = e.metadata?.name as string | null;
      return `${actor} rejected brokerage${name ? ` "${name}"` : ''}`;
    }
    case 'fastpass_mark_paid':  return `${actor} marked a Fast Pass paid${deal}`;
    case 'smoothexit_activate': return `${actor} activated Smooth Exit${deal}`;
    case 'disclosure_reminder': return `${actor} sent a disclosure reminder${deal}`;
    default: return `${actor} performed ${e.eventType}`;
  }
}

function AuditLog() {
  const [filter, setFilter] = useState('');
  const { entries, total, loading } = useAuditLog(filter || undefined);

  if (loading) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-brand-navy">Audit Log</h1>
        <div className="flex items-center justify-center py-16 text-gray-400 text-sm">Loading…</div>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-brand-navy">Audit Log</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {total} event{total !== 1 ? 's' : ''} — stage transitions, fee waives, user changes, config edits
          </p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand-navy focus:outline-none"
        >
          {EVENT_TYPE_OPTIONS.map(({ value, label }) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-10 text-center shadow-sm">
          <ScrollText size={24} className="mx-auto mb-3 text-gray-300" />
          <p className="text-gray-400 text-sm">No audit events yet</p>
        </div>
      ) : (
        <div className="rounded-xl bg-white shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-400">
                <th className="px-5 py-3">Time</th>
                <th className="px-5 py-3">Event</th>
                <th className="px-5 py-3">Description</th>
                <th className="px-5 py-3">Actor</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => {
                const typeInfo = EVENT_TYPE_LABELS[e.eventType] ?? { label: e.eventType, color: 'bg-gray-100 text-gray-500' };
                const ts = new Date(e.createdAt);
                return (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-3 text-xs text-gray-400 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <Clock size={11} />
                        <span>{ts.toLocaleDateString()}</span>
                        <span className="text-gray-300">{ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide whitespace-nowrap ${typeInfo.color}`}>
                        {typeInfo.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-sm text-gray-700">{describeEntry(e)}</td>
                    <td className="px-5 py-3">
                      {e.actorName ? (
                        <div>
                          <div className="text-xs font-medium text-brand-navy">{e.actorName}</div>
                          {e.actorEmail && <div className="text-[10px] text-gray-400">{e.actorEmail}</div>}
                        </div>
                      ) : (
                        <span className="text-xs text-gray-300 italic">system</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Outstanding Items ────────────────────────────────────────────────────────

const STUCK_THRESHOLDS: Partial<Record<string, number>> = {
  intake: 5, active_search: 30, offer_active: 10,
  under_contract: 35, pre_close: 10, closing: 5,
};

type OutstandingGroup = {
  id: string;
  label: string;
  severity: 'critical' | 'warning' | 'info';
  deals: Deal[];
};

function OutstandingItems({ deals }: { deals: Deal[] }) {
  const active = deals.filter((d) => d.stage !== 'post_close');

  const groups: OutstandingGroup[] = [
    {
      id: 'red',
      label: 'Red Health Deals',
      severity: 'critical',
      deals: active.filter((d) => d.health === 'red'),
    },
    {
      id: 'overdue',
      label: 'Overdue Tasks',
      severity: 'critical',
      deals: active.filter((d) => (d.overdueTaskCount ?? 0) > 0),
    },
    {
      id: 'stuck',
      label: 'Stuck in Stage',
      severity: 'warning',
      deals: active.filter((d) => {
        const threshold = STUCK_THRESHOLDS[d.stage];
        return threshold != null && d.timeline.daysInStage >= threshold;
      }),
    },
    {
      id: 'no_closing_date',
      label: 'Missing Closing Date',
      severity: 'warning',
      deals: active.filter(
        (d) => ['pre_close', 'closing'].includes(d.stage) && !d.timeline.closingDate,
      ),
    },
    {
      id: 'unpaid_fees',
      label: 'Unpaid Closing Fees',
      severity: 'info',
      deals: deals.filter(
        (d) => d.stage === 'post_close' && (d.feeStatus === 'unpaid' || d.feeStatus === 'pending'),
      ),
    },
  ].filter((g) => g.deals.length > 0) as OutstandingGroup[];

  const totalDeals = new Set(groups.flatMap((g) => g.deals.map((d) => d.id))).size;

  const SEVERITY_STYLES = {
    critical: {
      border: 'border-l-red-500',
      icon: <AlertTriangle size={15} className="text-red-500 flex-shrink-0" />,
      badge: 'bg-red-100 text-red-700',
      header: 'text-red-600',
    },
    warning: {
      border: 'border-l-amber-400',
      icon: <AlertTriangle size={15} className="text-amber-500 flex-shrink-0" />,
      badge: 'bg-amber-100 text-amber-700',
      header: 'text-amber-600',
    },
    info: {
      border: 'border-l-blue-400',
      icon: <DollarSign size={15} className="text-blue-500 flex-shrink-0" />,
      badge: 'bg-blue-100 text-blue-700',
      header: 'text-blue-600',
    },
  };

  return (
    <div className="space-y-7">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Outstanding Items</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          {totalDeals} deal{totalDeals !== 1 ? 's' : ''} need attention across {groups.length} categor{groups.length !== 1 ? 'ies' : 'y'}
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl bg-white px-5 py-12 text-center shadow-sm">
          <CheckSquare size={28} className="mx-auto mb-3 text-green-400" />
          <p className="font-semibold text-green-600 mb-1">All clear</p>
          <p className="text-sm text-gray-400">No outstanding items across the pipeline</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {groups.map((g) => {
              const styles = SEVERITY_STYLES[g.severity];
              return (
                <div key={g.id} className={`rounded-xl bg-white px-5 py-4 shadow-sm border-l-4 ${styles.border}`}>
                  <div className={`text-xl font-bold mb-0.5 ${g.severity === 'critical' ? 'text-red-600' : g.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'}`}>
                    {g.deals.length}
                  </div>
                  <div className="text-xs text-gray-400 font-medium">{g.label}</div>
                </div>
              );
            })}
          </div>

          <div className="space-y-6">
            {groups.map((g) => {
              const styles = SEVERITY_STYLES[g.severity];
              return (
                <section key={g.id}>
                  <div className="mb-3 flex items-center gap-2">
                    {styles.icon}
                    <h2 className={`text-xs font-bold uppercase tracking-wider ${styles.header}`}>
                      {g.label} ({g.deals.length})
                    </h2>
                  </div>
                  <div className="space-y-2">
                    {g.deals.map((d) => (
                      <div
                        key={d.id}
                        className={`flex items-center gap-4 border-l-4 ${HEALTH_BORDER[d.health] ?? 'border-l-gray-300'} bg-white px-5 py-3 rounded-r-xl shadow-sm`}
                      >
                        <div className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${HEALTH_DOT[d.health] ?? 'bg-gray-300'}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-brand-navy text-sm">{d.clientName}</span>
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase ${d.type === 'buy' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                              {d.type}
                            </span>
                            {(d.overdueTaskCount ?? 0) > 0 && g.id === 'overdue' && (
                              <span className="flex items-center gap-1 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-600">
                                <AlertTriangle size={9} />
                                {d.overdueTaskCount} overdue
                              </span>
                            )}
                            {g.id === 'stuck' && (
                              <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                                {d.timeline.daysInStage}d in stage
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 truncate">
                            {d.property.address && `${d.property.address}${d.property.city ? `, ${d.property.city}` : ''}`}
                          </div>
                        </div>
                        <div className="text-xs text-gray-500 hidden sm:block w-28 text-center">
                          {STAGE_LABELS[d.stage]}
                        </div>
                        {d.agentName && (
                          <div className="flex items-center gap-1.5">
                            <div className="h-6 w-6 rounded-full bg-brand-navy/10 flex items-center justify-center text-[10px] font-bold text-brand-navy">
                              {initials(d.agentName)}
                            </div>
                            <span className="hidden lg:block text-xs text-gray-500">{d.agentName.split(' ')[0]}</span>
                          </div>
                        )}
                        {g.id === 'unpaid_fees' && (
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${FEE_BADGE[d.feeStatus ?? 'unpaid']}`}>
                            {d.feeStatus ?? 'unpaid'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Coming Soon placeholder ───────────────────────────────────────────────────

function ComingSoon({ title }: { title: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-brand-navy">{title}</h1>
      <div className="flex flex-col items-center justify-center rounded-xl bg-white py-16 shadow-sm text-center">
        <p className="text-gray-400 text-sm">Coming in a future phase</p>
      </div>
    </div>
  );
}

// ─── Companies (brokerage suggestions review queue) ─────────────────────────────

type BrokerageRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  suggested_by_name: string | null;
  suggested_by_email: string | null;
};

function CompaniesQueue() {
  const [pending, setPending] = useState<BrokerageRow[] | null>(null);
  const [active, setActive] = useState<BrokerageRow[] | null>(null);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  function load() {
    api.get<BrokerageRow[]>('/admin/brokerages?status=pending')
      .then(setPending)
      .catch((e) => setErr(e instanceof Error ? e.message : 'Failed to load'));
    api.get<BrokerageRow[]>('/admin/brokerages?status=active')
      .then(setActive)
      .catch(() => {});
  }
  useEffect(load, []);

  async function review(id: string, action: 'approve' | 'reject') {
    setBusyId(id);
    setErr('');
    try {
      await api.post(`/admin/brokerages/${id}`, { action });
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="p-6 md:p-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Companies</h1>
        <p className="text-sm text-gray-400 mt-1">
          Approve agent-entered companies into the onboarding dropdown, and see the active list.
        </p>
      </div>

      {err && <p className="text-sm text-red-500">{err}</p>}

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-400">
          Pending review
        </h2>
        {!pending ? (
          <p className="text-sm text-gray-400">Loading…</p>
        ) : pending.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-sm text-gray-400">
            Nothing to review.
          </div>
        ) : (
          <ul className="space-y-2">
            {pending.map((b) => (
              <li
                key={b.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-brand-navy">{b.name}</p>
                  <p className="text-xs text-gray-400">
                    Entered by {b.suggested_by_name ?? 'unknown'}
                    {b.suggested_by_email ? ` (${b.suggested_by_email})` : ''} ·{' '}
                    {new Date(b.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                </div>
                <div className="flex flex-shrink-0 gap-2">
                  <button
                    onClick={() => review(b.id, 'approve')}
                    disabled={busyId === b.id}
                    className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-40"
                  >
                    Add to list
                  </button>
                  <button
                    onClick={() => review(b.id, 'reject')}
                    disabled={busyId === b.id}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-gray-400">
          In the dropdown
        </h2>
        {active && (
          <div className="flex flex-wrap gap-1.5">
            {active.map((b) => (
              <span
                key={b.id}
                className="rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600"
              >
                {b.name}
              </span>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Main AdminDashboard ───────────────────────────────────────────────────────

export default function AdminDashboard() {
  const { section } = useParams<{ section?: string }>();
  const { deals, loading, refresh } = useDeals();

  if (section === 'users') return <UserManagement />;
  if (section === 'brokerages') return <CompaniesQueue />;

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-gray-400 text-sm">
        Loading…
      </div>
    );
  }

  switch (section) {
    case 'deals':       return <AllDeals deals={deals} />;
    case 'disclosures': return <PendingDisclosures deals={deals} />;
    case 'preapproval': return <PreApprovalQueue deals={deals} />;
    case 'stuck':       return <StuckDeals deals={deals} />;
    case 'fees':        return <FeesCollected deals={deals} />;
    case 'outstanding': return <OutstandingItems deals={deals} />;
    case 'fastpass':    return <ActiveFastPass deals={deals} refresh={refresh} />;
    case 'smoothexit':  return <SmoothExitQueue deals={deals} refresh={refresh} />;
    case 'arive':       return <AriveStatus deals={deals} />;
    case 'metro':       return <ComingSoon title="Metro View" />;
    case 'promotions':  return <Promotions />;
    case 'config':      return <AdminSystemConfig />;
    case 'audit':       return <AuditLog />;
    case 'forms':       return <FormReview />;
    default:            return <PipelineOverview deals={deals} />;
  }
}
