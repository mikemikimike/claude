// @vitest-environment happy-dom
/**
 * Issue #427 — "There should probably be a way for the person to see what they
 * selected right before they send it. So if they did it all and they wanted to
 * change something, they can."
 *
 * Before this, the buyer wizard ran 0–22 and posted once at the end. There was
 * no summary, so the client submitted blind; and no route re-opened a submitted
 * questionnaire, so the answers were gone the moment they were sent.
 *
 * What is pinned here:
 *   1. the wizard shows a review of every answer BEFORE it submits,
 *   2. a cash buyer's review omits the loan-only questions `CASH_SKIP` skipped,
 *   3. clicking an answer jumps back to the screen that asked it, and
 *      answering returns to the review (not onward through the wizard),
 *   4. `?review=true` reopens the saved answers in edit mode and saves them
 *      back through POST /api/me/intake,
 *   5. edit mode does NOT run the first-submission side effects (no
 *      `markOnboardingComplete`, no invite claim).
 *
 * Plus a structural guard: the review's screen mapping (`BUYER_REVIEW_FIELDS`)
 * is asserted against the wizard's own `SCREENS` array, so a reordered question
 * breaks a test instead of silently pointing "Change" at the wrong screen.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import BuyerOnboarding, { SCREENS } from "@/components/pages/onboarding/BuyerOnboarding";
import { BUYER_REVIEW_FIELDS } from "@/lib/intake-review";
import { api } from "@/lib/api-client";

// Each case sets the URL before rendering — edit mode is `?review=true`.
let mockParams = new URLSearchParams();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => mockParams,
}));

const mockMarkComplete = vi.fn();

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeUser: { id: "u-1", name: "Bea Buyer", email: "bea@example.com" },
      markOnboardingComplete: mockMarkComplete,
    }),
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockGet = api.get as Mock;
const mockPost = api.post as Mock;
const mockPatch = api.patch as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockParams = new URLSearchParams();
  mockGet.mockResolvedValue([{ agent_name: "Agent Smith" }]);
  mockPost.mockResolvedValue({ ok: true });
  mockPatch.mockResolvedValue({ ok: true });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function click(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

/** The review's rows, as `LABEL → value` text. */
function reviewRows(): string[] {
  return Array.from(
    within(screen.getByTestId("intake-review")).getAllByRole("button")
  ).map((b) => b.textContent ?? "");
}

function reviewText(): string {
  return screen.getByTestId("intake-review").textContent ?? "";
}

/**
 * Walks the questionnaire to the review screen.
 *
 * Deliberately literal rather than clever: it clicks the same buttons a person
 * would, so a change to the screen sequence surfaces here as a failure instead
 * of being absorbed by a helper that reaches in and sets state.
 */
async function runWizard(opts: { cash: boolean }) {
  await act(async () => {
    render(<BuyerOnboarding />);
  });
  click(/let's get started/i);

  // Screen 0 — cash or loan.
  click(opts.cash ? /cash purchase/i : /getting a loan/i);

  // 1 first-time buyer, 2 bedrooms, 3 bathrooms
  click("Yes");
  click("3");
  click("2");
  // 4 areas (text)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hoover" } });
  click(/continue/i);
  // 5 property type, 6 garage, 7 pool
  click("Single Family");
  click("Either works");
  click("Nice to have");
  // 8 schools (text) — left blank on purpose: it must still get a review row.
  click(/continue/i);
  // 9 basement
  click("Not important");
  // 10 notes (textarea)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Big yard" } });
  click(/continue/i);

  if (!opts.cash) {
    // 11 military, 12 employment
    click("No");
    click("W-2 Employee");
  }
  // 13 journey stage — asked of cash buyers too.
  click("Actively searching now");
  if (!opts.cash) {
    // 14 credit, 15 income
    click("Good (720+)");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "8000" } });
    click(/continue/i);
  }
  // 16 budget sliders — defaults are fine.
  click(/continue/i);
  if (!opts.cash) {
    // 17 buying power, 18 pitch
    click(/see financing options/i);
    click(/i have my own lender/i);
  }
  // 19 first tracking address
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "1 Main St" } });
  click(/start home shopping/i);
  // 21 contact info (screen 20's Mountain CTA is skipped — own lender).
  const inputs = screen.getAllByRole("textbox");
  fireEvent.change(inputs[0], { target: { value: "Bea Buyer" } });
  fireEvent.change(screen.getByPlaceholderText("(205) 555-0100"), {
    target: { value: "2055550100" },
  });
  fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
    target: { value: "bea@example.com" },
  });
  click(/continue/i);
}

