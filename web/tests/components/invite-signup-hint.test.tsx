// @vitest-environment happy-dom
/**
 * The client-onboarding dead-end: "Accept & create account" called
 * loginWithRedirect() with no authorizationParams, so an invited client with no
 * account landed on Auth0's LOG-IN form and had to find "Create new account"
 * themselves. The agent-signup page always passed screen_hint; the client path
 * never did.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import InvitePage from "@/components/pages/invite/InvitePage";
import { stubLocalStorage } from "../helpers/local-storage";

const localStore = stubLocalStorage();

const invite = {
  token: "11111111-1111-4111-8111-111111111111",
  deal_id: "22222222-2222-4222-8222-222222222222",
  email: "client@example.com",
  name: "Invited Client",
  role: "buyer" as const,
  agent_name: "Agent Smith",
  deal_title: "123 Main St",
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  claimed: false,
};

const auth0State = {
  isAuthenticated: false,
  isLoading: false,
  user: undefined as { email?: string } | undefined,
  loginWithRedirect: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: invite.token }),
}));
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => auth0State,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: invite, isLoading: false, error: null }),
}));

afterEach(() => {
  cleanup();
  auth0State.isAuthenticated = false;
  auth0State.user = undefined;
  auth0State.loginWithRedirect.mockClear();
  localStore.reset();
});

describe("InvitePage — account creation", () => {
  it("offers both create-account and existing-account paths when signed out", () => {
    render(<InvitePage />);
    expect(screen.getByRole("button", { name: /create my account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /i already have an account/i })).toBeTruthy();
  });

  it("sends a new client to the Auth0 SIGN-UP screen with the email prefilled", () => {
    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    expect(auth0State.loginWithRedirect).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationParams: {
          screen_hint: "signup",
          login_hint: "client@example.com",
        },
      })
    );
  });

  it("sends a returning client to the log-in screen (no signup hint) with the email prefilled", () => {
    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /i already have an account/i }));

    const args = auth0State.loginWithRedirect.mock.calls[0][0];
    expect(args.authorizationParams).toEqual({ login_hint: "client@example.com" });
  });

  it("stashes the pending invite before leaving for Auth0 so AuthSetup can claim it", () => {
    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    expect(localStorage.getItem("pendingInvite")).toBe(invite.token);
    expect(localStorage.getItem("pendingInviteEmail")).toBe(invite.email);
  });

  it("shows a single accept button (no signup path) when already signed in", () => {
    auth0State.isAuthenticated = true;
    auth0State.user = { email: invite.email };

    render(<InvitePage />);
    expect(screen.getByRole("button", { name: /accept invitation/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /create my account/i })).toBeNull();
  });
});
