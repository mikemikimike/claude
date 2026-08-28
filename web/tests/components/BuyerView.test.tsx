// @vitest-environment happy-dom
/**
 * Issue #294 — the buyer portal hard-coded the Messages tab badge to
 * `msgCount={0}`, so a buyer never saw an unread-message count. Unread-for-a-deal
 * is derived client-side from the notifications the bell already loads:
 *   type === 'new_message' && dealId === deal.id && !read
 *
 * After the fix:
 *   - the Messages tab badge reflects the real unread count for THIS deal, and
 *   - opening the Messages tab marks exactly those notifications read
 *     (other deals / other types are untouched).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MyDeal } from "@/hooks/useMyDeals";
import type { AppNotification } from "@/hooks/useNotifications";

// ─── Shared mocks (mirror buyer-fastpass-price.test.tsx) ──────────────────────

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

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (selector: (s: { activeUser: null }) => unknown) =>
    selector({ activeUser: null }),
}));

vi.mock("@/hooks/useMyDeals", () => ({
  useMyDeals: vi.fn(),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: [], loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useTaskCompletion", () => ({
  useTaskCompletion: () => ({
    completedIds: new Set<string>(),
    error: null,
    clearError: vi.fn(),
    complete: vi.fn(),
  }),
}));

vi.mock("@/hooks/useMessages", () => ({
  useMessages: () => ({ messages: [], loading: false, error: null, refresh: vi.fn() }),
  postMessage: vi.fn(),
}));

vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({
    properties: [],
    loading: false,
    refresh: vi.fn(),
    addProperty: vi.fn().mockResolvedValue(undefined),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateBuyerNote: vi.fn().mockResolvedValue(undefined),
    updateAgentNote: vi.fn().mockResolvedValue(undefined),
    setOfferRequested: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/hooks/useMLS", () => ({
  useMLSListings: () => ({ listings: [], loading: false, error: null, search: vi.fn() }),
}));

vi.mock("@/hooks/useDocuments", () => ({
  useDocuments: () => ({ docs: [], loading: false, error: null }),
  getDownloadUrl: vi.fn(),
  getSigningUrl: vi.fn(),
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
}));

// The notifications source under test — each case controls what the bell returns
// and inspects the per-notification markRead spy.
let mockNotifications: AppNotification[] = [];
const mockMarkRead = vi.fn();
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: mockNotifications,
    markRead: mockMarkRead,
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("@/components/portal/PortalDealDocuments", () => ({
  default: () => null,
}));

vi.mock("@/components/ClientNotifications", () => ({
  default: () => null,
}));

vi.mock("@/components/MetroMap", () => ({
  default: () => null,
}));

vi.mock("@/components/VendorDirectory", () => ({
  default: () => null,
}));

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, statusText: string) { super(statusText); this.status = status; this.body = null; }
  },
  setTokenGetter: vi.fn(),
}));

import { useMyDeals } from "@/hooks/useMyDeals";
import { api } from "@/lib/api-client";
import BuyerView from "@/components/pages/buyer/BuyerView";

const DEAL_ID = "deal-1";

// A non-intake, non-post_close, non-fallen-through buyer deal — the state in
// which BuyerView renders the <TabBar /> with the Messages badge.
const DEAL: MyDeal = {
  id: DEAL_ID,
  type: "buy",
  clientName: "Betty Buyer",
  clientId: "u-buyer",
  agentId: "u-agent",
  stage: "active_search",
  health: "green",
  priority: "medium",
  property: { address: "123 Oak St", city: "Hoover", state: "AL", zip: "35226", price: 300000 },
  timeline: { createdAt: "2026-01-01T00:00:00Z", daysInStage: 3 },
  flags: [],
  status: "active",
  estimatedCommission: 0,
  preApproved: true,
  baaSigned: true,
  agentName: "Alice Agent",
  agentEmail: "agent@example.com",
  agentPhone: null,
};

function makeNotif(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: "notif-1",
    title: "New message from your agent",
    body: "Take a look when you get a chance.",
    type: "new_message",
    dealId: DEAL_ID,
    read: false,
    createdAt: "just now",
    ...overrides,
  };
}

function renderView(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNotifications = [];
  vi.mocked(useMyDeals).mockReturnValue({
    deals: [DEAL],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("BuyerView — Messages tab unread badge (#294)", () => {
  it("shows the real unread new_message count for this deal on the Messages tab", () => {
    mockNotifications = [makeNotif()]; // one unread new_message for this deal
    renderView(<BuyerView />);

    const messagesTab = screen.getByRole("button", { name: /messages/i });
    expect(messagesTab).toHaveTextContent("1");
  });

  it("does not badge the Messages tab when there are no unread messages for this deal", () => {
    mockNotifications = [
      makeNotif({ id: "read-msg", read: true }),                       // already read
      makeNotif({ id: "other-deal", dealId: "some-other-deal" }),      // different deal
      makeNotif({ id: "other-type", type: "task_assigned" }),          // not a message
    ];
    renderView(<BuyerView />);

    const messagesTab = screen.getByRole("button", { name: /messages/i });
    expect(messagesTab).not.toHaveTextContent("1");
  });

  it("marks only this deal's unread new_message notifications read when the Messages tab opens", () => {
    mockNotifications = [
      makeNotif({ id: "this-msg", type: "new_message", dealId: DEAL_ID, read: false }),
      makeNotif({ id: "other-deal-msg", type: "new_message", dealId: "other-deal", read: false }),
      makeNotif({ id: "other-type", type: "task_assigned", dealId: DEAL_ID, read: false }),
      makeNotif({ id: "already-read", type: "new_message", dealId: DEAL_ID, read: true }),
    ];
    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /messages/i }));

    expect(mockMarkRead).toHaveBeenCalledWith("this-msg");
    expect(mockMarkRead).not.toHaveBeenCalledWith("other-deal-msg");
    expect(mockMarkRead).not.toHaveBeenCalledWith("other-type");
    expect(mockMarkRead).not.toHaveBeenCalledWith("already-read");
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });
});

/**
 * #440 (FF17) — the buyer pays for Fast Pass from their dashboard.
 *
 * FF16 (#439) took payment out of the onboarding survey, so an enrollment now
 * lands `pending_payment` with nothing collected. This card is the only place
 * that debt gets settled, so three things are load-bearing:
 *
 *   1. The dollar figures come from the SERVER's `total_cents` on the deal, not
 *      from a sessionStorage handoff that can go stale.
 *   2. A `now` payment that comes back without a checkout URL is a FAILURE —
 *      never a success screen for an unpaid enrollment (#412).
 *   3. The action moves money, so a double-click must post exactly once.
 */
