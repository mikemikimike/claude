// @vitest-environment happy-dom
/**
 * Pre-approval on the agent dashboard (#438, FF15).
 *
 * An agent running a pipeline should not have to open each deal to find out
 * which buyer is stuck on their pre-approval. Paul: "I want it easily noticed
 * by the agent."
 *
 * The pre-approval task is created with `role: 'buyer'`, so it landed in
 * "Waiting on Client" — indistinguishable from any other client task, and in
 * the panel an agent scans LAST. Both of its open states are actually the
 * AGENT's move (chase a buyer who hasn't started; confirm one who says they
 * applied), so it belongs in "Needs Your Action", which is the panel the tester
 * singled out.
 *
 * The task is matched on `source === 'preapproval'` and NEVER on its title
 * (#460 pulled the copy out of every structural position on purpose).
 *
 * This file is separate from agent-dashboard.test.tsx so #417's Completed Deals
 * suite keeps its own fixtures; the module mocks below are the same seams.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Deal, Task } from "@/lib/types";

let activeDeals: Deal[] = [];
let closedDeals: Deal[] = [];
let agentTasks: Task[] = [];

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
  useAgentTasks: () => ({ tasks: agentTasks, loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useMLS", () => ({
  useMLSConnection: () => ({
    connected: true,
    known: true,
    loading: false,
    saveMLS: vi.fn(),
    disconnectMLS: vi.fn(),
  }),
}));
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

const DEAL_ID = "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: DEAL_ID,
    type: "buy",
    clientName: "Jane Buyer",
    clientId: "",
    agentId: "agent-1",
    stage: "active_search",
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
    flags: ["mountain_mortgage"],
    status: "active",
    estimatedCommission: null,
    commissionPct: 3,
    openTaskCount: 1,
    overdueTaskCount: 0,
    preApproved: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-preapproval-1",
    dealId: DEAL_ID,
    title: "Get pre-approved with Mountain Mortgage",
    assignedTo: "buyer",
    assignedToId: "",
    status: "pending",
    priority: "high",
    source: "preapproval",
    stageContext: "active_search",
    ...overrides,
  };
}

function sectionNamed(name: RegExp): HTMLElement {
  const heading = screen.getByRole("heading", { name });
  const section = heading.closest("section");
  if (!section) throw new Error(`section not found: ${name}`);
  return section;
}

const needsAction = () => sectionNamed(/needs your action/i);
const waitingOnClient = () => sectionNamed(/waiting on client/i);

beforeEach(() => {
  activeDeals = [];
  closedDeals = [];
  agentTasks = [];
});

describe("AgentDashboard — pre-approval in Needs Your Action (#438)", () => {
  it("puts a not-started pre-approval in Needs Your Action, naming the client", () => {
    activeDeals = [makeDeal()];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    const panel = needsAction();
    expect(within(panel).getByText("Jane Buyer")).toBeInTheDocument();
    expect(within(panel).getByTestId("pre-approval-state")).toHaveAttribute(
      "data-state",
      "not_started"
    );
  });

  it("shows the applied state, with its date, once the buyer marks applied", () => {
    activeDeals = [makeDeal({ preApprovalAppliedAt: "2026-08-12T12:00:00Z" })];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    const state = within(needsAction()).getByTestId("pre-approval-state");
    expect(state).toHaveAttribute("data-state", "applied");
    expect(within(state).getByText(/Aug 12, 2026/)).toBeInTheDocument();
  });

  it("does not list the same task twice — it leaves Waiting on Client", () => {
    activeDeals = [makeDeal()];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    expect(within(needsAction()).getAllByTestId("pre-approval-state")).toHaveLength(1);
    expect(
      within(waitingOnClient()).queryByTestId("pre-approval-state")
    ).not.toBeInTheDocument();
  });

  it("keeps ordinary client tasks in Waiting on Client, untouched", () => {
    activeDeals = [makeDeal()];
    agentTasks = [
      makeTask({ id: "t-other", source: "ai", title: "Upload your ID", priority: "high" }),
    ];
    render(<AgentDashboard />);

    expect(within(waitingOnClient()).getByText("Upload your ID")).toBeInTheDocument();
    expect(
      within(needsAction()).queryByText("Upload your ID")
    ).not.toBeInTheDocument();
  });

  it("stops nagging the agent once they confirm pre-approval", () => {
    // `pre_approved` is the end of the line, so the row leaves Needs Your
    // Action. It is NOT hidden outright: the task row is still open, and
    // dropping an open task off the dashboard entirely would be a regression.
    // It stays where a buyer task normally lives, now reading "Pre-approved" —
    // which tells the agent it is safe to close.
    activeDeals = [makeDeal({ preApproved: true, preApprovalAppliedAt: "2026-08-12T12:00:00Z" })];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    expect(
      within(needsAction()).queryByTestId("pre-approval-state")
    ).not.toBeInTheDocument();
    expect(within(needsAction()).getByText(/nothing here/i)).toBeInTheDocument();
    expect(
      within(waitingOnClient()).getByTestId("pre-approval-state")
    ).toHaveAttribute("data-state", "pre_approved");
  });

  it("drops the row once the task is completed", () => {
    activeDeals = [makeDeal()];
    agentTasks = [makeTask({ status: "completed" })];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("pre-approval-state")).not.toBeInTheDocument();
  });

  it("never labels a CASH buyer's row — it falls back to the plain status chip", () => {
    // #409 — a cash buyer has no lender and can never satisfy a pre-approval,
    // so "Not started" would be actively wrong. The deal's own card suppresses
    // this case; the dashboard must agree, or the two surfaces contradict each
    // other. The task is not hidden — it stays where a buyer task lives.
    activeDeals = [makeDeal({ financingType: "cash" })];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("pre-approval-state")).not.toBeInTheDocument();
    expect(
      within(waitingOnClient()).getByText("Get pre-approved with Mountain Mortgage")
    ).toBeInTheDocument();
    expect(within(needsAction()).getByText(/nothing here/i)).toBeInTheDocument();
  });

  it("renders nothing extra for an agent with no pre-approval tasks", () => {
    activeDeals = [makeDeal({ flags: [] })];
    agentTasks = [];
    render(<AgentDashboard />);

    expect(screen.queryByTestId("pre-approval-state")).not.toBeInTheDocument();
    expect(within(needsAction()).getByText(/nothing here/i)).toBeInTheDocument();
  });

  it("survives a pre-approval task whose deal is not in the active list", () => {
    // A task can outlive its deal in the cache (archived deal, stale query).
    // The row must degrade rather than throw.
    activeDeals = [];
    agentTasks = [makeTask()];
    render(<AgentDashboard />);

    expect(within(needsAction()).getByTestId("pre-approval-state")).toHaveAttribute(
      "data-state",
      "not_started"
    );
  });
});
