// @vitest-environment happy-dom
/**
 * Issue #278 — an expired, unclaimed client invite must land on a dedicated
 * "ask your agent to resend" state with NO Accept button, so a user is never
 * walked into creating an Auth0 account against a dead invite. The GET returns
 * 410 for expired-and-unclaimed; the page keys off ApiError.status === 410 to
 * distinguish it from a generic 404 "not found".
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import InvitePage from "@/components/pages/invite/InvitePage";
import { stubLocalStorage, stubSessionStorage } from "../helpers/local-storage";

const token = "11111111-1111-4111-8111-111111111111";

const localStore = stubLocalStorage();
const sessionStore = stubSessionStorage();

const queryState: { data: unknown; isLoading: boolean; error: unknown } = {
  data: undefined,
  isLoading: false,
  error: null,
};

const loginWithRedirect = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ token }),
}));
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({
    isAuthenticated: false,
    isLoading: false,
    user: undefined,
    loginWithRedirect,
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryState,
}));

beforeEach(() => {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.error = null;
  loginWithRedirect.mockClear();
  localStore.reset();
  sessionStore.reset();
});
afterEach(() => cleanup());

describe("InvitePage — expired invite (#278)", () => {
  it("renders the expired state and hides the Accept button on a 410", () => {
    queryState.error = new ApiError(410, "Gone", "invite expired");

    render(<InvitePage />);

    // Dedicated expired copy is shown.
    const expired = screen.getByTestId("invite-expired");
    expect(expired.textContent?.toLowerCase()).toContain("agent");
    // No path into account creation from a dead invite.
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
  });

  it("shows the generic not-found state (not the expired copy) on a 404", () => {
    queryState.error = new ApiError(404, "Not Found", "invite not found");

    render(<InvitePage />);

    expect(screen.queryByTestId("invite-expired")).toBeNull();
    expect(screen.getByRole("heading", { name: /invite not found/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /accept/i })).toBeNull();
  });

  // #425 added an automatic hop to the Auth0 signup form for a brand-new
  // invited email. That hop must never fire from a dead invite: walking a user
  // into creating an Auth0 account they can't then use IS the #278 bug.
  it("Case 3: does not auto-redirect to Auth0 signup on a 410", () => {
    queryState.error = new ApiError(410, "Gone", "invite expired");

    render(<InvitePage />);

    expect(loginWithRedirect).not.toHaveBeenCalled();
    expect(localStorage.getItem("pendingInvite")).toBeNull();
    expect(screen.getByTestId("invite-expired")).toBeTruthy();
  });

  it("does not auto-redirect to Auth0 signup on a 404 either", () => {
    queryState.error = new ApiError(404, "Not Found", "invite not found");

    render(<InvitePage />);

    expect(loginWithRedirect).not.toHaveBeenCalled();
    expect(localStorage.getItem("pendingInvite")).toBeNull();
  });
});
