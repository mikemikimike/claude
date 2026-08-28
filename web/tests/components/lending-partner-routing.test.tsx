// @vitest-environment happy-dom
/**
 * Issue #307 — the `lending_partner` role is a real, assignable role but had no
 * dedicated UI: `authStore`'s ROLE_TO_GROUP mapped it to the `'agent'` group, so
 * `AppLayout` routed it straight into the full AgentLayout shell (Pipeline,
 * Deals, Vendors, Settings) with zero agent-owned data.
 *
 * The fix (option 1 — minimal honest placeholder):
 *   - ROLE_TO_GROUP['lending_partner'] === 'lending_partner' (its own group), and
 *   - AppLayout renders a dedicated placeholder layout for that group — NOT
 *     AgentLayout — that fires no agent-scoped API calls (no /deals, /vendors …).
 *   - An actual `agent` user is unaffected and still gets AgentLayout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared mocks (mirror the other component tests) ──────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

// AgentLayout's NotificationBell reads this; a lending_partner placeholder must not.
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// AgentLayout's Messages nav badge (#424) reads this; like useNotifications it
// is react-query backed, and this test renders without a QueryClientProvider.
vi.mock("@/hooks/useMessages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMessages")>();
  return { ...actual, useUnreadMessageCount: () => 0 };
});

// The only network seam any AppLayout child touches in this test. Case 2 asserts
// the lending_partner placeholder never reaches for it (no agent-scoped calls).
vi.mock("@/lib/api-client", () => ({
  api: {
    // VerifyEmailBanner (agent/admin/tc/client layouts) calls api.get on mount;
    // return a never-settling promise so its .then/.catch chain is valid.
    get: vi.fn(() => new Promise(() => {})),
    post: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  setTokenGetter: vi.fn(),
}));

import { render, screen } from "@testing-library/react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuthStore } from "@/lib/store/authStore";
import { api } from "@/lib/api-client";

function signInAs(role: string) {
  // Uses the REAL authStore so the ROLE_TO_GROUP mapping under test runs.
  useAuthStore.getState().setFromAuth0("u-1", "Test User", "user@example.com", role, true);
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ activeUser: undefined, isLoaded: false, syncError: null });
});

describe("AppLayout — lending_partner routing (#307)", () => {
  it("maps the lending_partner role to its own group, not 'agent'", () => {
    signInAs("lending_partner");
    expect(useAuthStore.getState().activeUser?.groupId).toBe("lending_partner");
  });

  it("Case 1: a lending_partner does NOT land in the agent shell", () => {
    signInAs("lending_partner");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    // The dedicated placeholder layout renders …
    expect(screen.getByTestId("lending-partner-layout")).toBeInTheDocument();
    // … and none of the AgentLayout chrome (Invite-client action + agent nav).
    expect(screen.queryByText(/Invite Client/i)).toBeNull();
    expect(screen.queryByText("Pipeline")).toBeNull();
    expect(screen.queryByText("Deals")).toBeNull();
  });

  it("Case 2: the placeholder fires no agent-scoped API calls on mount", () => {
    signInAs("lending_partner");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    // No /deals, /vendors, or any other agent data fetched — the honest
    // placeholder reaches for nothing.
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("Case 2b: the placeholder tells the user it's not available yet", () => {
    signInAs("lending_partner");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );
    expect(screen.getByText(/not available yet|not yet available|coming soon/i)).toBeInTheDocument();
  });

  it("Case 3: an actual agent is unaffected — still gets AgentLayout", () => {
    signInAs("agent");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    // AgentLayout chrome is present …
    expect(screen.getByText(/Invite Client/i)).toBeInTheDocument();
    expect(screen.getAllByText("Pipeline").length).toBeGreaterThan(0);
    // … and the lending-partner placeholder is not.
    expect(screen.queryByTestId("lending-partner-layout")).toBeNull();
  });
});
