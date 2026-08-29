// @vitest-environment happy-dom
/**
 * Issue #427, seller side — the seller questionnaire is the longer of the two
 * (30-odd screens with two conditional branches), so submitting it blind was
 * the worse of the two experiences.
 *
 * The buyer wizard's review is walked end-to-end in buyer-onboarding.test.tsx.
 * Here the review is exercised through the entry point that reaches it in one
 * step — the portal's `?review=true` — plus a structural assertion that it
 * really is the last thing before the questionnaire is sent, on every branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import SellerOnboarding, {
  getVisibleScreens,
} from "@/components/pages/onboarding/SellerOnboarding";
import { api } from "@/lib/api-client";

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
      activeUser: { id: "u-9", name: "Sam Seller", email: "sam@example.com" },
      markOnboardingComplete: mockMarkComplete,
    }),
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockGet = api.get as Mock;
const mockPost = api.post as Mock;
const mockPatch = api.patch as Mock;

const SAVED = {
  deal_id: "22222222-2222-2222-2222-222222222222",
  intake: {
    role: "seller",
    submitted_at: "2026-08-20T00:00:00.000Z",
    answers: {
      address: "123 Oak Lane, Birmingham, AL",
      whatMattersMost: "Top dollar",
      desiredListDate: "Next month",
      reasonsForSelling: ["Upsizing", "Relocating"],
      hasMortgage: "no",
      conditionRating: "Good but dated",
      alsoLookingToBuy: "no",
      contactName: "Sam Seller",
      contactPhone: "(205) 555-0100",
      contactEmail: "sam@example.com",
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockParams = new URLSearchParams("review=true");
  mockPost.mockResolvedValue({ ok: true });
  mockPatch.mockResolvedValue({ ok: true });
  mockGet.mockImplementation((path: string) =>
    path.startsWith("/me/intake")
      ? Promise.resolve(SAVED)
      : Promise.resolve([{ id: SAVED.deal_id, type: "sell", agent_name: "Agent Smith" }])
  );
});

function click(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

function reviewText(): string {
  return screen.getByTestId("intake-review").textContent ?? "";
}

async function open() {
  await act(async () => {
    render(<SellerOnboarding />);
  });
}

describe("?review=true reopens a seller's submitted questionnaire (#427)", () => {
  it("opens on the review, loaded with the saved answers", async () => {
    await open();

    expect(mockGet).toHaveBeenCalledWith("/me/intake?role=seller");
    const text = reviewText();
    expect(text).toContain("123 Oak Lane, Birmingham, AL");
    expect(text).toContain("Top dollar");
    expect(text).toContain("Upsizing, Relocating");
    expect(screen.getByText(/your preferences/i)).toBeTruthy();
  });

  it("omits the branches this seller never saw", async () => {
    await open();
    const text = reviewText();
    // No mortgage → no balance / rate / HELOC questions.
    expect(text).not.toMatch(/mortgage balance/i);
    expect(text).not.toMatch(/interest rate/i);
    // Not also buying → no buy-timing or lender questions.
    expect(text).not.toMatch(/buy timing/i);
    expect(text).not.toMatch(/lender/i);
  });

  it("jumps to a question and returns to the review with the new answer", async () => {
    await open();
    expect(reviewText()).toContain("Good but dated");

    click(/change condition/i);
    expect(screen.queryByTestId("intake-review")).toBeNull();

    click("Needs cosmetic work");
    expect(screen.getByTestId("intake-review")).toBeTruthy();
    expect(reviewText()).toContain("Needs cosmetic work");
  });

  it("opens a text question on the answer already given", async () => {
    await open();
    click(/change property address/i);
    expect(screen.getByRole("textbox")).toHaveProperty(
      "value",
      "123 Oak Lane, Birmingham, AL"
    );
  });

  it("saves the edits to the same deal and returns to the portal", async () => {
    await open();
    click(/change condition/i);
    click("Needs cosmetic work");
    await act(async () => {
      click(/save changes/i);
    });

    expect(mockPost).toHaveBeenCalledWith(
      "/me/intake",
      expect.objectContaining({
        role: "seller",
        deal_id: SAVED.deal_id,
        answers: expect.objectContaining({
          conditionRating: "Needs cosmetic work",
          address: "123 Oak Lane, Birmingham, AL",
        }),
      })
    );
    expect(mockPush).toHaveBeenCalledWith("/seller/u-9");
  });

  it("never runs the first-submission side effects", async () => {
    await open();
    await act(async () => {
      click(/save changes/i);
    });

    // #407: re-marking onboarding complete / re-claiming the invite is how a
    // finished client gets dragged back through onboarding.
    expect(mockMarkComplete).not.toHaveBeenCalled();
    expect(mockPost.mock.calls.filter(([p]) => String(p).includes("/claim"))).toHaveLength(0);
    expect(screen.queryByText(/you're all set/i)).toBeNull();
  });

  it("keeps the seller on the review, with a message, when the save fails", async () => {
    mockPost.mockRejectedValue(new Error("network"));
    await open();
    await act(async () => {
      click(/save changes/i);
    });

    expect(screen.getByRole("alert").textContent).toMatch(/couldn't save/i);
    expect(screen.getByTestId("intake-review")).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe("the review is the last step before the questionnaire is sent (#427)", () => {
  const EMPTYISH = {
    address: "",
    priceExpectation: "",
    whatMattersMost: "",
    desiredListDate: "",
    hardDeadline: "",
    timelineFlexibility: "",
    reasonsForSelling: [],
    stressfulOrUrgent: "",
    stressNotes: "",
    hasMortgage: "",
    mortgageBalance: "",
    mortgageRate: "",
    mortgageAssumable: "",
    hasHeloc: "",
    propertyTax: "",
    propertyType: "",
    occupancy: "",
    yearBuilt: "",
    conditionRating: "",
    knownIssues: [],
    majorUpgrades: "",
    upgradesList: "",
    hasHoa: "",
    hoaDues: "",
    preListingPrep: [],
    preListingSpend: "",
    biggerFear: "",
    openToIncentives: "",
    alsoLookingToBuy: "",
    buyTiming: "",
    needSaleProceeds: "",
    lenderChoice: "" as const,
    contactName: "",
    contactPhone: "",
    contactEmail: "",
  };

  it.each([
    ["the plain path", EMPTYISH],
    ["with a mortgage", { ...EMPTYISH, hasMortgage: "yes" }],
    ["also buying", { ...EMPTYISH, alsoLookingToBuy: "yes" }],
    ["both branches", { ...EMPTYISH, hasMortgage: "yes", alsoLookingToBuy: "yes" }],
  ])("sits immediately before the confirmation on %s", (_label, data) => {
    const ids = getVisibleScreens(data);
    expect(ids[ids.length - 2]).toBe("review");
    expect(ids[ids.length - 1]).toBe("confirmation");
  });
});
