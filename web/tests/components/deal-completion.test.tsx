// @vitest-environment happy-dom
/**
 * The front door and the way back out of a completed deal (#417).
 *
 * Closing a deal out used to mean finding the "Archive deal" link tucked under
 * the deal header — the tester's words were "if it's not immediately obvious,
 * it's not going to be immediately obvious for users either". And once
 * archived there was no affordance to undo it short of reopening the Edit Deal
 * modal and changing a Status dropdown.
 *
 * So: the final stage of the transition bar carries a real "Mark Deal
 * Complete" action (replacing #416's inert "Final stage" marker — the
 * invariant #416 actually established, that nothing at post_close is a
 * DISABLED call-to-action, is re-asserted here), and a closed deal's header
 * offers a one-click Reactivate.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StageTransitionBar } from "@/components/deal/StageTransitionBar";
import { DealHeader } from "@/components/deal/DealHeader";
import type { Deal } from "@/lib/types";

vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({ properties: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useOffers", () => ({
  useOffers: () => ({ offers: [], loading: false, refresh: vi.fn() }),
}));

const DEAL: Deal = {
  id: "0f6c6a2e-1b3d-4f5a-9c8b-2d1e3f4a5b6c",
  type: "buy",
  clientName: "Jane Buyer",
  clientId: "u-buyer",
  agentId: "u-agent",
  stage: "post_close",
  health: "green",
  priority: "medium",
  property: { address: "123 Oak St", city: "Hoover", state: "AL", zip: "35226", price: 300000 },
  timeline: { createdAt: "2026-01-01T00:00:00Z", daysInStage: 3 },
  flags: [],
  status: "active",
  estimatedCommission: 9000,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StageTransitionBar — completing a deal (#417)", () => {
  it("offers an enabled 'Mark Deal Complete' action at post_close", async () => {
    const onComplete = vi.fn();
    render(
      <StageTransitionBar
        stage="post_close"
        deal={DEAL}
        onAdvance={vi.fn()}
        onRetreat={vi.fn()}
        onComplete={onComplete}
      />,
    );

    const btn = screen.getByRole("button", { name: /mark deal complete/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    // #416's real invariant: no disabled call-to-action at the final stage.
    const disabled = screen
      .queryAllByRole("button")
      .filter((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toEqual([]);

    await userEvent.click(btn);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shows a static 'Deal complete' marker — not an action — once the deal is closed", () => {
    render(
      <StageTransitionBar
        stage="post_close"
        deal={{ ...DEAL, status: "archived" }}
        onAdvance={vi.fn()}
        onRetreat={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    expect(screen.getByText(/deal complete/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /mark deal complete/i })).toBeNull();
  });

  it("falls back to the 'Final stage' marker for a viewer who cannot complete it", () => {
    render(
      <StageTransitionBar stage="post_close" deal={DEAL} onAdvance={vi.fn()} onRetreat={vi.fn()} />,
    );

    expect(screen.getByText(/final stage/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /complete/i })).toBeNull();
  });

  it("leaves every earlier stage's advance button exactly as it was", () => {
    render(
      <StageTransitionBar
        stage="pre_close"
        deal={{ ...DEAL, stage: "pre_close" }}
        onAdvance={vi.fn()}
        onRetreat={vi.fn()}
        onComplete={vi.fn()}
      />,
    );

    expect((screen.getByRole("button", { name: /closing/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: /mark deal complete/i })).toBeNull();
  });
});

describe("DealHeader — reactivating a closed deal (#417)", () => {
  it("offers Reactivate on an archived deal and patches it back to active", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // happy-dom ships no window.confirm, so stub rather than spy.
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(
      <DealHeader deal={{ ...DEAL, status: "archived" }} canEdit onSave={onSave} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /reactivate/i }));
    expect(onSave).toHaveBeenCalledWith({ status: "active" });
  });

  it("offers Reactivate on a fallen-through deal too", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    // happy-dom ships no window.confirm, so stub rather than spy.
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(
      <DealHeader deal={{ ...DEAL, status: "fallen_through" }} canEdit onSave={onSave} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /reactivate/i }));
    expect(onSave).toHaveBeenCalledWith({ status: "active" });
  });

  it("shows Archive — not Reactivate — while the deal is still active", () => {
    render(<DealHeader deal={DEAL} canEdit onSave={vi.fn()} />);

    expect(screen.getByRole("button", { name: /archive deal/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /reactivate/i })).toBeNull();
  });

  it("shows neither control to someone who cannot edit the deal", () => {
    render(<DealHeader deal={{ ...DEAL, status: "archived" }} />);

    expect(screen.queryByRole("button", { name: /reactivate/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /archive deal/i })).toBeNull();
  });
});
