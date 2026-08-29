/**
 * #423 — the pure half of "the client portal's task list has to explain itself".
 *
 * The portals used to render one flat list of the client's own tasks, with
 * everything else on the deal silently dropped and no stage structure at all.
 * These are the decisions that drove that presentation, pulled out of the two
 * 1,400–2,600-line view components so they can be reasoned about on their own:
 * which stage bucket a task belongs to, how that bucket is introduced, what
 * order rows come out in, and who a task that isn't the client's belongs to.
 */
import { describe, it, expect } from "vitest";
import {
  groupTasksByStage,
  sortTasksByUrgency,
  stageGroupHeading,
  taskHandlerLabel,
} from "@/lib/portal-tasks";

type T = { id: string; stageContext?: string | null; status?: string };

const t = (id: string, stageContext?: string | null, status = "pending"): T => ({
  id,
  stageContext,
  status,
});

describe("groupTasksByStage (#423)", () => {
  it("buckets tasks by their stage_context and labels each bucket relative to the deal", () => {
    const groups = groupTasksByStage(
      [t("a", "intake"), t("b", "under_contract"), t("c", "closing")],
      "under_contract",
    );

    expect(groups.map((g) => [g.stage, g.when])).toEqual([
      ["under_contract", "now"],
      ["intake", "earlier"],
      ["closing", "upcoming"],
    ]);
  });

  it("leads with the current stage — earlier stages read as history, not as the job in hand", () => {
    const groups = groupTasksByStage(
      [t("old", "intake"), t("older", "active_search"), t("now", "pre_close")],
      "pre_close",
    );

    expect(groups[0].when).toBe("now");
    // …and the history itself stays in chronological order.
    expect(groups.slice(1).map((g) => g.stage)).toEqual(["intake", "active_search"]);
  });

  it("orders chronologically when asked, for a history list that reads forwards", () => {
    const groups = groupTasksByStage(
      [t("a", "pre_close"), t("b", "intake"), t("c", "active_search")],
      "pre_close",
      "chronological",
    );

    expect(groups.map((g) => g.stage)).toEqual(["intake", "active_search", "pre_close"]);
  });

  it("keeps every task — one with no usable stage falls into the current stage rather than vanishing", () => {
    const groups = groupTasksByStage(
      [t("none", null), t("junk", "not_a_stage"), t("real", "intake")],
      "active_search",
    );

    const all = groups.flatMap((g) => g.tasks.map((x) => x.id));
    expect(all.sort()).toEqual(["junk", "none", "real"]);
    expect(groups.find((g) => g.stage === "active_search")?.tasks.map((x) => x.id)).toEqual([
      "none",
      "junk",
    ]);
  });

  it("emits no empty groups", () => {
    const groups = groupTasksByStage([t("a", "intake")], "closing");
    expect(groups).toHaveLength(1);
    expect(groups[0].stage).toBe("intake");
  });

  it("returns nothing for no tasks", () => {
    expect(groupTasksByStage([], "intake")).toEqual([]);
  });

  it("preserves input order within a bucket, so a caller's own sort survives", () => {
    const groups = groupTasksByStage([t("z", "intake"), t("y", "intake")], "intake");
    expect(groups[0].tasks.map((x) => x.id)).toEqual(["z", "y"]);
  });
});

describe("sortTasksByUrgency (#423)", () => {
  it("puts overdue first, then in-progress, then pending", () => {
    const sorted = sortTasksByUrgency([
      t("p", "intake", "pending"),
      t("o", "intake", "overdue"),
      t("i", "intake", "in_progress"),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["o", "i", "p"]);
  });

  it("keeps a status the list has no rank for instead of dropping the row", () => {
    // The old inline `filter(overdue)/filter(in_progress)/filter(pending)`
    // rendered nothing for a 'blocked' task while still counting it in the tab
    // badge — a row the client was told about but could never see.
    const sorted = sortTasksByUrgency([t("b", "intake", "blocked"), t("p", "intake", "pending")]);
    expect(sorted.map((x) => x.id)).toEqual(["p", "b"]);
  });

  it("does not mutate the input", () => {
    const input = [t("p", "intake", "pending"), t("o", "intake", "overdue")];
    sortTasksByUrgency(input);
    expect(input.map((x) => x.id)).toEqual(["p", "o"]);
  });
});

describe("stageGroupHeading (#423)", () => {
  it("frames an earlier stage as unfinished history, not as current work", () => {
    expect(stageGroupHeading("earlier", "Home Search")).toMatch(/still open from home search/i);
  });

  it("frames the current stage as what is happening now", () => {
    expect(stageGroupHeading("now", "Under Contract")).toMatch(/right now/i);
    expect(stageGroupHeading("now", "Under Contract")).toMatch(/under contract/i);
  });

  it("frames a later stage as not yet due", () => {
    expect(stageGroupHeading("upcoming", "Closing Day")).toMatch(/coming up/i);
  });
});

describe("taskHandlerLabel (#423)", () => {
  it("names who owns a task the client cannot act on", () => {
    expect(taskHandlerLabel("agent")).toMatch(/your agent/i);
    expect(taskHandlerLabel("tc")).toMatch(/coordinator/i);
    expect(taskHandlerLabel("third_party")).toMatch(/vendor/i);
    expect(taskHandlerLabel("admin")).toMatch(/realtourflow/i);
  });

  it("falls back to the agent for an unknown or missing role — never an unattributed row", () => {
    expect(taskHandlerLabel(null)).toMatch(/your agent/i);
    expect(taskHandlerLabel(undefined)).toMatch(/your agent/i);
    expect(taskHandlerLabel("something_new")).toMatch(/your agent/i);
  });
});
