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
import { render, screen, fireEvent, within } from "@testing-library/react";
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

// #423 — module-level spies so a case can assert that a click did (or, for the
// undo confirmation, did NOT yet) reach the hook. Referenced through wrapper
// arrows: the vi.mock factory runs during the import phase, before these
// initialisers, so naming them directly in the returned object would be a TDZ
// error.
const mockComplete = vi.fn();
const mockUncomplete = vi.fn();

vi.mock("@/hooks/useTaskCompletion", () => ({
  useTaskCompletion: () => ({
    completedIds: mockCompletedIds,
    error: null,
    clearError: vi.fn(),
    complete: (id: string) => mockComplete(id),
    uncomplete: (id: string) => mockUncomplete(id),
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

/**
 * #420 — a green check means the thing actually happened.
 *
 * Two of the three places that broke that rule live in this file's component:
 *
 *   1. The journey tracker checked off every stage the deal had walked past,
 *      purely on position. Advance a deal with its Property Search tasks still
 *      open and the buyer was told Property Search was done.
 *   2. The Fast Pass tracker derived `Complete` from the deal's stage index, so
 *      a post_close buyer was told the deep clean they PAID FOR had happened —
 *      on a guess, with nothing behind it.
 */
describe("BuyerView — honest completion indicators (#420)", () => {
  function buyerTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-search",
      dealId: DEAL_ID,
      title: "Tour three homes",
      assignedTo: "buyer",
      assignedToId: "u-buyer",
      status: "pending",
      priority: "medium",
      source: "ai",
      stageContext: "active_search",
      ...overrides,
    } as Task;
  }

  function atStage(stage: MyDeal["stage"], extra: Partial<MyDeal> = {}) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, stage, ...extra }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  describe("journey tracker", () => {
    it("does not mark a walked-past stage done while its tasks are still open", () => {
      atStage("offer_active");
      mockTasks = [buyerTask()]; // an open active_search task
      renderView(<BuyerView />);

      const row = screen.getByTestId("stage-row-active_search");
      expect(row.getAttribute("data-stage-state")).toBe("open");
      expect(row.textContent).toMatch(/1 task open/i);
      // …and no completed-state green on that row.
      expect(row.querySelectorAll('[class*="text-green"]')).toHaveLength(0);
    });

    it("pluralises and counts only the tasks that belong to that stage", () => {
      atStage("under_contract");
      mockTasks = [
        buyerTask({ id: "a" }),
        buyerTask({ id: "b" }),
        buyerTask({ id: "c", stageContext: "offer_active" }),
      ];
      renderView(<BuyerView />);

      expect(screen.getByTestId("stage-row-active_search").textContent).toMatch(/2 tasks open/i);
      expect(screen.getByTestId("stage-row-offer_active").textContent).toMatch(/1 task open/i);
    });

    it("still checks off a walked-past stage whose tasks are genuinely done", () => {
      atStage("offer_active");
      mockTasks = [buyerTask({ status: "completed" })];
      renderView(<BuyerView />);

      const row = screen.getByTestId("stage-row-active_search");
      expect(row.getAttribute("data-stage-state")).toBe("complete");
      expect(row.querySelectorAll('[class*="text-green"]').length).toBeGreaterThan(0);
    });

    it("honours the in-flight optimistic tick, so the rail settles the moment the buyer taps", () => {
      atStage("offer_active");
      mockTasks = [buyerTask()];
      mockCompletedIds = new Set(["task-search"]);
      renderView(<BuyerView />);

      expect(screen.getByTestId("stage-row-active_search").getAttribute("data-stage-state"))
        .toBe("complete");
    });

    it("ignores tasks that are not the buyer's own — the rail must be actionable by them", () => {
      atStage("offer_active");
      mockTasks = [buyerTask({ id: "agent-task", assignedTo: "agent" })];
      renderView(<BuyerView />);

      expect(screen.getByTestId("stage-row-active_search").getAttribute("data-stage-state"))
        .toBe("complete");
    });
  });

  describe("Fast Pass tracker", () => {
    const ACTIVE_FAST_PASS: NonNullable<MyDeal["fastPass"]> = {
      enrolledAt: "2026-08-01T00:00:00.000Z",
      status: "active",
      paymentOption: "now",
      selectedUpsells: ["deep_clean"],
      totalPaid: 1974,
      totalCents: 197400,
    };

    it("never reports a paid service Complete off the deal's stage alone", () => {
      atStage("post_close", { fastPass: ACTIVE_FAST_PASS });
      renderView(<BuyerView />);

      const services = screen.getAllByTestId("fp-service");
      expect(services.length).toBeGreaterThan(0);
      for (const svc of services) {
        expect(svc.getAttribute("data-status")).not.toBe("complete");
      }
      // The purchased add-on is still listed — it just isn't claimed as done.
      // Past its due stage with nothing behind it, it reads "Unconfirmed".
      const deepClean = services.find((s) => /deep clean/i.test(s.textContent ?? ""));
      expect(deepClean).toBeTruthy();
      expect(deepClean!.getAttribute("data-status")).toBe("unconfirmed");
      expect(deepClean!.textContent).not.toMatch(/complete/i);
      // …and no green on any row.
      expect(screen.getByTestId("fp-tracker").querySelectorAll('[class*="text-green-7"]'))
        .toHaveLength(0);
    });

    it("does not publish a fabricated 'N of N done' completion count", () => {
      atStage("post_close", { fastPass: ACTIVE_FAST_PASS });
      renderView(<BuyerView />);

      expect(screen.getByTestId("fp-tracker").textContent).not.toMatch(/\d+\/\d+\s*done/i);
    });

    it("says who confirms completion, so the buyer knows the list is a plan", () => {
      atStage("post_close", { fastPass: ACTIVE_FAST_PASS });
      renderView(<BuyerView />);

      expect(screen.getByTestId("fp-tracker").textContent)
        .toMatch(/concierge confirms each service/i);
    });

    it("still walks a service up from Pending as the deal progresses", () => {
      atStage("active_search", { fastPass: ACTIVE_FAST_PASS });
      renderView(<BuyerView />);

      const statuses = screen
        .getAllByTestId("fp-service")
        .map((s) => s.getAttribute("data-status"));
      expect(statuses).toContain("in_progress"); // "Dedicated concierge assigned"
      expect(statuses).toContain("pending");     // the post-close add-ons
    });
  });
});

/**
 * #422 — the buyer portal has to explain itself.
 *
 * A tester opening it cold said "I don't even know what I'm looking at". The
 * top of the portal must now answer three questions immediately: where am I,
 * what do I need to do, and what happens next / who makes it happen. These
 * cases pin the parts of that a later reorganisation could quietly undo.
 */
describe("BuyerView — portal orientation (#422)", () => {
  const ALL_STAGES: MyDeal["stage"][] = [
    "intake",
    "active_search",
    "offer_active",
    "under_contract",
    "pre_close",
    "closing",
    "post_close",
  ];

  function buyerTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-1",
      dealId: DEAL_ID,
      title: "Tour three homes",
      assignedTo: "buyer",
      assignedToId: "u-buyer",
      status: "pending",
      priority: "medium",
      source: "ai",
      stageContext: "active_search",
      ...overrides,
    } as Task;
  }

  function atStage(stage: MyDeal["stage"], extra: Partial<MyDeal> = {}) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, stage, ...extra }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  // Case 1 — fails against the old code: nothing anywhere said who advances the
  // deal, so the client was left guessing what triggers the next step.
  it.each(ALL_STAGES)("says the agent moves the buyer along, at stage %s", (stage) => {
    atStage(stage);
    renderView(<BuyerView />);

    const header = screen.getByTestId("portal-stage-header");
    expect(header.textContent).toMatch(/your agent will move you along this process/i);
    expect(header.textContent).toMatch(/notification when something needs you/i);
  });

  // The "where am I" half of the same card: the stage in the buyer's own
  // vocabulary, plus the plain-language description that already existed in
  // STAGE_DESCRIPTIONS but was only reachable inside the journey rail.
  it("names the current stage and explains it in plain language", () => {
    atStage("under_contract");
    renderView(<BuyerView />);

    const header = screen.getByTestId("portal-stage-header");
    expect(header.textContent).toMatch(/under contract/i);
    expect(header.textContent).toMatch(/working through the details/i);
  });

  // Case 2 — fails against the old code: the buyer's tasks sat in an unlabelled
  // tab among informational cards, with nothing marking them as theirs.
  it("renders the buyer's tasks inside a labelled actions region", () => {
    atStage("active_search");
    mockTasks = [buyerTask()];
    renderView(<BuyerView />);

    const actions = screen.getByTestId("portal-actions");
    expect(actions.textContent).toMatch(/what you need to do/i);
    expect(actions.contains(screen.getByText("Tour three homes"))).toBe(true);

    // …and the stage's informational cards are a separate region, not nested
    // inside the client's own.
    const stage = screen.getByTestId("portal-stage");
    expect(actions.contains(stage)).toBe(false);
    expect(stage.contains(actions)).toBe(false);
  });

  it("leads with the buyer's own work when they have some", () => {
    atStage("active_search");
    mockTasks = [buyerTask()];
    renderView(<BuyerView />);

    const actions = screen.getByTestId("portal-actions");
    const stage = screen.getByTestId("portal-stage");
    expect(
      actions.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leads with the stage card when nothing is waiting on the buyer", () => {
    // A brand-new deal: an empty to-do list must not be the first thing they
    // read, with the onboarding card pushed underneath it.
    atStage("intake");
    mockTasks = [];
    renderView(<BuyerView />);

    const actions = screen.getByTestId("portal-actions");
    const stage = screen.getByTestId("portal-stage");
    expect(
      stage.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Case 3 — the guard that makes the reorganisation safe. Every stage has to
  // render, with its own framing, on its own.
  it.each(ALL_STAGES)("renders the whole portal at stage %s", (stage) => {
    atStage(stage);
    renderView(<BuyerView />);

    expect(screen.getByTestId("portal-root")).toBeTruthy();
    expect(screen.getByTestId("portal-stage-header")).toBeTruthy();
    // The stage section is titled and blurbed for THIS stage — no empty frame.
    const section = screen.getByTestId("portal-stage");
    expect((section.textContent ?? "").trim().length).toBeGreaterThan(0);
    // The journey rail still marks exactly one current stage.
    expect(
      screen.getByTestId(`stage-row-${stage}`).getAttribute("data-stage-state"),
    ).toBe("current");
  });

  // Case 4 — the #407 fix must survive the reorganisation. This was the worst
  // bug in the app: a client who had already answered the questions was asked
  // to do the onboarding again, every single visit.
  it("never shows the onboarding CTA once the intake is submitted", () => {
    atStage("intake", { intakeSubmitted: true });
    renderView(<BuyerView />);

    expect(screen.queryByRole("button", { name: /begin my onboarding/i })).toBeNull();
    expect(screen.getByText(/onboarding complete/i)).toBeTruthy();
  });

  it("still shows the onboarding CTA to a buyer who has not submitted one", () => {
    atStage("intake", { intakeSubmitted: false });
    renderView(<BuyerView />);

    expect(screen.getByRole("button", { name: /begin my onboarding/i })).toBeTruthy();
  });

  /**
   * #427 — the client can now reopen their answers. The card that does it is
   * the mirror image of the #407 rule above and has to stay that way: it
   * appears only where the onboarding CTA is GONE, it is reference rather than
   * an action, and its copy never implies anything is outstanding.
   */
  it("offers an opt-in way back into the answers once an intake is on file", () => {
    atStage("active_search", { intakeSubmitted: true });
    renderView(<BuyerView />);

    const card = screen.getByTestId("client-preferences");
    expect(card.textContent).toMatch(/your preferences/i);
    expect(
      within(card).getByRole("button", { name: /review my answers/i })
    ).toBeTruthy();
  });

  it("shows NO preferences card to a buyer who has not submitted an intake", () => {
    // Otherwise this becomes a second onboarding prompt by another name (#407).
    atStage("intake", { intakeSubmitted: false });
    renderView(<BuyerView />);

    expect(screen.queryByTestId("client-preferences")).toBeNull();
  });

  it("keeps the preferences card in the reference rail, never in the actions region", () => {
    atStage("active_search", { intakeSubmitted: true });
    renderView(<BuyerView />);

    const card = screen.getByTestId("client-preferences");
    expect(screen.getByTestId("portal-secondary").contains(card)).toBe(true);
    expect(screen.getByTestId("portal-actions").contains(card)).toBe(false);
    // And it never reads as outstanding work.
    expect(card.textContent).not.toMatch(/begin|start|finish|complete your|needs?\s/i);
  });

  it("moves the journey rail and the agent card into the secondary column", () => {
    atStage("active_search");
    renderView(<BuyerView />);

    const secondary = screen.getByTestId("portal-secondary");
    expect(secondary.contains(screen.getByTestId("stage-row-active_search"))).toBe(true);
    expect(secondary.textContent).toMatch(/alice agent/i);
  });
});

/**
 * #423 — the buyer portal's task list has to explain itself.
 *
 * A tester on a `pre_close` deal: "I don't know what this is… do I need to be
 * doing these? Why can't I click them?" Three separate causes, all inside this
 * one list: nothing said which rows were the buyer's, nothing said which stage
 * a row belonged to, and — after #408 made completed rows re-openable — a
 * single stray tap on a completed card silently re-opened it, which re-blocks
 * the agent's forward advance.
 *
 * #422 owns where this region sits on the page; these cases are about what is
 * inside it.
 */
describe("BuyerView — task ownership, stage grouping and a symmetric undo (#423)", () => {
  function task(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-1",
      dealId: DEAL_ID,
      title: "Tour three homes",
      assignedTo: "buyer",
      assignedToId: "u-buyer",
      status: "pending",
      priority: "medium",
      source: "ai",
      stageContext: "active_search",
      ...overrides,
    } as Task;
  }

  function atStage(stage: MyDeal["stage"], extra: Partial<MyDeal> = {}) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [{ ...DEAL, stage, ...extra }],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  // ── Case 1: whose task is this? ────────────────────────────────────────────

  describe("ownership", () => {
    it("puts the buyer's own tasks under a heading that says they are theirs", () => {
      atStage("under_contract");
      mockTasks = [task({ title: "Wire your earnest money", stageContext: "under_contract" })];
      renderView(<BuyerView />);

      const yours = screen.getByTestId("portal-tasks-yours");
      expect(yours.textContent).toMatch(/your tasks/i);
      expect(yours.contains(screen.getByText("Wire your earnest money"))).toBe(true);
    });

    it("never renders someone else's task as a bare row in the buyer's own list", () => {
      atStage("under_contract");
      mockTasks = [
        task({ id: "mine", title: "Wire your earnest money", stageContext: "under_contract" }),
        task({
          id: "theirs",
          title: "Order the appraisal",
          assignedTo: "agent",
          stageContext: "under_contract",
        }),
      ];
      renderView(<BuyerView />);

      const yours = screen.getByTestId("portal-tasks-yours");
      expect(yours.textContent).not.toMatch(/order the appraisal/i);
    });

    it("explains what is being handled for them, with a name on every row", () => {
      atStage("under_contract");
      mockTasks = [
        task({
          id: "a",
          title: "Order the appraisal",
          assignedTo: "agent",
          stageContext: "under_contract",
        }),
        task({
          id: "b",
          title: "Chase the title commitment",
          assignedTo: "tc",
          stageContext: "under_contract",
        }),
      ];
      renderView(<BuyerView />);

      const handled = screen.getByTestId("portal-tasks-handled");
      expect(handled.textContent).toMatch(/order the appraisal/i);
      expect(handled.textContent).toMatch(/your agent/i);
      expect(handled.textContent).toMatch(/chase the title commitment/i);
      expect(handled.textContent).toMatch(/coordinator/i);
      // The whole point: it says out loud that none of it is the buyer's job.
      expect(handled.textContent).toMatch(/nothing here needs you/i);
    });

    it("gives the handled-for-you list no click targets at all", () => {
      atStage("under_contract");
      mockTasks = [
        task({
          id: "a",
          title: "Order the appraisal",
          assignedTo: "agent",
          stageContext: "under_contract",
        }),
      ];
      renderView(<BuyerView />);

      // Only the <summary> that opens the disclosure is interactive; the rows
      // themselves are not buttons, so nothing reads as a dead click target.
      const handled = screen.getByTestId("portal-tasks-handled");
      expect(handled.querySelectorAll("button")).toHaveLength(0);
      expect(handled.querySelector("summary")).toBeTruthy();
    });

    it("shows no handled-for-you region when everything on the deal is the buyer's", () => {
      atStage("under_contract");
      mockTasks = [task({ stageContext: "under_contract" })];
      renderView(<BuyerView />);

      expect(screen.queryByTestId("portal-tasks-handled")).toBeNull();
    });

    it("does not advertise other people's finished work", () => {
      atStage("under_contract");
      mockTasks = [
        task({ id: "mine", stageContext: "under_contract" }),
        task({
          id: "theirs",
          title: "Order the appraisal",
          assignedTo: "agent",
          status: "completed",
          stageContext: "under_contract",
        }),
      ];
      renderView(<BuyerView />);

      expect(screen.queryByTestId("portal-tasks-handled")).toBeNull();
    });

    // The rail's per-stage count is #420's visible proof. Work being done FOR
    // the buyer must never inflate a number they cannot move.
    it("keeps other people's tasks out of the journey rail's open counts (#420)", () => {
      atStage("offer_active");
      mockTasks = [task({ id: "theirs", assignedTo: "agent", stageContext: "active_search" })];
      renderView(<BuyerView />);

      expect(
        screen.getByTestId("stage-row-active_search").getAttribute("data-stage-state"),
      ).toBe("complete");
    });
  });

  // ── Case 2: when does this task belong to? ─────────────────────────────────

  describe("stage grouping", () => {
    it("groups open tasks by stage and leads with the stage the deal is in", () => {
      atStage("under_contract");
      mockTasks = [
        task({ id: "old", title: "Tour three homes", stageContext: "active_search" }),
        task({ id: "new", title: "Wire your earnest money", stageContext: "under_contract" }),
      ];
      renderView(<BuyerView />);

      const now = screen.getByTestId("task-group-under_contract");
      const earlier = screen.getByTestId("task-group-active_search");
      expect(
        now.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("frames a walked-past stage's leftovers as history, not as the job in hand", () => {
      atStage("under_contract");
      mockTasks = [task({ stageContext: "active_search" })];
      renderView(<BuyerView />);

      const earlier = screen.getByTestId("task-group-active_search");
      // The buyer's own stage vocabulary — "Home Search", not "active_search".
      expect(earlier.textContent).toMatch(/still open from home search/i);
    });

    it("names the current stage on its own group", () => {
      atStage("under_contract");
      mockTasks = [task({ stageContext: "under_contract" })];
      renderView(<BuyerView />);

      expect(screen.getByTestId("task-group-under_contract").textContent).toMatch(
        /right now — under contract/i,
      );
    });

    it("marks a later stage's task as not yet due", () => {
      atStage("under_contract");
      mockTasks = [task({ title: "Bring your ID to closing", stageContext: "closing" })];
      renderView(<BuyerView />);

      expect(screen.getByTestId("task-group-closing").textContent).toMatch(
        /coming up — closing day/i,
      );
    });

    it("shows completed tasks as a history, oldest stage first", () => {
      atStage("under_contract");
      mockTasks = [
        task({
          id: "b",
          title: "Wire your earnest money",
          status: "completed",
          stageContext: "under_contract",
        }),
        task({
          id: "a",
          title: "Sign the buyer agency agreement",
          status: "completed",
          stageContext: "intake",
        }),
      ];
      renderView(<BuyerView />);

      const done = screen.getByTestId("portal-tasks-done");
      expect(done.textContent).toMatch(/already done/i);
      const first = screen.getByTestId("task-history-intake");
      const second = screen.getByTestId("task-history-under_contract");
      expect(
        first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // …and completed work never sits in the "your tasks" list.
      expect(screen.queryByTestId("portal-tasks-yours")).toBeNull();
    });

    it("renders a task with no stage_context rather than dropping it", () => {
      atStage("pre_close");
      mockTasks = [task({ title: "Set up your utilities", stageContext: undefined as never })];
      renderView(<BuyerView />);

      expect(screen.getByText("Set up your utilities")).toBeTruthy();
    });

    it("keeps the empty state when the buyer genuinely has nothing open", () => {
      atStage("active_search");
      mockTasks = [];
      renderView(<BuyerView />);

      expect(screen.getByText(/all caught up/i)).toBeTruthy();
      expect(screen.queryByTestId("portal-tasks-yours")).toBeNull();
    });

    // The state the ticket is really aimed at: the buyer owes nothing, but the
    // deal is plainly busy. "All caught up" on its own reads as "nothing is
    // happening"; the disclosure is what makes it read as "nothing is waiting
    // on YOU".
    it("still explains the deal's other work when the buyer's own list is empty", () => {
      atStage("under_contract");
      mockTasks = [
        task({
          id: "theirs",
          title: "Order the appraisal",
          assignedTo: "agent",
          stageContext: "under_contract",
        }),
      ];
      renderView(<BuyerView />);

      expect(screen.getByText(/all caught up/i)).toBeTruthy();
      expect(screen.getByTestId("portal-tasks-handled").textContent).toMatch(
        /order the appraisal/i,
      );
    });
  });

  // ── Case 3: the undo asymmetry #408 left behind ────────────────────────────

  describe("undo is as deliberate as completing", () => {
    it("does not re-open a completed task on a single tap", () => {
      atStage("under_contract");
      mockTasks = [task({ status: "completed", stageContext: "under_contract" })];
      renderView(<BuyerView />);

      fireEvent.click(screen.getByText("Tour three homes"));

      // A stray tap on a phone must not silently re-block the agent's advance.
      expect(mockUncomplete).not.toHaveBeenCalled();
    });

    it("asks first, then re-opens — the same expand-and-confirm completing uses", () => {
      atStage("under_contract");
      mockTasks = [task({ status: "completed", stageContext: "under_contract" })];
      renderView(<BuyerView />);

      fireEvent.click(screen.getByText("Tour three homes"));
      const confirm = screen.getByRole("button", { name: /yes, re-?open/i });
      expect(confirm).toBeTruthy();
      fireEvent.click(confirm);

      expect(mockUncomplete).toHaveBeenCalledWith("task-1");
    });

    it("says what re-opening costs, so it is a decision and not a slip", () => {
      atStage("under_contract");
      mockTasks = [task({ status: "completed", stageContext: "under_contract" })];
      renderView(<BuyerView />);

      fireEvent.click(screen.getByText("Tour three homes"));
      expect(screen.getByText(/agent will see it as not done/i)).toBeTruthy();
    });

    it("backs out of the confirmation without touching the task", () => {
      atStage("under_contract");
      mockTasks = [task({ status: "completed", stageContext: "under_contract" })];
      renderView(<BuyerView />);

      fireEvent.click(screen.getByText("Tour three homes"));
      fireEvent.click(screen.getByRole("button", { name: /keep it done/i }));

      expect(mockUncomplete).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /yes, re-?open/i })).toBeNull();
    });

    // Case 4 from the ticket — the existing behaviour must not regress.
    it("still expands an open task to its confirm panel", () => {
      atStage("under_contract");
      mockTasks = [task({ stageContext: "under_contract" })];
      renderView(<BuyerView />);

      fireEvent.click(screen.getByText("Tour three homes"));
      fireEvent.click(screen.getByRole("button", { name: /yes, i.?m done/i }));

      expect(mockComplete).toHaveBeenCalledWith("task-1");
    });
  });
});

/**
 * #437 (FF14) — the buyer's "I've already applied" action on the FF12 card.
 *
 * The one thing these tests exist to pin: this button reaches the
 * participant-scoped pre-approval endpoint and NOT the flags route. Server-side
 * scoping is the real boundary (tests/api/deals.test.ts), but a client that
 * PATCHed `{ pre_approved: true }` would 404 for every buyer and look like a
 * broken button — and if the flags route were ever loosened, it would become a
 * self-serve offer unlock.
 */
describe("BuyerView — buyer marks the pre-approval applied (#437)", () => {
  function preApprovalTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-preapproval",
      dealId: DEAL_ID,
      title: "Get pre-approved with Mountain Mortgage",
      description: "Getting your pre-approval letter is the next step.",
      assignedTo: "buyer",
      assignedToId: "u-buyer",
      status: "pending",
      priority: "high",
      source: "preapproval",
      stageContext: "active_search",
      ...overrides,
    };
  }

  /** A financed buyer who is NOT pre-approved — the real target state. */
  function gatedBuyer(overrides: Partial<MyDeal> = {}) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [
        {
          ...DEAL,
          preApproved: false,
          financingType: "loan",
          flags: ["mountain_mortgage"],
          ...overrides,
        },
      ],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  }

  it("offers the action on the card", () => {
    gatedBuyer();
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);
    expect(screen.getByTestId("preapproval-mark-applied")).toBeTruthy();
  });

  it("POSTs the deal's pre-approval endpoint — never the flags route", async () => {
    gatedBuyer();
    mockTasks = [preApprovalTask()];
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderView(<BuyerView />);

    fireEvent.click(screen.getByTestId("preapproval-mark-applied"));
    await screen.findByTestId("preapproval-applied");

    expect(api.post).toHaveBeenCalledWith(`/deals/${DEAL_ID}/pre-approval`, {});
    // The gate's own write path is never touched from the buyer portal.
    expect(api.patch).not.toHaveBeenCalled();
    const posted = vi.mocked(api.post).mock.calls.map((c) => String(c[0]));
    expect(posted.some((p) => p.includes("/flags"))).toBe(false);
  });

  it("confirms without claiming the buyer is pre-approved", async () => {
    gatedBuyer();
    mockTasks = [preApprovalTask()];
    vi.mocked(api.post).mockResolvedValue({ ok: true });
    renderView(<BuyerView />);

    fireEvent.click(screen.getByTestId("preapproval-mark-applied"));
    const confirmation = await screen.findByTestId("preapproval-applied");
    expect(confirmation.textContent).not.toMatch(/pre-approved/i);
    // The offer gate copy is still on screen — nothing was unlocked.
    expect(screen.getByText(/get pre-approved to make an offer/i)).toBeTruthy();
  });

  it("surfaces a failure instead of faking success", async () => {
    gatedBuyer();
    mockTasks = [preApprovalTask()];
    vi.mocked(api.post).mockRejectedValue(new Error("boom"));
    renderView(<BuyerView />);

    fireEvent.click(screen.getByTestId("preapproval-mark-applied"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(screen.queryByTestId("preapproval-applied")).toBeNull();
  });

  it("shows the already-applied state from the deal payload, with no button", () => {
    gatedBuyer({ preApprovalAppliedAt: "2026-08-20T15:00:00Z" });
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    expect(screen.getByTestId("preapproval-applied")).toBeTruthy();
    expect(screen.queryByTestId("preapproval-mark-applied")).toBeNull();
  });

  it("an applied date does NOT unlock making an offer", () => {
    gatedBuyer({ preApprovalAppliedAt: "2026-08-20T15:00:00Z" });
    mockTasks = [preApprovalTask()];
    renderView(<BuyerView />);

    // `canOffer` is `preApproved || financingType === 'cash'` — and stays false.
    expect(screen.getByText(/get pre-approved to make an offer/i)).toBeTruthy();
  });
});
