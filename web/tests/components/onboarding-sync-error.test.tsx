// @vitest-environment happy-dom
/**
 * #425 sends a freshly-signed-up client to `/onboard/<role>` instead of `/`.
 * That skipped `RootRedirect`, which is the ONLY place the claim/sync failure
 * screens live (#397) — so a client whose invite claim AND `/users/sync` both
 * failed would have been handed an entire questionnaire whose writes silently
 * fail, instead of being told at the door what was wrong.
 *
 * The `email-conflict` screen in particular is not historical: it is the
 * actionable "log out and sign back in as the original account" instruction for
 * a permanent 409 that returns the same result on every refresh. Telling that
 * user nothing for twenty questions is strictly worse than the dead-end #397
 * fixed.
 *
 * `app/onboard/layout.tsx` is the gate: every onboarding route sits under it, so
 * buyer, seller and agent all surface the failure identically to `/`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const auth0State = {
  isLoading: false,
  isAuthenticated: true,
  error: undefined as Error | undefined,
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  user: undefined as { email?: string } | undefined,
};

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => auth0State,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  // Straight off the invite link: no ?token=, no ?agent=.
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/onboard/buyer",
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(async () => []), post: vi.fn(), patch: vi.fn() },
}));

import { render, screen, cleanup, act } from "@testing-library/react";
import OnboardLayout from "@/app/onboard/layout";
import BuyerOnboarding from "@/components/pages/onboarding/BuyerOnboarding";
import SellerOnboarding from "@/components/pages/onboarding/SellerOnboarding";
import { useAuthStore } from "@/lib/store/authStore";
import { stubLocalStorage } from "../helpers/local-storage";

const localStore = stubLocalStorage();

function text(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  useAuthStore.setState({ activeUser: undefined, isLoaded: false, syncError: null });
  auth0State.logout.mockClear();
  localStore.reset();
});
afterEach(() => cleanup());

describe("/onboard/* surfaces a claim/sync failure (#397 + #425)", () => {
  it("renders the email-conflict screen instead of the questionnaire", async () => {
    useAuthStore.setState({ syncError: "email-conflict", isLoaded: true });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <OnboardLayout>
          <BuyerOnboarding />
        </OnboardLayout>,
      ));
    });

    const body = text(container);
    expect(body).toContain("This email already has an account");
    // The actionable instruction, not "refresh the page" — that is the whole
    // point of #397: a 409 returns the same result on every retry.
    expect(body).toContain("Log out and sign back in");
    expect(body).not.toMatch(/refresh the page/i);

    // …and the client is NOT walked through a questionnaire that cannot save.
    expect(screen.queryByRole("button", { name: /let's get started/i })).toBeNull();

    // The escape hatch that makes the conflict screen actionable is present.
    expect(screen.getByRole("button", { name: /log out/i })).toBeTruthy();
  });

  it("renders the no-access screen for a client whose invite never got claimed", async () => {
    useAuthStore.setState({ syncError: "no-access", isLoaded: true });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <OnboardLayout>
          <BuyerOnboarding />
        </OnboardLayout>,
      ));
    });

    expect(text(container)).toContain("You're not set up yet");
    expect(screen.queryByRole("button", { name: /let's get started/i })).toBeNull();
  });

  it("gates the SELLER questionnaire the same way", async () => {
    useAuthStore.setState({ syncError: "email-conflict", isLoaded: true });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <OnboardLayout>
          <SellerOnboarding />
        </OnboardLayout>,
      ));
    });

    expect(text(container)).toContain("This email already has an account");
  });

  it("shows a transient failure's generic screen rather than the questionnaire", async () => {
    useAuthStore.setState({ syncError: "Error: fetch failed", isLoaded: true });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <OnboardLayout>
          <BuyerOnboarding />
        </OnboardLayout>,
      ));
    });

    // Here "refresh" IS the right advice — a network blip can succeed on retry.
    expect(text(container)).toMatch(/refresh the page/i);
    expect(screen.queryByRole("button", { name: /let's get started/i })).toBeNull();
  });

  it("renders the questionnaire normally when the sync succeeded", async () => {
    useAuthStore.setState({
      syncError: null,
      isLoaded: true,
      activeUser: {
        id: "u-1",
        name: "Bea Buyer",
        email: "bea@example.com",
        avatar: "",
        groupId: "buyer",
        role: "Buyer",
        onboardingComplete: false,
      },
    });

    await act(async () => {
      render(
        <OnboardLayout>
          <BuyerOnboarding />
        </OnboardLayout>,
      );
    });

    expect(screen.getByRole("button", { name: /let's get started/i })).toBeTruthy();
    expect(screen.queryByText(/already has an account/i)).toBeNull();
  });

  it("does not gate a signed-out visitor — no sync has been attempted yet", async () => {
    // e.g. a `?token=` onboarding link opened before login. `syncError` is only
    // ever set by a FAILED sync, so "no error" must never mean "blocked".
    useAuthStore.setState({ syncError: null, isLoaded: false, activeUser: undefined });

    await act(async () => {
      render(
        <OnboardLayout>
          <BuyerOnboarding />
        </OnboardLayout>,
      );
    });

    expect(screen.getByRole("button", { name: /let's get started/i })).toBeTruthy();
  });
});
