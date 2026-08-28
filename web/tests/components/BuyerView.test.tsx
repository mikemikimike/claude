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
import type { MLSErrorKind, MLSListing } from "@/hooks/useMLS";
import type { Task } from "@/lib/types";

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

// The deal's tasks + the in-flight optimistic completions. Both are read
// lazily inside the hook bodies, so a case can set them before rendering.
let mockTasks: Task[] = [];
let mockCompletedIds = new Set<string>();

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: mockTasks, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/hooks/useTaskCompletion", () => ({
  useTaskCompletion: () => ({
    completedIds: mockCompletedIds,
    error: null,
    clearError: vi.fn(),
    complete: vi.fn(),
    uncomplete: vi.fn(),
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

// The MLS search hook (#428). Read lazily inside the hook body so a case can
// set the outcome — clean, "agent has not connected", or a provider outage —
// before rendering.
let mockMLS: {
  listings: MLSListing[];
  loading: boolean;
  error: string | null;
  errorKind: MLSErrorKind;
} = { listings: [], loading: false, error: null, errorKind: "none" };
const mockMLSSearch = vi.fn();

vi.mock("@/hooks/useMLS", () => ({
  useMLSListings: () => ({ ...mockMLS, search: mockMLSSearch }),
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
import {
  MOUNTAIN_MORTGAGE_APPLICATION_URL,
  MOUNTAIN_MORTGAGE_PHONE_DISPLAY,
  MOUNTAIN_MORTGAGE_PHONE_HREF,
} from "@/lib/lender";
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
  mockTasks = [];
  mockCompletedIds = new Set<string>();
  mockMLS = { listings: [], loading: false, error: null, errorKind: "none" };
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

/**
 * #435 (FF12) — the buyer can act on the pre-approval task.
 *
 * #434/#460 create the task server-side for a Mountain Mortgage / Fast Pass
 * buyer when onboarding finishes, keyed on `source = 'preapproval'`. This is
 * the half the buyer sees: a card at the top of their portal offering the only
 * two things they can usefully do — open the 1003, or call the loan officer.
 *
 * The identity the card keys on is the SOURCE, never the title. #460 took the
 * title out of every structural position precisely so the copy could move; a
 * test that matched on "Get pre-approved with Mountain Mortgage" would put it
 * straight back.
 */
describe("BuyerView — pre-approval task card (#435)", () => {
  function preApprovalTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-preapproval",
      dealId: DEAL_ID,
      title: "Get pre-approved with Mountain Mortgage",
      description:
        "Getting your pre-approval letter is the next step — it tells you exactly what you can spend.",
      assignedTo: "buyer",
      assignedToId: "u-buyer",
      status: "pending",
      priority: "high",
      source: "preapproval",
      stageContext: "active_search",
      ...overrides,
    };
  }

  function otherTask(overrides: Partial<Task> = {}): Task {
    return {
      ...preApprovalTask(),
      id: "task-other",
      title: "Tour three homes",
      source: "ai",
      ...overrides,
    };
  }

  it("renders the card with both actions when the pre-approval task is open", () => {
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    expect(screen.getByTestId("preapproval-card")).toBeTruthy();
    expect(screen.getByRole("link", { name: /start my application/i })).toBeTruthy();
    expect(screen.getByRole("link", { name: /call paul/i })).toBeTruthy();
  });

  it("puts the card above the task list rather than inside it", () => {
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    const card = screen.getByTestId("preapproval-card");
    expect(screen.getByTestId("portal-primary").contains(card)).toBe(true);

    // The tab bar is the top of the general task list — the card must precede it.
    const tasksTab = screen.getByRole("button", { name: /^tasks/i });
    expect(
      card.compareDocumentPosition(tasksTab) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("links to the Mountain Mortgage application and opens it in a new tab safely", () => {
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    const apply = screen.getByRole("link", { name: /start my application/i });
    expect(apply.getAttribute("href")).toBe(MOUNTAIN_MORTGAGE_APPLICATION_URL);
    // The NMLS path segment is what attributes the application to Paul (#431).
    expect(apply.getAttribute("href")).toContain("/2233772/register");
    // …and no stale cache-buster has crept back in.
    expect(apply.getAttribute("href")).not.toContain("time=");
    expect(apply.getAttribute("target")).toBe("_blank");
    expect(apply.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("offers a tel: link to the loan officer", () => {
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    const call = screen.getByRole("link", { name: /call paul/i });
    expect(call.getAttribute("href")).toBe("tel:+12054019076");
    expect(call.getAttribute("href")).toBe(MOUNTAIN_MORTGAGE_PHONE_HREF);
    // The number is legible on screen, not only in the href.
    expect(call.textContent).toContain(MOUNTAIN_MORTGAGE_PHONE_DISPLAY);
  });

  it("does not render the card once the task is completed", () => {
    mockTasks = [preApprovalTask({ status: "completed" })];
    renderView(<BuyerView />);

    expect(screen.queryByTestId("preapproval-card")).toBeNull();
    expect(screen.queryByRole("link", { name: /start my application/i })).toBeNull();
  });

  it("does not render the card for a task the buyer only just optimistically ticked", () => {
    mockTasks = [preApprovalTask()];
    mockCompletedIds = new Set(["task-preapproval"]);
    renderView(<BuyerView />);

    expect(screen.queryByTestId("preapproval-card")).toBeNull();
  });

  it("supersedes the pre-approval banner's lender buttons instead of doubling them up", () => {
    // The real target user: Mountain Mortgage, not yet pre-approved, in Property
    // Search — so the #266 banner's own "Call Paul Leara" / "Apply Now" pair
    // would otherwise render the same two actions a screen further down.
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, preApproved: false, flags: ["mountain_mortgage"] }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    expect(screen.getAllByRole("link", { name: /call paul/i })).toHaveLength(1);
    expect(screen.queryAllByRole("link", { name: /apply now/i })).toHaveLength(0);
    // The banner itself (and its buyer-agency-agreement half) is untouched.
    expect(screen.getByText(/get pre-approved to make an offer/i)).toBeTruthy();
  });

  it("leaves the pre-approval banner's lender buttons alone when there is no task", () => {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, preApproved: false, flags: ["mountain_mortgage"] }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    mockTasks = [];
    renderView(<BuyerView />);

    expect(screen.queryByTestId("preapproval-card")).toBeNull();
    // Pre-#434 deals never got a task seeded — they keep the old CTAs.
    expect(screen.getAllByRole("link", { name: /apply now/i })).toHaveLength(1);
  });

  it("renders no card, and no error, for a buyer with no pre-approval task", () => {
    // A cash buyer never gets one seeded (#409/#434).
    mockTasks = [otherTask()];
    renderView(<BuyerView />);

    expect(screen.queryByTestId("preapproval-card")).toBeNull();
    expect(screen.queryByRole("link", { name: /start my application/i })).toBeNull();
    // The portal itself still renders.
    expect(screen.getByTestId("portal-root")).toBeTruthy();
    expect(screen.getByText("Tour three homes")).toBeTruthy();
  });
});

/**
 * #428 — "your agent hasn't connected their MLS" used to arrive only AFTER the
 * buyer filled in a search and pressed go. The portal now knows up front:
 * `/api/me/deals` carries `agent_mls_connected`, so the browser renders an
 * explained empty state instead of a form that cannot work.
 *
 * The distinction that must NOT collapse (guards closed #309): "never
 * connected" and "connected, but SimplyRETS is down right now" are different
 * states with different copy and different affordances. Reporting an outage as
 * "your agent hasn't connected" is exactly the class of bug #309 fixed.
 */
describe("BuyerView — MLS browser connection state (#428)", () => {
  function renderWith(deal: Partial<MyDeal>) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, ...deal } as MyDeal],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    return renderView(<BuyerView />);
  }

  /** Open the collapsed "Browse live MLS listings" section. */
  function openBrowser() {
    fireEvent.click(screen.getByRole("button", { name: /browse live mls listings/i }));
  }

  // Case 1 — fails against the old code, which rendered the form regardless.
  it("renders an explained empty state and NO search form when the agent has not connected MLS", () => {
    renderWith({ agentMlsConnected: false });
    openBrowser();

    expect(screen.getByTestId("mls-not-connected")).toBeTruthy();
    expect(screen.getByText(/hasn't connected their mls/i)).toBeTruthy();

    // The wall the buyer used to hit is gone: nothing to fill in, nothing to submit.
    expect(screen.queryByRole("button", { name: /search listings/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/^city$/i)).toBeNull();
    expect(screen.queryByPlaceholderText(/min price/i)).toBeNull();
    expect(mockMLSSearch).not.toHaveBeenCalled();
  });

  // Case 3 — no regression for the buyers whose agent IS connected.
  it("renders the live search form, and searches, when the agent has connected MLS", () => {
    renderWith({ agentMlsConnected: true });
    openBrowser();

    expect(screen.queryByTestId("mls-not-connected")).toBeNull();
    const searchBtn = screen.getByRole("button", { name: /search listings/i });
    expect(screen.getByPlaceholderText(/^city$/i)).toBeTruthy();

    fireEvent.click(searchBtn);
    expect(mockMLSSearch).toHaveBeenCalledTimes(1);
  });

  // Case 4 — the #309 regression guard. An outage is an outage.
  it("reads a provider outage as an outage, not as 'agent has not connected'", () => {
    mockMLS = {
      listings: [],
      loading: false,
      error: "502 — Bad Gateway — simplyrets: 503 Service Unavailable",
      errorKind: "unavailable",
    };
    renderWith({ agentMlsConnected: true });
    openBrowser();

    expect(screen.getByTestId("mls-unavailable")).toBeTruthy();
    expect(screen.getByText(/couldn't reach the mls/i)).toBeTruthy();
    // Never the not-connected copy, and never the not-connected empty state.
    expect(screen.queryByText(/hasn't connected their mls/i)).toBeNull();
    expect(screen.queryByTestId("mls-not-connected")).toBeNull();
    // The agent's credentials are fine — the buyer can retry.
    expect(screen.getByRole("button", { name: /search listings/i })).toBeTruthy();
  });

  // The narrow race the up-front flag can't cover: the agent disconnected
  // between page load and search. The post-search message still has to be right.
  it("still explains a mid-session disconnect when the search itself 503s", () => {
    mockMLS = {
      listings: [],
      loading: false,
      error: "503 — Service Unavailable — agent has not connected MLS",
      errorKind: "not_connected",
    };
    renderWith({ agentMlsConnected: true });
    openBrowser();

    expect(screen.getByText(/hasn't connected their mls/i)).toBeTruthy();
    expect(screen.queryByTestId("mls-unavailable")).toBeNull();
  });

  // A payload that doesn't carry the flag (an older cached response) must fail
  // OPEN — the form as it has always been — never into the empty state.
  it("falls back to the live form when the flag is absent", () => {
    renderWith({ agentMlsConnected: undefined });
    openBrowser();

    expect(screen.queryByTestId("mls-not-connected")).toBeNull();
    expect(screen.getByRole("button", { name: /search listings/i })).toBeTruthy();
  });
});
