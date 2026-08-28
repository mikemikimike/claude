// @vitest-environment happy-dom
/**
 * Regression test for the Fast Pass Detail → Survey handoff (#78).
 *
 * FastPassDetail stashes { selectedUpsells, total, dealId } in sessionStorage
 * under "fastPassSurveyState" before router.push (Next.js has no react-router
 * `{ state }` second arg). The survey used to hardcode that state to null — a
 * react-router port stub — so dealId was always null, the `if (dealId)` guard
 * never passed, and POST /deals/:id/fastpass never fired: the user saw the
 * success screen while nothing persisted (no enrollment, no Stripe). The
 * survey must read the stash, post the enrollment, clear the key on success,
 * and show an error — never the success screen — when the API call fails.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import FastPassSurvey, {
  HANDOFF_KEY,
} from "@/components/pages/onboarding/FastPassSurvey";
import { api } from "@/lib/api-client";
import { FAST_PASS_BASE_PRICE_CENTS } from "@/lib/fast-pass-catalog";
import { calcFastPassTotal, type FastPassUpsellId } from "@/lib/fast-pass-display";

// Mutable so individual tests can simulate a ?dealId= entry point. The `mock`
// prefix is what lets Vitest's hoisted vi.mock factory close over it.
let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock("@/lib/api-client", () => ({
  api: { post: vi.fn() },
}));

// SubmittedScreen reads the active user to pick a dashboard target. Give it a
// buyer so the success screen renders without touching the real store.
vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (selector: (s: { activeUser: { id: string; groupId: string } }) => unknown) =>
    selector({ activeUser: { id: "buyer-1", groupId: "buyer" } }),
}));

const mockPost = api.post as Mock;

const DEAL_ID = "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01";
// Base price + Utility Setup Concierge ($97), in dollars. Derived from the
// catalog so a base-price change doesn't need an edit here.
const STASHED_TOTAL = FAST_PASS_BASE_PRICE_CENTS / 100 + 97;

function seedHandoff() {
  sessionStorage.setItem(
    HANDOFF_KEY,
    JSON.stringify({
      dealId: DEAL_ID,
      selectedUpsells: ["utility_setup"],
      total: STASHED_TOTAL,
    })
  );
}

/** Click through the four question screens, stopping on the confirm screen. */
function driveToConfirm() {
  // Screen 0 — move situation (needs situation + move date + flexibility)
  fireEvent.click(screen.getByText("Currently renting"));
  fireEvent.click(screen.getByText("Day of closing"));
  fireEvent.click(screen.getByText("Very flexible"));
  fireEvent.click(screen.getByText("Continue"));
  // Screen 1 — moving preferences (size + mover + packing)
  fireEvent.click(screen.getByText("2 bedrooms"));
  fireEvent.click(screen.getByText("Coordinate movers for me"));
  fireEvent.click(screen.getByText("Self-pack — I'll handle all packing"));
  fireEvent.click(screen.getByText("Continue"));
  // Screen 2 — utilities (optional, just continue)
  fireEvent.click(screen.getByText("Continue"));
  // Screen 3 — notes
  fireEvent.click(screen.getByText("Review & Submit"));
}

/** Click through all five survey screens and hit Submit Request. */
function driveToSubmit() {
  driveToConfirm();
  // Screen 4 — confirm + payment option
  fireEvent.click(screen.getByText("Pay now"));
  fireEvent.click(screen.getByText("Submit Request"));
}

beforeEach(() => {
  sessionStorage.clear();
  mockPost.mockReset();
  mockSearchParams = new URLSearchParams();
});