describe("BuyerView — Fast Pass payment card (#440)", () => {
  // base $1,787 + utility_setup $97 = $1,884. The +15% deferral premium on the
  // whole basket is round(188400 * 1.15) = 216660 → $2,166.60. Literal here so
  // a wrong multiplier or a double-applied premium is caught in the UI too.
  const ENROLLED_CENTS = 188400;
  const AT_CLOSING_DISPLAY = "$2,166.60";
  const NOW_DISPLAY = "$1,884";

  function dealWithFastPass(
    fastPass: NonNullable<MyDeal["fastPass"]>,
    overrides: Partial<MyDeal> = {}
  ): MyDeal {
    return { ...DEAL, fastPass, ...overrides };
  }

  const PENDING_FAST_PASS: NonNullable<MyDeal["fastPass"]> = {
    enrolledAt: "2026-08-01T00:00:00.000Z",
    status: "pending_payment",
    // A pending_payment enrollment genuinely has no option chosen yet — #449
    // widens this field to `FastPassPaymentOption | null` to say so. Written
    // through `unknown` so this file compiles on either side of that merge; the
    // card keys off `status`, never off this field.
    paymentOption: null as unknown as NonNullable<MyDeal["fastPass"]>["paymentOption"],
    selectedUpsells: ["utility_setup"],
    totalPaid: 1884,
    totalCents: ENROLLED_CENTS,
  };

  function useDeal(deal: MyDeal) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [deal],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  it("renders the payment card with all three options and the server's totals", () => {
    useDeal(dealWithFastPass(PENDING_FAST_PASS));
    renderView(<BuyerView />);

    expect(screen.getByText(/payment needed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /pay now/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /pay at closing/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /seller concession/i })).toBeTruthy();

    // The enrolled add-on is itemised, so the buyer sees what they are paying for.
    expect(screen.getByText(/utility setup concierge/i)).toBeTruthy();

    // Authoritative figures: the server's total, and the +15% only on at_closing.
    expect(screen.getAllByText(NOW_DISPLAY).length).toBeGreaterThan(0);
    expect(screen.getByText(AT_CLOSING_DISPLAY)).toBeTruthy();

    // …and the "enroll in Fast Pass" pitch must NOT also be on screen — they
    // already enrolled; they owe money.
    expect(screen.queryByText(/close on thursday/i)).toBeNull();
  });

  it("shows the payment card even at intake — that is where onboarding drops the buyer", () => {
    useDeal(dealWithFastPass(PENDING_FAST_PASS, { stage: "intake" }));
    renderView(<BuyerView />);
    expect(screen.getByText(/payment needed/i)).toBeTruthy();
  });

  it("a 'now' response with no checkout_url renders the error state, never a success state", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    useDeal(dealWithFastPass(PENDING_FAST_PASS));
    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /pay now/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    const err = await screen.findByRole("alert");
    expect(err.textContent).toMatch(/couldn't start your payment/i);
    // The card is still there, still payable — an unpaid enrollment never gets
    // a "you're all set" screen (#412).
    expect(screen.getByText(/payment needed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /continue to payment/i })).toBeTruthy();
    expect(screen.queryByText(/you're all set/i)).toBeNull();
  });

  it("a rejected payment request renders the same retryable error", async () => {
    vi.mocked(api.post).mockRejectedValue(new Error("502"));
    useDeal(dealWithFastPass(PENDING_FAST_PASS));
    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /pay now/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /couldn't start your payment/i
    );
    expect(screen.getByText(/payment needed/i)).toBeTruthy();
  });

  it("choosing 'pay at closing' posts that option to the payment route", async () => {
    vi.mocked(api.post).mockResolvedValue({ ok: true, status: "active" });
    useDeal(dealWithFastPass(PENDING_FAST_PASS));
    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /pay at closing/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(api.post).toHaveBeenCalledWith(`/deals/${DEAL_ID}/fastpass/pay`, {
      payment_option: "at_closing",
    });
  });

  it("a double-click posts exactly once — the action moves money", () => {
    // Never resolves: the guard has to hold while the first request is still
    // in flight, which is exactly the window a real double-click lands in.
    vi.mocked(api.post).mockReturnValue(new Promise(() => {}));
    useDeal(dealWithFastPass(PENDING_FAST_PASS));
    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /pay now/i }));
    const submit = screen.getByRole("button", { name: /continue to payment/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("renders no payment card for a paid / active enrollment", () => {
    useDeal(
      dealWithFastPass({
        ...PENDING_FAST_PASS,
        status: "active",
        paymentOption: "now",
      })
    );
    renderView(<BuyerView />);

    expect(screen.queryByText(/payment needed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /continue to payment/i })).toBeNull();
    // The service tracker takes over instead.
    expect(screen.getAllByText("Fast Pass").length).toBeGreaterThan(0);
  });

  it("renders no payment card when there is no enrollment at all", () => {
    useDeal({ ...DEAL, fastPass: undefined });
    renderView(<BuyerView />);
    expect(screen.queryByText(/payment needed/i)).toBeNull();
  });
});
