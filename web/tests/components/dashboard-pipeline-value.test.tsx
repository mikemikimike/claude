// @vitest-environment happy-dom
/**
 * Pipeline Value / Est. Commission must not read "$0" when the app simply
 * doesn't know the number yet (#411).
 *
 * Both stat cards are `deals.price` × the commission rate, and nothing in the
 * normal flow filled `deals.price` in — so on a live prod walkthrough every
 * headline figure on the agent dashboard read $0, including a deal past Offer
 * Active with an active Fast Pass. "$0" reads like a computed answer ("this
 * pipeline is worth nothing"); missing data has to look missing. A deal with a
 * real price still totals normally, and a mixed pipeline totals the deals it
 * knows rather than dragging the average down with phantom zeroes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
vi.mock("@/hooks/useDeals", () => ({
  useDeals: () => ({ deals, loading: false, error: null, refresh: vi.fn() }),
}));

import AgentDashboard from "@/components/pages/agent/AgentDashboard";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01",
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

/** The stat card's big number, found by its label. */
function statValue(label: RegExp): string {
  const labelEl = screen.getByText(label);
  const card = labelEl.parentElement;
  return card?.firstElementChild?.textContent ?? "";
}

beforeEach(() => {
  deals = [];
});

describe("AgentDashboard headline stats (#411)", () => {
  it("shows an em-dash, not $0, when no deal has a price", () => {
    deals = [makeDeal()];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("—");
    expect(statValue(/est\. commission/i)).toBe("—");
  });

  it("shows the real numbers for a deal advanced to Offer Active with an offer amount", () => {
    deals = [makeDeal({ property: { ...makeDeal().property, price: 475000 }, estimatedCommission: 14250 })];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$475K");
    expect(statValue(/est\. commission/i)).toBe("$14K");
  });

  it("totals only the deals it knows — an unpriced deal contributes nothing, not a zero", () => {
    deals = [
      makeDeal({ property: { ...makeDeal().property, price: 475000 }, estimatedCommission: 14250 }),
      makeDeal({ id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e02" }),
      makeDeal({
        id: "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e03",
        property: { ...makeDeal().property, price: 525000 },
        estimatedCommission: 15750,
      }),
    ];
    render(<AgentDashboard />);

    expect(statValue(/pipeline value/i)).toBe("$1.00M");
    expect(statValue(/est\. commission/i)).toBe("$30K");
    // The unpriced deal is still counted as a deal — only its money is unknown.
    expect(statValue(/active deals/i)).toBe("3");
  });
});
