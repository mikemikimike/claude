// @vitest-environment happy-dom
/**
 * Issue #424 — the agent's "Messages" nav item had no unread indicator, so a
 * client could write in and nothing on screen changed. The only badge anywhere
 * was the NotificationBell (a different feature, counting `notifications` rows).
 *
 * The fix adds a GENERIC badge slot to the sidebar nav renderer — nav items
 * carry an optional `badgeKey`, and the shell supplies a `badges` map — so the
 * TC and admin shells can use it later without another special case. The agent
 * shell wires `unreadMessages` to `useUnreadMessageCount()`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared mocks (mirror the other component tests) ──────────────────────────

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/agent",
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} />
  ),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// The unread-count hook under test. Each case sets the value it wants.
const unreadCount = vi.fn(() => 0);
vi.mock("@/hooks/useMessages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMessages")>();
  return { ...actual, useUnreadMessageCount: () => unreadCount() };
});

vi.mock("@/lib/api-client", () => ({
  api: {
    get: vi.fn(() => new Promise(() => {})),
    post: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  setTokenGetter: vi.fn(),
}));

import { render, screen, within } from "@testing-library/react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuthStore } from "@/lib/store/authStore";

function signInAs(role: string) {
  useAuthStore.getState().setFromAuth0("u-1", "Test User", "user@example.com", role, true);
}

/** The Messages nav <a>, from the desktop sidebar (the drawer renders a copy). */
function messagesNavLinks() {
  return screen
    .getAllByRole("link")
    .filter((el) => el.getAttribute("href") === "/agent/messages");
}

beforeEach(() => {
  vi.clearAllMocks();
  unreadCount.mockReturnValue(0);
  useAuthStore.setState({ activeUser: undefined, isLoaded: false, syncError: null });
});

describe("AppLayout — agent nav unread Messages badge (#424)", () => {
  it("Case 1: renders an unread badge on the Messages nav item when the count is > 0", () => {
    unreadCount.mockReturnValue(3);
    signInAs("agent");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    const links = messagesNavLinks();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(within(link).getByText("3")).toBeInTheDocument();
    }
    // Announced, not just painted.
    expect(screen.getAllByLabelText(/3 unread messages/i).length).toBeGreaterThan(0);
  });

  it("Case 3: renders no badge when the unread count is zero", () => {
    unreadCount.mockReturnValue(0);
    signInAs("agent");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    const links = messagesNavLinks();
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(within(link).queryByTestId("nav-badge")).toBeNull();
      expect(link.textContent).toBe("Messages");
    }
    expect(screen.queryByLabelText(/unread messages/i)).toBeNull();
  });

  it("caps the displayed count at 99+ so the badge can't blow out the nav", () => {
    unreadCount.mockReturnValue(150);
    signInAs("agent");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    for (const link of messagesNavLinks()) {
      expect(within(link).getByText("99+")).toBeInTheDocument();
    }
    // The accessible label keeps the true number.
    expect(screen.getAllByLabelText(/150 unread messages/i).length).toBeGreaterThan(0);
  });

  it("badges only the item that declares a badgeKey — other nav items are untouched", () => {
    unreadCount.mockReturnValue(2);
    signInAs("agent");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    const dealsLinks = screen
      .getAllByRole("link")
      .filter((el) => el.getAttribute("href") === "/agent/deals");
    expect(dealsLinks.length).toBeGreaterThan(0);
    for (const link of dealsLinks) {
      expect(within(link).queryByTestId("nav-badge")).toBeNull();
    }
  });

  it("the badge is agent-shell only — the admin shell renders no message badge", () => {
    unreadCount.mockReturnValue(5);
    signInAs("admin");
    render(
      <AppLayout>
        <div>child</div>
      </AppLayout>,
    );

    expect(screen.queryByTestId("nav-badge")).toBeNull();
  });
});
