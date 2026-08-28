// @vitest-environment happy-dom
/**
 * #425 — the invite link now lands a freshly-signed-up client on
 * `/onboard/buyer` (or `/onboard/seller`) directly, with NO `?agent=` and no
 * `?token=`. Both onboarding entry points therefore have to stand on their own:
 * resolve the agent's real name from the client's own deal, and never render a
 * raw agent UUID or crash on the missing param.
 *
 * SellerOnboarding's equivalent is already covered end-to-end by
 * seller-onboarding-smooth-exit.test.tsx (same empty-URLSearchParams entry);
 * this locks the buyer side down, which had no such test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, act } from "@testing-library/react";
import BuyerOnboarding from "@/components/pages/onboarding/BuyerOnboarding";
import { api } from "@/lib/api-client";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  // Straight off the invite: no token, no agent id.
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      activeUser: { id: "u-1", name: "Bea Buyer", email: "bea@example.com" },
      markOnboardingComplete: vi.fn(),
    }),
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockGet = api.get as Mock;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BuyerOnboarding entered without ?agent= (#425)", () => {
  it("renders the welcome screen and resolves the agent name from the client's deal", async () => {
    mockGet.mockImplementation((path: string) =>
      path === "/me/deals"
        ? Promise.resolve([{ agent_name: "Agent Smith" }])
        : Promise.reject(new Error(`unexpected GET ${path}`))
    );

    await act(async () => {
      render(<BuyerOnboarding />);
    });

    // It fell back to the participant deal rather than the (absent) ?agent= id.
    expect(mockGet).toHaveBeenCalledWith("/me/deals");
    expect(screen.getByText("Agent Smith")).toBeTruthy();
    expect(screen.getByRole("button", { name: /let's get started/i })).toBeTruthy();
  });

  it("still renders (with the generic agent label) when the deal lookup fails", async () => {
    mockGet.mockRejectedValue(new Error("boom"));

    await act(async () => {
      render(<BuyerOnboarding />);
    });

    expect(screen.getByText("Your Agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: /let's get started/i })).toBeTruthy();
  });
});
