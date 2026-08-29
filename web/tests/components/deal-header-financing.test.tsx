// @vitest-environment happy-dom
/**
 * Issue #409 — the agent side of the cash-buyer fix.
 *
 * The deal header's only financing affordance was the "Pre-approved?" toggle.
 * For a cash buyer that pill is meaningless, and an agent looking at a buyer
 * who can suddenly make offers without it had nothing telling them why. The
 * header now shows the financing type the buyer picked in onboarding.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * Issue #451 — the agent override.
 *
 * #409 made the buyer's own onboarding answer the thing that lifts the offer
 * gate, with no agent-side undo: a buyer who mis-clicked "💰 Cash purchase"
 * unlocked their own "Make an Offer" CTA permanently, and the only correction
 * was hand-editing `deals.intake` in the database. The badge is a control now.
 */
describe("DealHeader — the agent corrects the financing type (#451)", () => {
  it("offers cash / financed on a buy deal when the agent can edit flags", () => {
    render(<DealHeader deal={{ ...DEAL, financingType: "cash" }} onFlagChange={() => {}} />);
    const select = screen.getByLabelText(/financing/i) as HTMLSelectElement;
    expect(select.value).toBe("cash");
    expect(screen.getByRole("option", { name: /cash/i })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /financed/i })).toBeInTheDocument();
  });

  it("emits the correction when the agent switches a mis-clicked cash buyer to financed", async () => {
    const onFlagChange = vi.fn();
    render(<DealHeader deal={{ ...DEAL, financingType: "cash" }} onFlagChange={onFlagChange} />);

    await userEvent.selectOptions(screen.getByLabelText(/financing/i), "loan");
    expect(onFlagChange).toHaveBeenCalledWith({ financingType: "loan" });
  });

  it("clears back to unknown with an explicit null — the safe direction", async () => {
    const onFlagChange = vi.fn();
    render(<DealHeader deal={{ ...DEAL, financingType: "cash" }} onFlagChange={onFlagChange} />);

    await userEvent.selectOptions(screen.getByLabelText(/financing/i), "");
    expect(onFlagChange).toHaveBeenCalledWith({ financingType: null });
  });

  it("shows the control on a buyer who never answered, so it can be set", () => {
    render(<DealHeader deal={DEAL} onFlagChange={() => {}} />);
    expect((screen.getByLabelText(/financing/i) as HTMLSelectElement).value).toBe("");
  });

  it("never offers it on a sell deal — financing is a buy-side question", () => {
    render(<DealHeader deal={{ ...DEAL, type: "sell" }} onFlagChange={() => {}} />);
    expect(screen.queryByLabelText(/financing/i)).not.toBeInTheDocument();
  });

  it("stays a read-only badge for a viewer who cannot edit flags", () => {
    render(<DealHeader deal={{ ...DEAL, financingType: "cash" }} />);
    expect(screen.queryByLabelText(/financing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/cash buyer/i)).toBeInTheDocument();
  });
});
