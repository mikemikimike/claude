// @vitest-environment happy-dom
/**
 * StageTransitionBar — no dead "Complete" button at the final stage (#416).
 *
 * At `post_close` there is no next stage, so `nextStage` was null: the advance
 * button's label ternary fell through to the literal string 'Complete' *and*
 * `disabled={!nextStage}` made it permanently un-clickable. A greyed-out button
 * labelled with an action the app never performs reads as broken software at
 * the most satisfying moment of the deal.
 *
 * The final stage must instead be shown as final — no advance button at all.
 * Every other stage's transition bar is unchanged.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageTransitionBar } from "@/components/deal/StageTransitionBar";
import type { Deal, DealStage } from "@/lib/types";

// StageTransitionBar calls useProperties (react-query) when the stage is
// offer_active. Stub it so the component renders without a QueryClient.
vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({ properties: [], loading: false, refresh: vi.fn() }),
}));

const DEAL = {
  id: "0f6c6a2e-1b3d-4f5a-9c8b-2d1e3f4a5b6c",
  clientName: "Jane Buyer",
  type: "buy",
} as unknown as Deal;

function renderBar(stage: DealStage) {
  return render(
    <StageTransitionBar
      stage={stage}
      deal={DEAL}
      onAdvance={vi.fn()}
      onRetreat={vi.fn()}
    />,
  );
}

/** Every <button> currently rendered, with its trimmed text + disabled flag. */
function buttons() {
  return screen.queryAllByRole("button").map((b) => ({
    text: (b.textContent ?? "").trim(),
    disabled: (b as HTMLButtonElement).disabled,
  }));
}

describe("StageTransitionBar", () => {
  it("renders no dead 'Complete' button at post_close", () => {
    renderBar("post_close");

    expect(screen.queryByRole("button", { name: /complete/i })).toBeNull();
    // Nothing in the bar may be a disabled call-to-action at the final stage.
    expect(buttons().filter((b) => b.disabled)).toEqual([]);
    // …and the stage is still shown as the final one.
    expect(screen.getByText("Post-Close")).toBeTruthy();
  });

  it("keeps an enabled advance button labelled with the next stage at pre_close", () => {
    renderBar("pre_close");

    const advance = screen.getByRole("button", { name: /closing/i }) as HTMLButtonElement;
    expect(advance.disabled).toBe(false);
  });

  it("still reads 'Offer Accepted' / 'Offer Rejected' at offer_active", () => {
    renderBar("offer_active");

    const accepted = screen.getByRole("button", { name: /offer accepted/i }) as HTMLButtonElement;
    const rejected = screen.getByRole("button", { name: /offer rejected/i }) as HTMLButtonElement;
    expect(accepted.disabled).toBe(false);
    expect(rejected.disabled).toBe(false);
  });

  it("disables only the retreat button at intake", () => {
    renderBar("intake");

    const retreat = screen.getByRole("button", { name: /back/i }) as HTMLButtonElement;
    const advance = screen.getByRole("button", { name: /active search/i }) as HTMLButtonElement;
    expect(retreat.disabled).toBe(true);
    expect(advance.disabled).toBe(false);
  });
});
