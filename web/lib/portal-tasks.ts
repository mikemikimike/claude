/**
 * How a client portal's task list is organised (#423).
 *
 * A tester on a `pre_close` deal looked at the buyer portal's task area and
 * asked "I don't know what this is — do I need to be doing these?". Two things
 * caused that: every one of the client's tasks rendered as one flat list with
 * no sense of *when* it belonged to, and anything on the deal that was NOT
 * theirs was silently dropped, so work the agent was doing for them was simply
 * invisible rather than explained.
 *
 * The decisions that fix it are pure functions and live here, out of the two
 * very large view components, so they can be tested and changed once instead of
 * twice. The components still own their own rendering: the buyer and seller
 * portals have different stage vocabularies and different task cards, so this
 * module deliberately returns data and copy fragments, never JSX.
 */

import { STAGE_ORDER, stageIndex, type DealStage } from "@/lib/stages";

/** Where a task's stage sits relative to the stage the deal is actually in. */
export type PortalTaskWhen = "earlier" | "now" | "upcoming";

export type PortalTaskGroup<T> = {
  stage: DealStage;
  when: PortalTaskWhen;
  tasks: T[];
};

type StagedTask = { stageContext?: string | null };
type StatusTask = { status?: string | null };

/**
 * Split tasks into one group per stage.
 *
 * `order`:
 *  - `current-first` (default) — the stage the deal is in leads, then earlier
 *    stages in chronological order, then later ones. This is the OPEN list: the
 *    client's attention belongs on now, and anything left over from a stage
 *    they have walked past reads as catch-up rather than as the job in hand.
 *  - `chronological` — plain stage order, for a completed list that reads as a
 *    history of the deal so far.
 *
 * A task whose `stage_context` is null or unrecognised is bucketed into the
 * CURRENT stage rather than discarded. Dropping it would reintroduce exactly the
 * bug this ticket exists to fix (a task the client is counted as owning but
 * never shown), and "it needs doing now" is the safe reading of "we don't know
 * when this belongs".
 */
export function groupTasksByStage<T extends StagedTask>(
  tasks: readonly T[],
  currentStage: DealStage,
  order: "current-first" | "chronological" = "current-first",
): PortalTaskGroup<T>[] {
  // A stage the app doesn't know about can't anchor "earlier"/"upcoming";
  // treating it as the first stage keeps every other task's framing sane.
  const currentIdx = Math.max(stageIndex(currentStage), 0);

  const byStage = new Map<DealStage, T[]>();
  for (const task of tasks) {
    const raw = task.stageContext as DealStage | null | undefined;
    const stage: DealStage = raw && stageIndex(raw) >= 0 ? raw : currentStage;
    const bucket = byStage.get(stage);
    if (bucket) bucket.push(task);
    else byStage.set(stage, [task]);
  }

  const groups: PortalTaskGroup<T>[] = STAGE_ORDER.filter((s) => byStage.has(s)).map((stage) => {
    const idx = stageIndex(stage);
    return {
      stage,
      when: idx < currentIdx ? "earlier" : idx > currentIdx ? "upcoming" : "now",
      tasks: byStage.get(stage) as T[],
    };
  });

  if (order === "chronological") return groups;

  // Stable sort: within each bucket the STAGE_ORDER pass above already put the
  // stages in chronological order, so history still reads forwards.
  const rank: Record<PortalTaskWhen, number> = { now: 0, earlier: 1, upcoming: 2 };
  return groups.sort((a, b) => rank[a.when] - rank[b.when]);
}

/**
 * Most-urgent-first ordering within a group.
 *
 * Replaces the three inline `openTasks.filter(status === …)` passes both portals
 * ran. Those passes rendered overdue / in_progress / pending and NOTHING else,
 * so a task in any other state was counted in the tab badge and then never
 * drawn — a row the client was told about but could not find. Anything without
 * a rank sorts last instead of disappearing.
 */
const URGENCY_RANK: Record<string, number> = {
  overdue: 0,
  in_progress: 1,
  pending: 2,
  blocked: 3,
};

export function sortTasksByUrgency<T extends StatusTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort(
    (a, b) =>
      (URGENCY_RANK[a.status ?? ""] ?? Number.MAX_SAFE_INTEGER) -
      (URGENCY_RANK[b.status ?? ""] ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * The one line that introduces a stage's group of open tasks.
 *
 * The stage label is passed in because the buyer and seller portals name the
 * same stage differently ("Home Search" vs "Prepping to List").
 */
export function stageGroupHeading(when: PortalTaskWhen, stageLabel: string): string {
  if (when === "earlier") return `Still open from ${stageLabel}`;
  if (when === "upcoming") return `Coming up — ${stageLabel}`;
  return `Right now — ${stageLabel}`;
}

/**
 * Who owns a task that isn't the client's, in the client's own words.
 *
 * Used only for the read-only "being handled for you" list, so the answer to
 * "do I need to do this?" is written on the row itself. Unknown roles fall back
 * to the agent — the client's single point of contact — because an
 * unattributed row is the exact thing this ticket is removing.
 */
export function taskHandlerLabel(role: string | null | undefined): string {
  switch (role) {
    case "tc":
      return "Your transaction coordinator";
    case "third_party":
      return "A vendor on your deal";
    case "admin":
      return "RealTourFlow";
    case "buyer":
      return "The buyer";
    case "seller":
      return "The seller";
    default:
      return "Your agent";
  }
}
