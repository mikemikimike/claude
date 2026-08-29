// @vitest-environment happy-dom
/**
 * Completed Deals section on the agent dashboard (#417).
 *
 * Finishing a deal was a dead end: the only way to close one out was an
 * Archive link buried in the deal header, and once archived the deal vanished
 * from the dashboard and the pipeline with nothing anywhere in the app that
 * could show it again. `listDealsForUser` has taken a `statusFilter` since
 * #254 — nothing ever passed one.
 *
 * The dashboard now runs a SECOND deals query for the closed statuses
 * (`archived,fallen_through`) and renders them in their own section, each
 * linking back to the deal so it can be reopened / reactivated. The regression
 * that matters is the separation: a closed deal must appear ONLY in the
 * Completed section, never mixed into On Track (which is fed by the default
 * active-only query).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Deal } from "@/lib/types";

let activeDeals: Deal[] = [];
let closedDeals: Deal[] = [];
// The agent's own MLS connection (#428) — drives the "connect your MLS" nudge.
let mlsConnection = { connected: true, known: true, loading: false };

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel: (s: { activeUser: { name: string; email: string } }) => unknown) =>
    sel({ activeUser: { name: "Dana Agent", email: "dana@example.com" } }),
}));
vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: { name: "Dana Agent" }, loading: false }),
}));
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({ notifications: [], markRead: vi.fn() }),
}));
vi.mock("@/hooks/useTasks", () => ({
  useAgentTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useMLS", () => ({
  useMLSConnection: () => ({
    ...mlsConnection,
    saveMLS: vi.fn(),
    disconnectMLS: vi.fn(),
  }),
}));
// The dashboard runs two queries against the same hook; the status argument is
// what tells them apart, so the fake honours it exactly like the real hook's
// `?status=` passthrough does.
vi.mock("@/hooks/useDeals", () => ({
  CLOSED_DEAL_STATUSES: "archived,fallen_through",
  useDeals: (statusFilter?: string) => ({
    deals: statusFilter ? closedDeals : activeDeals,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import AgentDashboard from "@/components/pages/agent/AgentDashboard";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01",
    type: "buy",
    clientName: "Jane Buyer",
    clientId: "",
    agentId: "agent-1",
    stage: "under_contract",
    health: "green",
    priority: "medium",
    property: {
      address: "123 Main Street",
      city: "Birmingham",
      state: "AL",
      zip: "35203",
      price: null,
    },
    timeline: { createdAt: "2026-05-01T00:00:00Z", daysInStage: 4 },
    flags: [],
    status: "active",
    estimatedCommission: null,
    commissionPct: 3,
    openTaskCount: 0,
    overdueTaskCount: 0,
    ...overrides,
  };
}

/** The Completed Deals card, found by its heading. */
function completedSection(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /completed deals/i });
  const section = heading.closest("section");
  if (!section) throw new Error("Completed Deals section not found");
  return section;
}

/** The On Track card, found by its heading. */
function onTrackSection(): HTMLElement {
  const heading = screen.getByRole("heading", { name: /^on track$/i });
  const section = heading.closest("section");
  if (!section) throw new Error("On Track section not found");
  return section;
}

beforeEach(() => {
  activeDeals = [];
  closedDeals = [];
  mlsConnection = { connected: true, known: true, loading: false };
});

