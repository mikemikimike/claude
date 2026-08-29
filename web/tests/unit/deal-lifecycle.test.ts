/**
 * The one "is this deal over?" rule (#418).
 *
 * Two independent endings, and every rollup in the app used to pick one of
 * them by hand — `stage !== 'post_close'` in five places on the admin
 * dashboard, `status`-only on the agent one. That is how the two drifted.
 */
import { describe, it, expect } from "vitest";
import { isClosedOut, isOpenPipeline, splitByLifecycle } from "@/lib/deal-lifecycle";

describe("isClosedOut (#418)", () => {
  it("a deal at post_close is over even though its status is still active", () => {
    // The bug in one line: nothing writes `deals.status` when a deal closes.
    expect(isClosedOut({ stage: "post_close", status: "active" })).toBe(true);
  });

  it("a deal closed out mid-pipeline is over at whatever stage it stopped", () => {
    expect(isClosedOut({ stage: "under_contract", status: "archived" })).toBe(true);
    expect(isClosedOut({ stage: "active_search", status: "fallen_through" })).toBe(true);
  });

  it("a live deal at any earlier stage is not", () => {
    for (const stage of ["intake", "active_search", "offer_active", "under_contract", "pre_close", "closing"]) {
      expect(isClosedOut({ stage, status: "active" })).toBe(false);
      expect(isOpenPipeline({ stage, status: "active" })).toBe(true);
    }
  });

  // The create response and /api/me/deals don't SELECT status. Absent must
  // read as active — a brand-new deal is not a finished one.
  it("treats an absent status as active, never as closed", () => {
    expect(isClosedOut({ stage: "intake" })).toBe(false);
    expect(isClosedOut({ stage: "under_contract", status: null })).toBe(false);
  });
});

describe("splitByLifecycle (#418)", () => {
  it("returns both halves so a caller cannot drop the closed one on the floor", () => {
    const deals = [
      { id: "a", stage: "under_contract", status: "active" },
      { id: "b", stage: "post_close", status: "active" },
      { id: "c", stage: "active_search", status: "archived" },
    ];
    const { open, closed } = splitByLifecycle(deals);

    expect(open.map((d) => d.id)).toEqual(["a"]);
    expect(closed.map((d) => d.id)).toEqual(["b", "c"]);
    // Nothing is lost or duplicated.
    expect(open.length + closed.length).toBe(deals.length);
  });
});
