// @vitest-environment happy-dom
/**
 * Until UserMenu there was no way to log out of RealTourFlow at all — not for
 * an admin, an agent, or a client — and agents saw no indication of which
 * account they were signed in as.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import UserMenu from "@/components/layout/UserMenu";
import { useAuthStore } from "@/lib/store/authStore";
import { stubLocalStorage } from "../helpers/local-storage";

const logout = vi.fn();
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({ logout }),
}));

const localStore = stubLocalStorage();

function signIn(role = "agent") {
  useAuthStore
    .getState()
    .setFromAuth0("user-1", "Paul Leara", "paul@example.com", role, true, "https://img.test/a.png");
}

beforeEach(() => {
  signIn();
});

afterEach(() => {
  cleanup();
  logout.mockClear();
  localStore.reset();
  useAuthStore.getState().reset();
});

const openMenu = () =>
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));

describe("UserMenu", () => {
  it("starts closed — no log out control until the menu is opened", () => {
    render(<UserMenu />);
    expect(screen.queryByRole("menuitem", { name: /log out/i })).toBeNull();
  });

  it("opens on click and shows who you are signed in as", () => {
    render(<UserMenu />);
    openMenu();
    expect(screen.getByText("paul@example.com")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /log out/i })).toBeTruthy();
  });

  it("closes on Escape", () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menuitem", { name: /log out/i })).toBeNull();
  });

  it("logs out through Auth0, returning to this origin", () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /log out/i }));

    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: window.location.origin },
    });
  });

  // A leftover pending-invite token would be claimed by whoever logs in next on
  // this machine, writing them with the invited role.
  it("clears every pending-invite key on the way out", () => {
    localStorage.setItem("pendingInvite", "tok");
    localStorage.setItem("pendingInviteEmail", "client@example.com");
    localStorage.setItem("pendingAgentInvite", "atok");
    localStorage.setItem("pendingAgentInviteEmail", "agent@example.com");

    render(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /log out/i }));

    expect(localStorage.getItem("pendingInvite")).toBeNull();
    expect(localStorage.getItem("pendingInviteEmail")).toBeNull();
    expect(localStorage.getItem("pendingAgentInvite")).toBeNull();
    expect(localStorage.getItem("pendingAgentInviteEmail")).toBeNull();
  });

  it("resets the identity store so the next account starts clean", () => {
    render(<UserMenu />);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /log out/i }));

    expect(useAuthStore.getState().activeUser).toBeUndefined();
    expect(useAuthStore.getState().isLoaded).toBe(false);
  });

  it("offers Settings for the dashboard roles but not for clients", () => {
    const { unmount } = render(<UserMenu />);
    openMenu();
    expect(screen.getByRole("menuitem", { name: /settings/i })).toBeTruthy();
    unmount();
    cleanup();

    signIn("buyer");
    render(<UserMenu />);
    openMenu();
    expect(screen.queryByRole("menuitem", { name: /settings/i })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /log out/i })).toBeTruthy();
  });

  it('renders light-on-navy in the "dark" variant used by the client header', () => {
    render(<UserMenu variant="dark" />);
    expect(screen.getByText("Paul Leara").className).toContain("text-white/70");
  });

  it("renders nothing before the identity store is populated", () => {
    useAuthStore.getState().reset();
    const { container } = render(<UserMenu />);
    expect(container.innerHTML).toBe("");
  });
});