describe("FastPassSurvey handoff", () => {
  it("posts the enrollment to /deals/:id/fastpass with the stashed upsells", async () => {
    seedHandoff();
    mockPost.mockResolvedValue({ ok: true });
    render(<FastPassSurvey />);
    driveToSubmit();

    await screen.findByText("You're in!");
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/deals/${DEAL_ID}/fastpass`);
    expect(body.payment_option).toBe("now");
    expect(body.selected_upsells).toEqual(["utility_setup"]);
    // Pay now → total at face value, in cents.
    expect(body.total_cents).toBe(STASHED_TOTAL * 100);
  });

  it("clears the sessionStorage handoff key after a successful submit", async () => {
    seedHandoff();
    mockPost.mockResolvedValue({ ok: true });
    render(<FastPassSurvey />);
    driveToSubmit();

    await screen.findByText("You're in!");
    expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
  });

  it("ignores a stale cross-deal stash when an explicit ?dealId= is present", async () => {
    // A prior Detail visit left add-ons stashed for DEAL_ID, but the user now
    // arrives via a direct entry point for a DIFFERENT deal. The submit must
    // target the query deal and NOT resurrect the stale add-ons (the confirm
    // screen never shows them), so the total falls back to the base price.
    seedHandoff();
    const OTHER_DEAL = "11111111-2222-3333-4444-555555555555";
    mockSearchParams = new URLSearchParams({ dealId: OTHER_DEAL });
    mockPost.mockResolvedValue({ ok: true });
    render(<FastPassSurvey />);
    driveToSubmit();

    await screen.findByText("You're in!");
    const [path, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/deals/${OTHER_DEAL}/fastpass`);
    expect(body.selected_upsells).toEqual([]);
    // Base price only, in cents — none of the stale upsell dollars.
    expect(body.total_cents).toBe(FAST_PASS_BASE_PRICE_CENTS);
  });

  it("shows an error — never the success screen — when the enrollment POST fails", async () => {
    seedHandoff();
    mockPost.mockRejectedValue(new Error("500 — boom"));
    render(<FastPassSurvey />);
    driveToSubmit();

    await screen.findByText(/couldn[’']t submit/i);
    expect(screen.queryByText("You're in!")).toBeNull();
    // Handoff is kept so the user can retry without losing the deal id.
    expect(sessionStorage.getItem(HANDOFF_KEY)).not.toBeNull();
  });
});

/**
 * #430 — the repriced add-ons must reach the buyer's eyes, not just the
 * Stripe charge. The confirm screen's line items are the last figures a buyer
 * sees before checking out, so they are pinned to the dollar here.
 */
describe("FastPassSurvey add-on pricing (#430)", () => {
  const REPRICED_UPSELLS: FastPassUpsellId[] = [
    "moving_coordination",
    "deep_clean",
    "staging_consult",
  ];
  // Derived from the catalog, exactly as FastPassDetail stashes it — so the
  // "$2,787" asserted below is the catalog's answer, not a number typed twice.
  const REPRICED_TOTAL = calcFastPassTotal(REPRICED_UPSELLS);

  function seedRepricedHandoff() {
    sessionStorage.setItem(
      HANDOFF_KEY,
      JSON.stringify({
        dealId: DEAL_ID,
        selectedUpsells: REPRICED_UPSELLS,
        total: REPRICED_TOTAL,
      })
    );
  }

  it("renders $475 moving / $425 deep clean / $100 staging on the checkout breakdown", () => {
    seedRepricedHandoff();
    render(<FastPassSurvey />);
    driveToConfirm();

    const row = (name: string) =>
      screen.getByText(name).parentElement as HTMLElement;

    expect(row("Moving Day Coordination")).toHaveTextContent("+$475");
    expect(row("Post-Close Deep Clean")).toHaveTextContent("+$425");
    expect(row("Staging & Design Consultation")).toHaveTextContent("+$100");
    // …and the basket the buyer agrees to: $1,787 + 475 + 425 + 100 = $2,787.
    expect(screen.getByText("Total").parentElement).toHaveTextContent("$2,787");
  });

  it("charges Stripe exactly the displayed basket on pay-now", async () => {
    seedRepricedHandoff();
    mockPost.mockResolvedValue({ ok: true });
    render(<FastPassSurvey />);
    driveToSubmit();

    await screen.findByText("You're in!");
    const [, body] = mockPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.selected_upsells).toEqual(REPRICED_UPSELLS);
    // 278700 cents — the same number the confirm screen just rendered.
    expect(body.total_cents).toBe(278700);
  });
});
