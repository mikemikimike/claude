// @vitest-environment happy-dom
/**
 * The client-onboarding dead-end: "Accept & create account" called
 * loginWithRedirect() with no authorizationParams, so an invited client with no
 * account landed on Auth0's LOG-IN form and had to find "Create new account"
 * themselves. The agent-signup page always passed screen_hint; the client path
 * never did.
 *
 * #425 extends the same flow at both ends:
 *   - the post-login destination is the role's ONBOARDING route, not `/`
 *     (which resolved to the portal, whose only content was a card telling the
 *     client to go start the onboarding they had just been sent to do);
 *   - an unclaimed invite for an email with NO RealTourFlow account skips the
 *     chooser card entirely and goes straight to Auth0 signup — the card is
 *     kept only for the genuinely ambiguous cases (an email that already has an
 *     account, an already-claimed invite, an expired invite, or a visitor who
 *     is already signed in).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import InvitePage from "@/components/pages/invite/InvitePage";
import { stubLocalStorage, stubSessionStorage } from "../helpers/local-storage";

const localStore = stubLocalStorage();
const sessionStore = stubSessionStorage();

const BASE_INVITE = {
  token: "11111111-1111-4111-8111-111111111111",
  deal_id: "22222222-2222-4222-8222-222222222222",
  email: "client@example.com",
  name: "Invited Client",
  role: "buyer" as "buyer" | "seller",
  agent_name: "Agent Smith",
  deal_title: "123 Main St",
  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  claimed: false,
  // #425 — the GET now reports whether the invited email already has an
  // account. `true` here keeps the chooser card on screen, which is what the
  // button-level assertions below need; the auto-signup tests flip it to false.
  has_account: true as boolean | undefined,
};

let invite = { ...BASE_INVITE };

const auth0State = {
  isAuthenticated: false,
  isLoading: false,
  user: undefined as { email?: string } | undefined,
  loginWithRedirect: vi.fn(),
};

vi.mock("next/navigation", () => ({
  useParams: () => ({ token: BASE_INVITE.token }),
}));
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => auth0State,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: invite, isLoading: false, error: null }),
}));

afterEach(() => {
  cleanup();
  invite = { ...BASE_INVITE };
  auth0State.isAuthenticated = false;
  auth0State.user = undefined;
  auth0State.loginWithRedirect.mockClear();
  localStore.reset();
  sessionStore.reset();
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

// ─── #425 — land in onboarding, not on the portal ────────────────────────────

describe("InvitePage — post-signup destination (#425)", () => {
  it("Case 1: a buyer signing up returns to the BUYER onboarding route, not '/'", () => {
    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    const args = auth0State.loginWithRedirect.mock.calls[0][0];
    expect(args.appState).toEqual({ returnTo: "/onboard/buyer" });
  });

  it("Case 5: a seller signing up returns to the SELLER onboarding route", () => {
    invite.role = "seller";

    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    const args = auth0State.loginWithRedirect.mock.calls[0][0];
    expect(args.appState).toEqual({ returnTo: "/onboard/seller" });
  });

  it("leaves the RETURNING-client log-in path at '/' so RootRedirect decides", () => {
    // A client who already has an account may well be past onboarding (a second
    // deal). Forcing them into the questionnaire would be the mirror-image bug,
    // so only the signup path names an onboarding route.
    render(<InvitePage />);
    fireEvent.click(screen.getByRole("button", { name: /i already have an account/i }));

    const args = auth0State.loginWithRedirect.mock.calls[0][0];
    expect(args.appState).toEqual({ returnTo: "/" });
  });
});

describe("InvitePage — auto signup for a brand-new email (#425)", () => {
  it("Case 2: an unclaimed invite whose email has no account goes straight to Auth0 signup", () => {
    invite.has_account = false;

    render(<InvitePage />);

    // No second click needed — the redirect fires on its own…
    expect(auth0State.loginWithRedirect).toHaveBeenCalledTimes(1);
    expect(auth0State.loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: { screen_hint: "signup", login_hint: invite.email },
      appState: { returnTo: "/onboard/buyer" },
    });
    // …and the invite is still stashed first, so AuthSetup can claim it.
    expect(localStorage.getItem("pendingInvite")).toBe(invite.token);
    expect(localStorage.getItem("pendingInviteEmail")).toBe(invite.email);
    // The chooser card is not rendered behind the redirect.
    expect(screen.queryByRole("button", { name: /create my account/i })).toBeNull();
  });

  it("keeps the card when the invited email already HAS an account (ambiguous)", () => {
    invite.has_account = true;

    render(<InvitePage />);

    expect(auth0State.loginWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /create my account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /i already have an account/i })).toBeTruthy();
  });

  it("keeps the card when the server did not report has_account at all", () => {
    // Conservative default: never auto-redirect on a payload that predates the
    // field, or one a cache served from before the deploy.
    invite.has_account = undefined;

    render(<InvitePage />);

    expect(auth0State.loginWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /create my account/i })).toBeTruthy();
  });

  it("never auto-redirects a visitor who is already signed in", () => {
    invite.has_account = false;
    auth0State.isAuthenticated = true;
    auth0State.user = { email: invite.email };

    render(<InvitePage />);

    expect(auth0State.loginWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /accept invitation/i })).toBeTruthy();
  });

  it("Case 4: an already-claimed invite still shows 'Already accepted' with a Log in button", () => {
    invite.claimed = true;
    invite.has_account = false; // would auto-redirect if the claimed guard were dropped

    render(<InvitePage />);

    expect(auth0State.loginWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /already accepted/i })).toBeTruthy();

    const logIn = screen.getByRole("button", { name: /log in/i });
    fireEvent.click(logIn);
    expect(auth0State.loginWithRedirect).toHaveBeenCalledWith({
      authorizationParams: { login_hint: invite.email },
      appState: { returnTo: "/" },
    });
  });

  it("auto-redirects at most once per session, so backing out of Auth0 shows the card", () => {
    invite.has_account = false;

    const first = render(<InvitePage />);
    expect(auth0State.loginWithRedirect).toHaveBeenCalledTimes(1);
    first.unmount();

    // Same browser session, same token — e.g. the user hit Back on the Auth0
    // form. They must get the card (and its "I already have an account" escape
    // hatch) rather than being bounced straight back out.
    render(<InvitePage />);
    expect(auth0State.loginWithRedirect).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /create my account/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /i already have an account/i })).toBeTruthy();
  });
});
