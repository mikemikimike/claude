export const STAGE_ORDER = [
  "intake",
  "active_search",
  "offer_active",
  "under_contract",
  "pre_close",
  "closing",
  "post_close",
] as const;

export type DealStage = (typeof STAGE_ORDER)[number];

export type DealType = "buy" | "sell";

export type TaskStatus = "pending" | "in_progress" | "completed" | "skipped";

export function stageIndex(s: string): number {
  return STAGE_ORDER.indexOf(s as DealStage);
}

export function isForwardAdvance(from: string, to: string): boolean {
  const a = stageIndex(from);
  const b = stageIndex(to);
  return a >= 0 && b > a;
}

/**
 * How many still-open tasks each stage owns, keyed by the task's
 * `stageContext` (#420).
 *
 * Both client portals' journey rails used to check a stage off purely because
 * the deal had walked past it, so advancing a deal retroactively declared every
 * earlier stage finished. They now ask this instead: a walked-past stage is
 * only "done" when nothing it seeded is still open.
 *
 * Pass the ALREADY-FILTERED open tasks — the callers apply their own definition
 * of open (the server status ∪ the in-flight optimistic tick) and their own
 * audience filter (a buyer's rail counts the buyer's tasks, not the agent's).
 * A task with no `stageContext` belongs to no stage and is simply not counted.
 */
export function openTaskCountsByStage(
  openTasks: readonly { stageContext?: string | null }[]
): Partial<Record<DealStage, number>> {
  const counts: Partial<Record<DealStage, number>> = {};
  for (const task of openTasks) {
    const stage = task.stageContext as DealStage | undefined;
    if (!stage || stageIndex(stage) < 0) continue;
    counts[stage] = (counts[stage] ?? 0) + 1;
  }
  return counts;
}

/** Client-facing stage labels (buyer/seller notifications, stage-advance emails). */
export const STAGE_LABELS: Record<DealStage, string> = {
  intake: "Getting Started",
  active_search: "Property Search",
  offer_active: "Offer Active",
  under_contract: "Under Contract",
  pre_close: "Pre-Close",
  closing: "Closing Day",
  post_close: "Closed!",
};

/**
 * Internal stage labels for the agent / admin / TC views. Previously
 * copy-pasted into ~7 components (#89); this is now the single source.
 * Text intentionally differs from STAGE_LABELS above, which is the
 * client-facing wording.
 */
export const AGENT_STAGE_LABELS: Record<DealStage, string> = {
  intake: "Intake",
  active_search: "Active Search",
  offer_active: "Offer Active",
  under_contract: "Under Contract",
  pre_close: "Pre-Close",
  closing: "Closing",
  post_close: "Post-Close",
};