// ─── 1. The review exists, before the submit ─────────────────────────────────

describe("the buyer wizard reviews the answers before submitting (#427)", () => {
  it("shows every answer on a review screen, and has not posted yet", async () => {
    await runWizard({ cash: false });

    expect(screen.getByTestId("intake-review")).toBeTruthy();
    const text = reviewText();
    expect(text).toContain("Hoover");
    expect(text).toContain("Single Family");
    expect(text).toContain("Actively searching now");
    expect(text).toContain("$200K – $400K"); // the budget sliders' defaults
    expect(text).toContain("Using another lender");
    expect(text).toContain("1 Main St");

    // Nothing has been sent — the review is BEFORE the submit, which is the
    // whole point of the ticket.
    expect(mockPost).not.toHaveBeenCalledWith("/me/intake", expect.anything());
  });

  it("keeps a blank answer listed, so they can go back and fill it in", async () => {
    await runWizard({ cash: false });
    // `schools` was skipped during the walk-through above.
    const schools = reviewRows().find((r) => /school preference/i.test(r));
    expect(schools).toBeTruthy();
    expect(schools).toMatch(/not answered/i);
  });

  it("submits only once the client confirms the review", async () => {
    await runWizard({ cash: false });
    await act(async () => {
      click(/looks good/i);
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/me/intake",
      expect.objectContaining({
        role: "buyer",
        answers: expect.objectContaining({ areas: "Hoover", trackingAddress: "1 Main St" }),
      })
    );
    expect(screen.getByText(/you're all set/i)).toBeTruthy();
  });
});

// ─── 2. Cash buyers ──────────────────────────────────────────────────────────

describe("a cash buyer's review omits the questions CASH_SKIP skipped (#427)", () => {
  it("lists no credit / income / employment / military / lender rows", async () => {
    await runWizard({ cash: true });

    const text = reviewText();
    expect(text).toContain("Cash purchase");
    expect(text).not.toMatch(/credit score/i);
    expect(text).not.toMatch(/monthly income/i);
    expect(text).not.toMatch(/employment/i);
    expect(text).not.toMatch(/military/i);
    expect(text).not.toMatch(/lender/i);
  });

  it("still lists the questions a cash buyer WAS asked", async () => {
    await runWizard({ cash: true });
    const text = reviewText();
    expect(text).toMatch(/bedrooms/i);
    expect(text).toContain("Actively searching now"); // screen 13 is not skipped
    expect(text).toMatch(/budget/i);
  });
});

// ─── 3. Editing from the review ──────────────────────────────────────────────

describe("changing an answer from the review (#427)", () => {
  it("jumps back to the question, then returns to the review with the new answer", async () => {
    await runWizard({ cash: false });
    expect(reviewText()).toContain("3");

    click(/change bedrooms/i);
    // We are on the bedrooms question, not the review.
    expect(screen.queryByTestId("intake-review")).toBeNull();
    expect(screen.getByText(/how many bedrooms/i)).toBeTruthy();

    click("4+");
    // …and straight back to the review, rather than onward to bathrooms.
    const rows = reviewRows();
    expect(screen.getByTestId("intake-review")).toBeTruthy();
    expect(rows.find((r) => /bedrooms/i.test(r))).toContain("4+");
  });

  it("returns to the review when they back out of an edit instead of answering", async () => {
    await runWizard({ cash: false });
    click(/change property type/i);
    expect(screen.getByText(/what type of property/i)).toBeTruthy();

    // The layout's back arrow is the only other way off that screen.
    click(/back/i);
    expect(screen.getByTestId("intake-review")).toBeTruthy();
  });

  it("re-hides the loan-only rows when the buyer switches to cash from the review", async () => {
    await runWizard({ cash: false });
    expect(reviewText()).toMatch(/credit score/i);

    click(/change cash or loan/i);
    click(/cash purchase/i);

    const text = reviewText();
    expect(text).toContain("Cash purchase");
    expect(text).not.toMatch(/credit score/i);
  });

  it("opens a text question on the answer already given, not on a blank field", async () => {
    await runWizard({ cash: false });
    click(/change areas/i);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Hoover");
  });
});

// ─── 4 + 5. Edit mode from the portal ────────────────────────────────────────

describe("?review=true reopens a submitted questionnaire (#427)", () => {
  const SAVED = {
    deal_id: "11111111-1111-1111-1111-111111111111",
    intake: {
      role: "buyer",
      submitted_at: "2026-08-20T00:00:00.000Z",
      answers: {
        cashOrLoan: "loan",
        bedrooms: "3",
        areas: "Homewood",
        minBudget: 250_000,
        maxBudget: 425_000,
        lenderChoice: "mountain",
      },
    },
  };

  function enterEditMode() {
    mockParams = new URLSearchParams("review=true");
    mockGet.mockImplementation((path: string) =>
      path.startsWith("/me/intake")
        ? Promise.resolve(SAVED)
        : Promise.resolve([{ agent_name: "Agent Smith" }])
    );
  }

  it("opens straight on the review, loaded with the saved answers", async () => {
    enterEditMode();
    await act(async () => {
      render(<BuyerOnboarding />);
    });

    expect(mockGet).toHaveBeenCalledWith("/me/intake?role=buyer");
    const text = reviewText();
    expect(text).toContain("Homewood");
    expect(text).toContain("$250K – $425K");
    expect(text).toContain("Mountain Mortgage");
    // It is the preferences view, not a fresh onboarding run.
    expect(screen.getByText(/your preferences/i)).toBeTruthy();
    expect(screen.queryByText(/let's get started/i)).toBeNull();
  });

  it("saves the edited answers back to the same deal and returns to the portal", async () => {
    enterEditMode();
    await act(async () => {
      render(<BuyerOnboarding />);
    });

    click(/change bedrooms/i);
    click("4+");
    await act(async () => {
      click(/save changes/i);
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/me/intake",
      expect.objectContaining({
        role: "buyer",
        deal_id: SAVED.deal_id,
        answers: expect.objectContaining({ bedrooms: "4+", areas: "Homewood" }),
      })
    );
    expect(mockPush).toHaveBeenCalledWith("/buyer/u-1");
  });

  it("never runs the first-submission side effects", async () => {
    enterEditMode();
    await act(async () => {
      render(<BuyerOnboarding />);
    });
    await act(async () => {
      click(/save changes/i);
    });

    // #407's fix marks onboarding complete on the DONE screen. Edit mode must
    // never reach it: re-running that (and the invite claim beside it) is how a
    // finished client gets dragged back through onboarding.
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(screen.queryByText(/you're all set/i)).toBeNull();
    const claims = mockPost.mock.calls.filter(([p]) => String(p).includes("/claim"));
    expect(claims).toHaveLength(0);
  });

  it("keeps the client on the review, with a message, when the save fails", async () => {
    enterEditMode();
    mockPost.mockRejectedValue(new Error("network"));
    await act(async () => {
      render(<BuyerOnboarding />);
    });
    await act(async () => {
      click(/save changes/i);
    });

    expect(screen.getByRole("alert").textContent).toMatch(/couldn't save/i);
    expect(screen.getByTestId("intake-review")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("still renders the review when the saved answers cannot be loaded", async () => {
    mockParams = new URLSearchParams("review=true");
    mockGet.mockImplementation((path: string) =>
      path.startsWith("/me/intake")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve([{ agent_name: "Agent Smith" }])
    );
    await act(async () => {
      render(<BuyerOnboarding />);
    });

    expect(screen.getByRole("alert").textContent).toMatch(/couldn't load/i);
    expect(screen.getByTestId("intake-review")).toBeTruthy();
  });
});

// ─── Structural guard ────────────────────────────────────────────────────────

describe("the review's screen mapping matches the wizard's own sequence (#427)", () => {
  it("maps screens 1–15 to SCREENS[n - 1]", () => {
    for (const { key, screen: n } of BUYER_REVIEW_FIELDS) {
      if (n < 1 || n > 15) continue;
      expect(SCREENS[n - 1].field).toBe(key);
    }
  });

  it("covers every question screen — no answer is unreachable from the review", () => {
    const mapped = new Set(BUYER_REVIEW_FIELDS.map((f) => f.screen));
    for (let n = 1; n <= 15; n++) expect(mapped.has(n)).toBe(true);
  });
});
