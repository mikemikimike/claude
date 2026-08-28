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
