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
 *
 * #417 later gave the final stage a REAL action ("Mark Deal Complete", when
 * the caller passes `onComplete`); the guard below renders the bar without
 * that prop, which is the no-action case #416 fixed. The completion action's
 * own tests live in `deal-completion.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { StageTransitionBar } from "@/components/deal/StageTransitionBar";
import type { Deal, DealStage } from "@/lib/types";

// StageTransitionBar calls useProperties + useOffers (react-query) when the
// stage is offer_active. Stub both so the component renders without a
// QueryClient; the per-test data lives in the mutable arrays below.
let mockProperties: Record<string, unknown>[] = [];
let mockOffers: Record<string, unknown>[] = [];

vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({ properties: mockProperties, loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useOffers", () => ({
  useOffers: () => ({ offers: mockOffers, loading: false, refresh: vi.fn() }),
}));

beforeEach(() => {
  mockProperties = [];
  mockOffers = [];
});

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

/**
 * #410 — the offer banner named whichever listing the *buyer* had tapped
 * "Make an Offer" on. That showed nothing when they'd tapped nothing, and
 * silently picked the first when they'd tapped two. The banner must read the
 * real `offers` row the advance now writes.
 */
describe("StageTransitionBar offer banner (#410)", () => {
  const OAK = { id: "p-1", address: "12 Oak St", offerRequested: false };
  const WILLOW = { id: "p-2", address: "9 Willow Ln", offerRequested: true };

  it("names the property from the linked offer, not from offerRequested", () => {
    mockProperties = [OAK, WILLOW];
    mockOffers = [{ id: "o-1", trackedPropertyId: "p-1", offerPrice: 385000 }];

    renderBar("offer_active");

    expect(screen.getByText(/Offer on 12 Oak St/)).toBeTruthy();
    expect(screen.queryByText(/9 Willow Ln/)).toBeNull();
  });

  it("shows the offer amount next to the address", () => {
    mockProperties = [OAK];
    mockOffers = [{ id: "o-1", trackedPropertyId: "p-1", offerPrice: 385000 }];

    renderBar("offer_active");

    expect(screen.getByText(/\$385,000/)).toBeTruthy();
  });

  it("names the property even when the buyer never tapped 'Make an Offer'", () => {
    mockProperties = [{ id: "p-1", address: "12 Oak St", offerRequested: false }];
    mockOffers = [{ id: "o-1", trackedPropertyId: "p-1", offerPrice: 400000 }];

    renderBar("offer_active");

    expect(screen.getByText(/Offer on 12 Oak St/)).toBeTruthy();
    expect(screen.queryByText(/awaiting seller response/)).toBeNull();
  });

  it("falls back to the offerRequested guess for a pre-#410 deal with no offer row", () => {
    mockProperties = [OAK, WILLOW];
    mockOffers = [];

    renderBar("offer_active");

    expect(screen.getByText(/Offer on 9 Willow Ln/)).toBeTruthy();
  });

  it("ignores an offer with no property link and stays honest about not knowing", () => {
    mockProperties = [OAK];
    mockOffers = [{ id: "o-1", trackedPropertyId: undefined, offerPrice: 385000 }];

    renderBar("offer_active");

    expect(screen.getByText(/awaiting seller response/)).toBeTruthy();
  });
});
