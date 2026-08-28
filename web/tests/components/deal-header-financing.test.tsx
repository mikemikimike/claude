// @vitest-environment happy-dom
/**
 * Issue #409 — the agent side of the cash-buyer fix.
 *
 * The deal header's only financing affordance was the "Pre-approved?" toggle.
 * For a cash buyer that pill is meaningless, and an agent looking at a buyer
 * who can suddenly make offers without it had nothing telling them why. The
 * header now shows the financing type the buyer picked in onboarding.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DealHeader } from "@/components/deal/DealHeader";
import type { Deal } from "@/lib/types";

const DEAL: Deal = {
  id: "deal-1",
  type: "buy",
  clientName: "Betty Buyer",
  clientId: "u-buyer",
  agentId: "u-agent",
  stage: "active_search",
  health: "green",
  priority: "medium",
  property: { address: "123 Oak St", city: "Hoover", state: "AL", zip: "35226", price: 300000 },
  timeline: { createdAt: "2026-01-01T00:00:00Z", daysInStage: 3 },
  flags: [],
  status: "active",
  estimatedCommission: 0,
  preApproved: false,
};

describe("DealHeader — buyer financing type (#409)", () => {
  it("badges a cash buyer so the agent knows the pre-approval pill is moot", () => {
    render(<DealHeader deal={{ ...DEAL, financingType: "cash" }} />);
    expect(screen.getByText(/cash buyer/i)).toBeInTheDocument();
  });

  it("shows no cash badge for a financed buyer", () => {
    render(<DealHeader deal={{ ...DEAL, financingType: "loan" }} />);
    expect(screen.queryByText(/cash buyer/i)).not.toBeInTheDocument();
    // The pre-approval toggle is still the financed buyer's gate.
    expect(screen.getByRole("button", { name: /pre-approved/i })).toBeInTheDocument();
  });

  it("shows no cash badge before the buyer has onboarded", () => {
    render(<DealHeader deal={DEAL} />);
    expect(screen.queryByText(/cash buyer/i)).not.toBeInTheDocument();
  });

  it("never badges a sell deal as a cash buyer", () => {
    render(<DealHeader deal={{ ...DEAL, type: "sell", financingType: "cash" }} />);
    expect(screen.queryByText(/cash buyer/i)).not.toBeInTheDocument();
  });
});