describe("AgentDashboard — Completed Deals (#417)", () => {
  it("renders a Completed Deals section even when nothing is closed yet", () => {
    activeDeals = [makeDeal()];
    render(<AgentDashboard />);

    expect(screen.getByRole("heading", { name: /completed deals/i })).toBeTruthy();
    expect(within(completedSection()).getByText(/no completed deals/i)).toBeTruthy();
  });

  it("lists archived deals in the Completed section and keeps them out of On Track", () => {
    activeDeals = [makeDeal({ clientName: "Still Going" })];
    closedDeals = [
      makeDeal({
        id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e02",
        clientName: "Wrapped Up",
        stage: "post_close",
        status: "archived",
        property: { address: "9 Oak Ave", city: "Hoover", state: "AL", zip: "35226", price: 425000 },
        timeline: { createdAt: "2026-01-02T00:00:00Z", daysInStage: 12, closingDate: "2026-07-18" },
      }),
    ];
    render(<AgentDashboard />);

    const completed = within(completedSection());
    expect(completed.getByText("Wrapped Up")).toBeTruthy();
    // Close date and final value are the two things worth seeing on a done deal.
    expect(completed.getByText(/2026-07-18/)).toBeTruthy();
    expect(completed.getByText("$425,000")).toBeTruthy();

    // …and it must NOT be duplicated into the active On Track column.
    expect(within(onTrackSection()).queryByText("Wrapped Up")).toBeNull();
    expect(within(onTrackSection()).getByText("Still Going")).toBeTruthy();
  });

  it("links each completed deal back to its deal page so it can be reopened", () => {
    closedDeals = [
      makeDeal({
        id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e03",
        clientName: "Wrapped Up",
        status: "archived",
      }),
    ];
    render(<AgentDashboard />);

    const link = within(completedSection()).getByRole("link", { name: /wrapped up/i });
    expect(link.getAttribute("href")).toBe(
      "/agent/deals/5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e03"
    );
  });

  it("labels the outcome: closed at post-close, filed away, or fell through", () => {
    closedDeals = [
      makeDeal({
        id: "aaaaaaaa-0000-4000-8000-000000000001",
        clientName: "Closed Deal",
        stage: "post_close",
        status: "archived",
      }),
      makeDeal({
        id: "aaaaaaaa-0000-4000-8000-000000000002",
        clientName: "Filed Deal",
        stage: "active_search",
        status: "archived",
      }),
      makeDeal({
        id: "aaaaaaaa-0000-4000-8000-000000000003",
        clientName: "Dead Deal",
        stage: "under_contract",
        status: "fallen_through",
      }),
    ];
    render(<AgentDashboard />);

    const completed = within(completedSection());
    expect(completed.getByText("Closed")).toBeTruthy();
    expect(completed.getByText("Archived")).toBeTruthy();
    expect(completed.getByText("Fell through")).toBeTruthy();
  });

  it("does not count completed deals in the Active Deals stat (that stays the active query)", () => {
    activeDeals = [makeDeal(), makeDeal({ id: "aaaaaaaa-0000-4000-8000-000000000009" })];
    closedDeals = [
      makeDeal({ id: "aaaaaaaa-0000-4000-8000-00000000000a", status: "archived" }),
      makeDeal({ id: "aaaaaaaa-0000-4000-8000-00000000000b", status: "fallen_through" }),
    ];
    render(<AgentDashboard />);

    const label = screen.getByText(/active deals/i);
    expect(label.parentElement?.firstElementChild?.textContent).toBe("2");
  });
});

/**
 * A finished deal is not an active deal (#418).
 *
 * Reaching `post_close` does not change `deals.status` — nothing writes it —
 * so a deal the agent has already closed stays `status='active'` and keeps
 * arriving in the DEFAULT (active-only) deals query indefinitely. It therefore
 * inflated Active Deals, sat in On Track forever, and counted toward Pipeline
 * Value and Est. Commission as though the money were still coming.
 *
 * The rule, applied from one place (`isClosedOut` in lib/deal-lifecycle.ts):
 * a deal at `post_close`, OR one whose status is no longer `active`, is closed
 * out — whatever query it arrived in. Closed out means: out of the stats, out
 * of On Track, out of the money rollups, and INTO Completed Deals, which is
 * why every case here also checks it did not simply vanish.
 */
