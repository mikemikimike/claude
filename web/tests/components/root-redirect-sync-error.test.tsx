// @vitest-environment happy-dom
/**
 * Issue #397 — a 409 email conflict from /users/sync rendered the generic
 * "refresh the page" dead-end.
 *
 * `AuthSetup` used to collapse every non-403 sync failure to `String(err)`, so
 * `RootRedirect` had exactly two screens: the actionable "You're not set up yet"
 * for `no-access`, and the generic transient-outage screen for EVERYTHING else.
 * A 409 (a second Auth0 identity reusing an existing user's email) is permanent
 * and deterministic — telling that user to refresh is guaranteed wrong, and the
 * server's accurate "an account with this email already exists" was discarded.
 *
 * The fix keeps `syncError` a plain string but adds a second marker,
 * `'email-conflict'`, alongside `'no-access'`, and gives it its own screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Shared mocks (mirror the other component tests) ──────────────────────────

const auth0State = {
  isLoading: false,
  isAuthenticated: true,
  error: undefined as Error | undefined,
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
  getAccessTokenSilently: vi.fn(async () => "test-token"),
  user: undefined as { email?: string; name?: string; picture?: string } | undefined,
};

vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => auth0State,
}));

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

import { render, screen, cleanup, waitFor } from "@testing-library/react";
import RootRedirect from "@/components/RootRedirect";
import AuthSetup from "@/components/AuthSetup";
import { useAuthStore } from "@/lib/store/authStore";
// The REAL ApiError — AuthSetup branches on `err instanceof ApiError`, so the
// rejection has to be an instance of the very class the component imports.
import { api, ApiError } from "@/lib/api-client";
import { stubLocalStorage } from "../helpers/local-storage";

/** Text of the whole error screen, whitespace-normalised. */
function screenText(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  // Re-stubbed per test rather than once at module scope: afterEach's
  // restoreAllMocks/clearAllMocks run between tests, and AuthSetup reads the
  // bare `localStorage` identifier to decide whether a pending invite needs
  // claiming first. Each test gets its own empty store, so "no pending invite"
  // is a guarantee rather than leftover state.
  stubLocalStorage();
  auth0State.isLoading = false;
  auth0State.isAuthenticated = true;
  auth0State.error = undefined;
  auth0State.user = undefined;
  useAuthStore.setState({ activeUser: undefined, isLoaded: true, syncError: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("RootRedirect — /users/sync error screens (#397)", () => {
  it("Case 1: a 409 email conflict names the duplicate account and never says 'refresh'", () => {
    useAuthStore.setState({ isLoaded: true, syncError: "email-conflict" });

    const { container } = render(<RootRedirect />);
    const text = screenText(container);

    // The advice that cannot possibly work must be gone.
    expect(text).not.toMatch(/refresh/i);
    // …and the real reason must be on screen, so the user (and whoever they
    // send the screenshot to) can tell this apart from "the backend is down".
    expect(text).toMatch(/account/i);
    expect(text).toMatch(/already (has|exists)/i);
    expect(text).toMatch(/email/i);
    // The generic outage headline must NOT be what they see.
    expect(screen.queryByText(/We couldn't load your account/i)).toBeNull();
  });

  it("Case 2: 'no-access' still renders the invite-link screen — unchanged", () => {
    useAuthStore.setState({ isLoaded: true, syncError: "no-access" });

    const { container } = render(<RootRedirect />);

    expect(screen.getByText(/You're not set up yet/i)).toBeInTheDocument();
    expect(screenText(container)).toMatch(/invite link your agent sent you/i);
    expect(screenText(container)).not.toMatch(/refresh/i);
  });

  it("Case 3: a genuine transient failure still gets the generic refresh screen", () => {
    // What AuthSetup stores for a network blip / 5xx: a stringified error.
    useAuthStore.setState({
      isLoaded: true,
      syncError: "Error: 500 — Internal Server Error",
    });

    const { container } = render(<RootRedirect />);

    expect(screen.getByText(/We couldn't load your account/i)).toBeInTheDocument();
    expect(screenText(container)).toMatch(/Please refresh the page/i);
  });

  it("Case 4: every error branch keeps the 'Log out' escape hatch", () => {
    for (const syncError of ["email-conflict", "no-access", "TypeError: Failed to fetch"]) {
      useAuthStore.setState({ isLoaded: true, syncError });
      render(<RootRedirect />);
      expect(
        screen.getByRole("button", { name: /log out/i }),
        `missing Log out button for syncError=${syncError}`,
      ).toBeInTheDocument();
      cleanup();
    }
  });

  it("does not try to route anywhere while a sync error is showing", () => {
    useAuthStore.setState({ isLoaded: true, syncError: "email-conflict" });
    render(<RootRedirect />);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe("AuthSetup — classifying the /users/sync failure (#397)", () => {
  beforeEach(() => {
    auth0State.user = { email: "dup@example.com", name: "Chad Harris" };
    // Keep the component's console.error out of the test output.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function renderWithSync(rejection: unknown) {
    vi.spyOn(api, "post").mockRejectedValue(rejection);
    render(
      <AuthSetup>
        <div>child</div>
      </AuthSetup>,
    );
  }

  it("Case 5: a 409 stores the 'email-conflict' marker, not a stringified error", async () => {
    // Exactly what api-client throws for the route's plain-text 409 body.
    renderWithSync(
      new ApiError(409, "Conflict", null, "an account with this email already exists"),
    );

    await waitFor(() => {
      expect(useAuthStore.getState().syncError).toBe("email-conflict");
    });
  });

  it("a 403 still stores the 'no-access' marker", async () => {
    renderWithSync(
      new ApiError(403, "Forbidden", null, "no role assigned — request an invite"),
    );

    await waitFor(() => {
      expect(useAuthStore.getState().syncError).toBe("no-access");
    });
  });

  it("a transient failure still stores a plain diagnostic string", async () => {
    renderWithSync(new TypeError("Failed to fetch"));

    await waitFor(() => {
      const syncError = useAuthStore.getState().syncError;
      expect(syncError).toMatch(/Failed to fetch/);
      // Not one of the actionable markers — it must fall through to generic.
      expect(syncError).not.toBe("email-conflict");
      expect(syncError).not.toBe("no-access");
    });
  });

  it("a 500 is transient too — never mistaken for the email conflict", async () => {
    renderWithSync(new ApiError(500, "Internal Server Error", null, "boom"));

    await waitFor(() => {
      expect(useAuthStore.getState().syncError).not.toBe("email-conflict");
      expect(useAuthStore.getState().syncError).not.toBe("no-access");
    });
  });
});
