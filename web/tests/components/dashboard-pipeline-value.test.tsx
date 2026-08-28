// @vitest-environment happy-dom
/**
 * What the headline money on a dashboard is allowed to say.
 *
 * #411: never "$0" for a number the app doesn't know — "$0" reads like a
 * computed answer ("this pipeline is worth nothing"), so missing data renders
 * "—". That distinction stays.
 *
 * #459 (Paul, 2026-08-28): "Pipeline only fills in when the client goes under
 * contract, then it takes the commission % based on the contract price."
 * A deal at intake / active search / offer active contributes NOTHING, however
 * real its offer amount is — an offer can be rejected, so it is not pipeline
 * until it is accepted. Both dashboards ask the same `pipelinePrice` /
 * `pipelineCommission` rule, so the agent and admin rollups cannot drift.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { Deal } from "@/lib/types";

let deals: Deal[] = [];

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
// The dashboard also runs a closed-status query for its Completed Deals
// section (#417); only the un-filtered call is this test's pipeline.
vi.mock("@/hooks/useDeals", () => ({
  CLOSED_DEAL_STATUSES: "archived,fallen_through",
  useDeals: (statusFilter?: string) => ({
    deals: statusFilter ? [] : deals,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
// AdminDashboard's network boundary + router — the Pipeline Overview section
// touches neither, but the module imports both.
vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));

import AgentDashboard from "@/components/pages/agent/AgentDashboard";
import AdminDashboard from "@/components/pages/admin/AdminDashboard";

let dealSeq = 0;
function makeDeal(overrides: Partial<Deal> = {}): Deal {
  dealSeq += 1;
  return {
    id: `5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e${String(dealSeq).padStart(2, "0")}`,
    type: "buy",
    clientName: "Jane Buyer",
    clientId: "",
    agentId: "agent-1",
    stage: "offer_active",
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

/** A deal whose price the app knows — priced with its 3% commission. */
function pricedDeal(stage: Deal["stage"], price: number, overrides: Partial<Deal> = {}): Deal {
  const base = makeDeal(overrides);
  return {
    ...base,
    stage,
    property: { ...base.property, price },
    estimatedCommission: Math.round(price * 0.03),
  };
}

/** The stat card's big number, found by its label. */
function statValue(label: RegExp): string {
  const labelEl = screen.getByText(label);
  const card = labelEl.parentElement;
  return card?.firstElementChild?.textContent ?? "";
}

beforeEach(() => {
  deals = [];
  dealSeq = 0;
});

describe("AgentDashboard headline stats (#411 / #459)", () => {
  it("shows an em-dash, not $0, when no deal has a price", () => {
    deals = [makeDeal()];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("—");
    expect(statValue(/est\. commission/i)).toBe("—");
  });

  it("counts nothing for a deal at Offer Active, offer amount or not (#459)", () => {
    deals = [pricedDeal("offer_active", 475000)];
    render(<AgentDashboard />);

    // The offer is real, but it can still be rejected — not pipeline yet.
    expect(statValue(/pipeline value/i)).toBe("—");
    expect(statValue(/est\. commission/i)).toBe("—");
    // It is still one of the agent's deals.
    expect(statValue(/active deals/i)).toBe("1");
  });

  it("counts the contract price once the deal is under contract (#459)", () => {
    deals = [pricedDeal("under_contract", 475000)];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$475K");
    expect(statValue(/est\. commission/i)).toBe("$14K");
  });

  it("counts pre_close, closing and post_close too", () => {
    deals = [
      pricedDeal("pre_close", 300000),
      pricedDeal("closing", 400000),
      pricedDeal("post_close", 300000),
    ];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$1.00M");
    expect(statValue(/est\. commission/i)).toBe("$30K");
  });

  it("totals the under-contract deals only, ignoring the rest", () => {
    deals = [
      pricedDeal("under_contract", 475000),
      pricedDeal("offer_active", 600000), // a live offer — not counted
      makeDeal({ stage: "active_search" }), // unpriced — not counted
      pricedDeal("closing", 525000),
    ];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$1.00M");
    expect(statValue(/est\. commission/i)).toBe("$30K");
    // Every deal is still a deal — only its money is gated.
    expect(statValue(/active deals/i)).toBe("4");
  });

  it("an under-contract deal with no contract price still shows '—', not $0 (#411)", () => {
    deals = [makeDeal({ stage: "under_contract" })];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("—");
    expect(statValue(/est\. commission/i)).toBe("—");
  });
});

describe("Admin rollups agree with the agent dashboard (#459)", () => {
  // Same deal set, both dashboards. The admin card abbreviates millions to one
  // decimal and the agent card to two, so keep the totals under $1M and the
  // strings are directly comparable.
  const sameDeals = () => [
    pricedDeal("under_contract", 475000),
    pricedDeal("offer_active", 600000),
    makeDeal({ stage: "intake" }),
    pricedDeal("pre_close", 300000),
  ];

  it("totals the same pipeline and commission from the same deals", () => {
    deals = sameDeals();
    render(<AgentDashboard />);
    const agentPipeline = statValue(/^pipeline value$/i);
    const agentCommission = statValue(/est\. commission/i);
    cleanup();

    render(<AdminDashboard />);
    expect(statValue(/total pipeline value/i)).toBe(agentPipeline);
    expect(statValue(/est\. commission/i)).toBe(agentCommission);
    expect(agentPipeline).toBe("$775K");
    expect(agentCommission).toBe("$23K");
  });

  it("shows '—' on the admin cards when nothing is under contract", () => {
    deals = [pricedDeal("offer_active", 600000), makeDeal({ stage: "active_search" })];
    render(<AdminDashboard />);

    expect(statValue(/total pipeline value/i)).toBe("—");
    expect(statValue(/est\. commission/i)).toBe("—");
  });
});
