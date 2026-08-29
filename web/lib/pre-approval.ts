/**
 * The buyer's pre-approval state, as the AGENT reads it (#438, FF15).
 *
 * FF11–FF14 built the state; this module is the one place that turns it into
 * the three-way answer both agent surfaces render — the dashboard's "Needs Your
 * Action" panel and the deal's Overview tab. One derivation, so the two can
 * never disagree about what a buyer's file is doing.
 *
 * Pure and React-free on purpose: the shared pill lives in
 * `components/deal/shared.tsx`, the logic lives here.
 */
import type { Deal, Task } from "./types";

/**
 * The pre-approval task's identity (#460), client-side.
 *
 * The server writes it as `source = 'preapproval'` (`PRE_APPROVAL_TASK_SOURCE`
 * in lib/stage-task-seed.ts — NOT imported here: that module pulls in Prisma
 * and would drag the server bundle into a client component). Typed as
 * `Task['source']` so a typo is a compile error rather than a card that
 * silently never renders.
 *
 * Never match on the task's TITLE. #460 removed the copy from every structural
 * position precisely so it stays rewordable; keying on the sentence again would
 * put that trap straight back.
 */
export const PRE_APPROVAL_SOURCE: Task["source"] = "preapproval";

/**
 * The three states, in the order a buyer walks them.
 *
 * `not_started` and `applied` are both the AGENT's move — chase, or confirm —
 * which is why the dashboard files both under "Needs Your Action" rather than
 * "Waiting on Client".
 */
export type PreApprovalState = "not_started" | "applied" | "pre_approved";

/** The deal fields this module reads. Keeps callers free to pass a full Deal. */
export type PreApprovalDeal = Pick<
  Deal,
  "type" | "preApproved" | "preApprovalAppliedAt" | "financingType"
>;

export function findPreApprovalTask(tasks: Task[]): Task | undefined {
  return tasks.find((t) => t.source === PRE_APPROVAL_SOURCE);
}

/**
 * Which of the three states a deal is in.
 *
 * `pre_approved` OUTRANKS an applied date: the agent's confirmation is the
 * later, stronger signal, and a deal can carry both (the buyer marked applied,
 * then the agent confirmed). An unknown deal — a task whose deal isn't in the
 * cached list — reads as `not_started`, which is the safe direction: it prompts
 * a look rather than quietly asserting progress nobody recorded.
 */
export function preApprovalState(deal: PreApprovalDeal | undefined): PreApprovalState {
  if (deal?.preApproved) return "pre_approved";
  if (deal?.preApprovalAppliedAt) return "applied";
  return "not_started";
}

/**
 * Whether this deal has anything to say about pre-approval at all.
 *
 * False for sell deals, for a cash buyer (#409 — they have no lender and can
 * never satisfy a pre-approval), and for any deal that has neither a
 * pre-approval task nor recorded state. Callers render nothing when this is
 * false: a card that appears on every deal is a card nobody reads.
 */
export function hasPreApprovalState(deal: PreApprovalDeal, tasks: Task[]): boolean {
  if (deal.type !== "buy") return false;
  if (deal.financingType === "cash") return false;
  return Boolean(
    findPreApprovalTask(tasks) || deal.preApprovalAppliedAt || deal.preApproved
  );
}

/**
 * Should this task row speak in pre-approval terms at all?
 *
 * Same suppression as `hasPreApprovalState`, applied per task, so the dashboard
 * row and the deal's card can never disagree: labelling a cash buyer's row "Not
 * started" would be actively wrong (#409 — they have no lender and can never
 * satisfy a pre-approval), and a pre-approval task on a sell deal is nonsense.
 * Either way the row falls back to the ordinary status chip rather than
 * vanishing, so nothing is hidden from the agent.
 *
 * An UNKNOWN deal still counts — degrade toward prompting a look.
 */
export function isPreApprovalTask(
  task: Task,
  deal: PreApprovalDeal | undefined
): boolean {
  if (task.source !== PRE_APPROVAL_SOURCE) return false;
  return deal?.financingType !== "cash" && deal?.type !== "sell";
}

/**
 * Is this task still the agent's problem?
 *
 * An open pre-approval task on a deal the agent has already confirmed is not —
 * `pre_approved` is the end of the line, whatever the task row still says.
 */
export function isPreApprovalActionable(
  task: Task,
  deal: PreApprovalDeal | undefined
): boolean {
  if (!isPreApprovalTask(task, deal)) return false;
  if (task.status === "completed") return false;
  return !deal?.preApproved;
}

export const PRE_APPROVAL_STATE_LABELS: Record<PreApprovalState, string> = {
  not_started: "Not started",
  applied: "Applied",
  pre_approved: "Pre-approved",
};

/**
 * One line of context per state — what the agent should do about it.
 * Deliberately short: these render inside a dashboard row.
 */
export const PRE_APPROVAL_STATE_HINTS: Record<PreApprovalState, string> = {
  not_started: "Buyer hasn't applied yet",
  applied: "Waiting on your confirmation",
  pre_approved: "Confirmed — offers unlocked",
};

/**
 * Pill styling per state. Three genuinely different colours, because "at a
 * glance" is the entire requirement: red = stalled, amber = mid-flight,
 * green = done. Matches the HEALTH_BADGE palette used elsewhere.
 */
export const PRE_APPROVAL_STATE_BADGE: Record<PreApprovalState, string> = {
  not_started: "bg-red-100 text-red-700 border-red-200",
  applied: "bg-amber-100 text-amber-800 border-amber-200",
  pre_approved: "bg-green-100 text-green-700 border-green-200",
};

/**
 * `pre_approval_applied_at` (a timestamptz) as a short human date.
 *
 * Returns null for absent OR unparseable input — `new Date(undefined)` is how
 * "Invalid Date" reached a concierge's screen once already (#426).
 */
export function formatAppliedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