describe("AgentDashboard — a post-close deal stops being active (#418)", () => {
  /** The stat card's big number, found by its label. */
  function statValue(label: RegExp): string {
    const labelEl = screen.getByText(label);
    return labelEl.parentElement?.firstElementChild?.textContent ?? "";
  }

  /** A deal whose price the app knows, with its 3% commission. */
  function priced(stage: Deal["stage"], price: number, overrides: Partial<Deal> = {}): Deal {
    const base = makeDeal(overrides);
    return {
      ...base,
      stage,
      property: { ...base.property, price },
      estimatedCommission: Math.round(price * 0.03),
    };
  }

  // The active query returns all three: the finished deal is still
  // `status: 'active'` because nothing marks a post-close deal otherwise.
  const finished = () =>
    priced("post_close", 400000, {
      id: "cccccccc-0000-4000-8000-000000000001",
      clientName: "Finished Deal",
      status: "active",
      timeline: { createdAt: "2026-01-02T00:00:00Z", daysInStage: 30, closingDate: "2026-08-20" },
    });
  const midPipeline = () => [
    priced("under_contract", 300000, {
      id: "cccccccc-0000-4000-8000-000000000002",
      clientName: "Under Contract Deal",
    }),
    makeDeal({
      id: "cccccccc-0000-4000-8000-000000000003",
      clientName: "Searching Deal",
      stage: "active_search",
    }),
  ];

  it("excludes it from the Active Deals stat", () => {
    activeDeals = [finished(), ...midPipeline()];
    render(<AgentDashboard />);

    expect(statValue(/active deals/i)).toBe("2");
  });

  it("keeps it out of the On Track column", () => {
    activeDeals = [finished(), ...midPipeline()];
    render(<AgentDashboard />);

    const onTrack = within(onTrackSection());
    expect(onTrack.queryByText("Finished Deal")).toBeNull();
    expect(onTrack.getByText("Under Contract Deal")).toBeTruthy();
    expect(onTrack.getByText("Searching Deal")).toBeTruthy();
  });

  // The judgment call beyond the literal ticket: a closed deal is EARNED, not
  // pipeline. Only the under-contract deal's $300K counts, so the finished
  // deal's $400K must not appear in either money card.
  it("stops counting it toward Pipeline Value and Est. Commission", () => {
    activeDeals = [finished(), ...midPipeline()];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$300K");
    expect(statValue(/est\. commission/i)).toBe("$9K");
  });

  // Regression guard: with the finished deal gone, everything else counts and
  // buckets exactly as it did before this change.
  it("leaves mid-pipeline deals counting and bucketing exactly as before", () => {
    activeDeals = midPipeline();
    render(<AgentDashboard />);

    expect(statValue(/active deals/i)).toBe("2");
    expect(statValue(/pipeline value/i)).toBe("$300K");
    expect(statValue(/est\. commission/i)).toBe("$9K");
    const onTrack = within(onTrackSection());
    expect(onTrack.getByText("Under Contract Deal")).toBeTruthy();
    expect(onTrack.getByText("Searching Deal")).toBeTruthy();
    expect(within(completedSection()).getByText(/no completed deals/i)).toBeTruthy();
  });

  // …and it must not simply disappear. The Completed section queries by
  // STATUS, so a post_close deal still marked `active` would be excluded from
  // the pipeline by the fix above and included by nothing at all.
  it("surfaces it under Completed Deals, still openable", () => {
    activeDeals = [finished(), ...midPipeline()];
    render(<AgentDashboard />);

    const completed = within(completedSection());
    expect(completed.getByText("Finished Deal")).toBeTruthy();
    expect(completed.getByText("Closed")).toBeTruthy();
    expect(
      completed.getByRole("link", { name: /finished deal/i }).getAttribute("href")
    ).toBe("/agent/deals/cccccccc-0000-4000-8000-000000000001");
  });

  // The closed-status query can return the SAME deal once an agent archives it
  // (post_close + archived). It must be listed once, not twice.
  it("does not list a deal twice when it is both post-close and archived", () => {
    const archived = { ...finished(), status: "archived" as const };
    activeDeals = [];
    closedDeals = [archived];
    render(<AgentDashboard />);

    expect(within(completedSection()).getAllByText("Finished Deal")).toHaveLength(1);
    expect(statValue(/active deals/i)).toBe("0");
  });
});

/**
 * #428 — the other half of the fix. A buyer whose agent never connected MLS
 * used to be the only person who found out, and only by hitting the wall. Once
 * one of the agent's buy deals reaches Home Search, the agent is told too.
 */
describe("AgentDashboard — connect-your-MLS nudge (#428)", () => {
  const searching = () =>
    makeDeal({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      type: "buy",
      stage: "active_search",
      clientName: "Betty Buyer",
    });

  it("prompts the agent when a buy deal is house-hunting and MLS is not connected", () => {
    mlsConnection = { connected: false, known: true, loading: false };
    activeDeals = [searching()];
    render(<AgentDashboard />);

    const nudge = screen.getByTestId("mls-connect-nudge");
    expect(within(nudge).getByText(/connect your mls/i)).toBeTruthy();
    expect(
      within(nudge).getByRole("link", { name: /connect mls/i }).getAttribute("href")
    ).toBe("/agent/settings");
  });

  it("stays quiet once MLS is connected", () => {
    mlsConnection = { connected: true, known: true, loading: false };
    activeDeals = [searching()];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("mls-connect-nudge")).toBeNull();
  });

  it("stays quiet when no buy deal has reached Home Search yet", () => {
    mlsConnection = { connected: false, known: true, loading: false };
    activeDeals = [
      makeDeal({ stage: "under_contract" }),
      makeDeal({ id: "bbbbbbbb-0000-4000-8000-000000000002", type: "sell", stage: "active_search" }),
    ];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("mls-connect-nudge")).toBeNull();
  });

  it("stays quiet while the connection state is still loading (no false alarm)", () => {
    mlsConnection = { connected: false, known: false, loading: true };
    activeDeals = [searching()];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("mls-connect-nudge")).toBeNull();
  });

  // The agent-side mirror of the #309 guard. `useMLSConnection` reports a FAILED
  // status read as `connected:false, known:false`; nagging a connected agent to
  // "connect your MLS" because /me/mls 500'd is the same mistake, pointed the
  // other way. Not knowing is not the same as knowing they aren't connected.
  it("stays quiet when the status read itself failed", () => {
    mlsConnection = { connected: false, known: false, loading: false };
    activeDeals = [searching()];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("mls-connect-nudge")).toBeNull();
  });
});
