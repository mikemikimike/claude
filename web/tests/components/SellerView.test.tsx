// @vitest-environment happy-dom
/**
 * Regression test for #182 — sellers at 'Listed & Active' (offer_active) were
 * shown three hard-coded fake offers ('The Patterson Family $392,000',
 * 'Marcus & Diane Liu $387,500', 'Kevin Okafor $395,000 Cash — Best Offer')
 * via a mock <OfferComparison>, plus fabricated showing stats ('Showings: 7',
 * 'Online Views: 142') and a made-up feedback quote. The Accept/Counter/Decline
 * buttons had no onClick.
 *
 * The seller must only ever see real offers (from useOffers) or an honest
 * empty state, and no invented showing/view data.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MyDeal } from "@/hooks/useMyDeals";
import type { Offer } from "@/hooks/useOffers";
import type { AppNotification } from "@/hooks/useNotifications";
import type { Task } from "@/lib/types";

// ── Mocks ────────────────────────────────────────────────────────────────────
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ClientNotifications", () => ({ default: () => null }));
vi.mock("@/components/VendorDirectory", () => ({ default: () => null }));
vi.mock("@/components/portal/PortalDealDocuments", () => ({ default: () => null }));

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel: (s: { activeUser: { name: string } }) => unknown) =>
    sel({ activeUser: { name: "Sam Seller" } }),
}));
vi.mock("@/hooks/useMyDeals", () => ({
  useMyDeals: () => ({ deals: [makeDeal()], loading: false, error: null, refresh: vi.fn() }),
}));
// Per-test task list — reset in beforeEach. Empty for every case except the
// #408 un-complete block below, which needs a completed seller task on screen.
let mockTasks: Task[] = [];
const mockRefreshTasks = vi.fn();
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: mockTasks, loading: false, refresh: mockRefreshTasks }),
  patchTaskStatus: vi.fn(),
}));
vi.mock("@/hooks/useMessages", () => ({
  useMessages: () => ({ messages: [], loading: false, refresh: vi.fn() }),
  postMessage: vi.fn(),
}));
// Non-empty availability so the auto showing-availability modal stays closed.
vi.mock("@/hooks/useShowingAvailability", () => ({
  DAYS_OF_WEEK: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  useShowingAvailability: () => ({
    slots: [{ day: "Mon", from: "09:00", to: "18:00" }],
    loading: false,
    saveSlots: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/useNetSheet", () => ({
  useNetSheet: () => ({ sheet: null, loading: false, notReady: true, refresh: vi.fn() }),
  recalcLines: () => [],
  calcNetProceeds: () => 0,
}));

// The offers source under test — each case controls what the "server" returns.
let mockOffers: Offer[] = [];
vi.mock("@/hooks/useOffers", () => ({
  useOffers: () => ({
    offers: mockOffers,
    loading: false,
    refresh: vi.fn(),
    addOffer: vi.fn(),
    removeOffer: vi.fn(),
  }),
}));

// The notifications source (#294) — each case controls what the bell returns and
// inspects the per-notification markRead spy.
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

// The checklist cards (#261) read/write the persisted checklist API through the
// real useChecklist hook. We mock the api-client so a render triggers a real
// GET and a toggle issues a real PATCH we can assert on — no fabricated state.
const { apiGet, apiPatch } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    get: (path: string) => apiGet(path),
    patch: (path: string, body: unknown) => apiPatch(path, body),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    delete: vi.fn(() => Promise.resolve({})),
    getBlob: vi.fn(() => Promise.resolve(new Blob())),
  },
  setTokenGetter: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { postMessage } from "@/hooks/useMessages";
import SellerView from "@/components/pages/seller/SellerView";
import { patchTaskStatus } from "@/hooks/useTasks";

type ApiChecklistItem = {
  id: string;
  deal_id: string;
  label: string;
  category: string;
  checked: boolean;
  assigned_to: string;
  is_custom: boolean;
  sort_order: number;
};

function apiChecklistItem(
  overrides: Partial<ApiChecklistItem> & { id: string; label: string }
): ApiChecklistItem {
  return {
    deal_id: DEAL_ID,
    category: "Listing Prep",
    checked: false,
    assigned_to: "seller",
    is_custom: false,
    sort_order: 0,
    ...overrides,
  };
}

const DEAL_ID = "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01";

// Per-test deal shape — reset in beforeEach; the useMyDeals mock calls
// makeDeal() at render time so each test can reshape the deal.
let dealOverrides: Partial<MyDeal> = {};

function makeDeal(): MyDeal {
  return {
    ...baseDeal(),
    ...dealOverrides,
  } as MyDeal;
}

function baseDeal(): MyDeal {
  return {
    id: DEAL_ID,
    type: "sell",
    clientName: "Sam Seller",
    clientId: "",
    agentId: "agent-1",
    stage: "offer_active", // 'Listed & Active' — where the fake offers appeared
    health: "green",
    priority: "medium",
    property: { address: "742 Evergreen Ter", city: "Birmingham", state: "AL", zip: "35203", price: 390000 },
    timeline: { createdAt: "2026-05-01T00:00:00Z", daysInStage: 12 },
    flags: [],
    status: "active",
    estimatedCommission: 11700,
    openTaskCount: 0,
    overdueTaskCount: 0,
    agentName: "Sarah Johnson",
    agentEmail: "sarah@realtourflow.com",
    agentPhone: null,
  } as MyDeal;
}

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    dealId: DEAL_ID,
    buyerName: "Jordan Rivera",
    offerPrice: 401000,
    closeDate: "2026-08-14",
    contingencies: ["Inspection"],
    agentNotes: "Strong pre-approval, flexible on possession.",
    submittedAt: "2026-07-01T00:00:00Z",
    ...overrides,
  };
}

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

function renderSeller(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  sessionStorage.clear();
  mockOffers = [];
  mockTasks = [];
  mockRefreshTasks.mockReset();
  vi.mocked(patchTaskStatus).mockReset();
  vi.mocked(patchTaskStatus).mockResolvedValue(undefined as never);
  mockNotifications = [];
  mockMarkRead.mockClear();
  dealOverrides = {};
  vi.mocked(postMessage).mockReset();
  apiGet.mockReset();
  apiPatch.mockReset();
  apiGet.mockResolvedValue([]);
  apiPatch.mockResolvedValue({});
});

describe("SellerView at offer_active — offers are real, never fabricated (#182)", () => {
  it("shows NO offers and an honest empty state when the deal has zero real offers", () => {
    mockOffers = [];
    renderSeller(<SellerView />);

    // None of the hard-coded fake offers may render.
    expect(screen.queryByText(/Patterson/)).toBeNull();
    expect(screen.queryByText(/Marcus & Diane Liu/)).toBeNull();
    expect(screen.queryByText(/Kevin Okafor/)).toBeNull();
    expect(screen.queryByText(/392,000/)).toBeNull();
    expect(screen.queryByText(/387,500/)).toBeNull();
    expect(screen.queryByText(/395,000/)).toBeNull();
    expect(screen.queryByText(/Best Offer/)).toBeNull();
    expect(screen.queryByText(/3 offers/)).toBeNull();

    // No dead action buttons anywhere.
    expect(screen.queryByText("Accept")).toBeNull();
    expect(screen.queryByText("Counter")).toBeNull();
    expect(screen.queryByText("Decline")).toBeNull();

    // Honest empty state instead.
    expect(screen.getByText(/No offers yet/i)).toBeTruthy();
  });

  it("renders the real offers from useOffers when they exist", () => {
    mockOffers = [
      makeOffer(),
      makeOffer({
        id: "66666666-7777-4888-9999-aaaaaaaaaaaa",
        buyerName: "Priya Natarajan",
        offerPrice: 385000,
        contingencies: [],
        agentNotes: "",
      }),
    ];
    renderSeller(<SellerView />);

    expect(screen.getByText(/Jordan Rivera/)).toBeTruthy();
    expect(screen.getByText(/\$401,000/)).toBeTruthy();
    expect(screen.getByText(/Priya Natarajan/)).toBeTruthy();
    expect(screen.getByText(/\$385,000/)).toBeTruthy();
    expect(screen.getByText(/Offers Received \(2\)/i)).toBeTruthy();

    // Still no fake offers mixed in, and no inert Accept/Counter/Decline buttons.
    expect(screen.queryByText(/Patterson/)).toBeNull();
    expect(screen.queryByText("Accept")).toBeNull();
    expect(screen.queryByText("Counter")).toBeNull();
    expect(screen.queryByText("Decline")).toBeNull();
  });

  it("shows no fabricated showing/view stats or feedback — only the real days-listed count", () => {
    renderSeller(<SellerView />);

    // The invented numbers and quote must be gone.
    expect(screen.queryByText("Showings")).toBeNull();
    expect(screen.queryByText("7")).toBeNull();
    expect(screen.queryByText("Online Views")).toBeNull();
    expect(screen.queryByText("142")).toBeNull();
    expect(screen.queryByText(/Great layout, loved the kitchen/)).toBeNull();
    expect(screen.queryByText(/Latest showing feedback/i)).toBeNull();

    // The real stat (derived from deal.timeline.daysInStage) stays.
    expect(screen.getByText("Days Listed")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });
});

// ─── Buyer's Progress reaches the seller (#184) ──────────────────────────────
// The status used to live only in the AGENT'S in-browser zustand store, so the
// seller (a different browser/session) always saw the empty state. The card
// must read the persisted value delivered on the deal payload (/api/me/deals).

describe("SellerView at under_contract — Buyer's Progress from the deal payload (#184)", () => {
  it("shows the agent-set status delivered by the API, with the current step marked", () => {
    dealOverrides = { stage: "under_contract", buyerStatus: "Appraisal ordered" };
    renderSeller(<SellerView />);

    // The full checklist renders with the persisted step marked Current.
    expect(screen.getByText("Appraisal ordered")).toBeTruthy();
    expect(screen.getByText("Current")).toBeTruthy();
    expect(screen.getByText("Inspection scheduled")).toBeTruthy();
    expect(screen.getByText("Clear to close")).toBeTruthy();

    // The empty state must NOT show once a status is set.
    expect(screen.queryByText(/your agent will update the buyer/i)).toBeNull();
  });

  it("shows the honest empty state when no status has been set", () => {
    dealOverrides = { stage: "under_contract" };
    renderSeller(<SellerView />);

    expect(screen.getByText(/your agent will update the buyer/i)).toBeTruthy();
    expect(screen.queryByText("Current")).toBeNull();
  });
});

// ─── Messages tab unread badge (#294) ────────────────────────────────────────
// The Messages tab badge was hard-coded to msgCount={0}, so a seller never saw
// an unread-message count. Unread-for-a-deal is derived from the notifications
// the bell already loads: type === 'new_message' && dealId === deal.id && !read.
// Opening the Messages tab marks exactly those notifications read.

describe("SellerView — Messages tab unread badge (#294)", () => {
  it("shows the real unread new_message count for this deal on the Messages tab", () => {
    mockNotifications = [makeNotif()]; // one unread new_message for this deal
    renderSeller(<SellerView />);

    const messagesTab = screen.getByRole("button", { name: /messages/i });
    expect(messagesTab).toHaveTextContent("1");
  });

  it("does not badge the Messages tab when there are no unread messages for this deal", () => {
    mockNotifications = [
      makeNotif({ id: "read-msg", read: true }),                  // already read
      makeNotif({ id: "other-deal", dealId: "some-other-deal" }), // different deal
      makeNotif({ id: "other-type", type: "task_assigned" }),     // not a message
    ];
    renderSeller(<SellerView />);

    const messagesTab = screen.getByRole("button", { name: /messages/i });
    expect(messagesTab).not.toHaveTextContent("1");
  });

  it("marks only this deal's unread new_message notifications read when the Messages tab opens", () => {
    mockNotifications = [
      makeNotif({ id: "this-msg", type: "new_message", dealId: DEAL_ID, read: false }),
      makeNotif({ id: "other-deal-msg", type: "new_message", dealId: "some-other-deal", read: false }),
      makeNotif({ id: "other-type", type: "task_assigned", dealId: DEAL_ID, read: false }),
      makeNotif({ id: "already-read", type: "new_message", dealId: DEAL_ID, read: true }),
    ];
    renderSeller(<SellerView />);

    fireEvent.click(screen.getByRole("button", { name: /messages/i }));

    expect(mockMarkRead).toHaveBeenCalledWith("this-msg");
    expect(mockMarkRead).not.toHaveBeenCalledWith("other-deal-msg");
    expect(mockMarkRead).not.toHaveBeenCalledWith("other-type");
    expect(mockMarkRead).not.toHaveBeenCalledWith("already-read");
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
  });
});

// ─── Seller portal papercuts (#262) ──────────────────────────────────────────
// Three small dead-or-wrong UI behaviors in SellerView:
//   1. an offer's close date rendered as a raw ISO string ("2026-08-15T00:00…Z");
//   2. the referral-modal "Copy" button had no onClick (nothing was copied);
//   3. MessagesTab swallowed send failures ({ ...catch {} }) — no user feedback.

describe("SellerView — offer close date is a friendly, timezone-safe date (#262)", () => {
  it("renders 'Aug 15, 2026' for a UTC-midnight ISO close date, never the raw ISO, even in a negative-offset timezone", () => {
    const originalTZ = process.env.TZ;
    // US Pacific (UTC-8/-7). A naive `new Date(iso)` would render the day BEFORE
    // (Aug 14) here — the whole point of formatting the date part directly.
    process.env.TZ = "America/Los_Angeles";
    try {
      mockOffers = [makeOffer({ closeDate: "2026-08-15T00:00:00.000Z" })];
      renderSeller(<SellerView />);

      expect(screen.getByText(/Aug 15, 2026/)).toBeTruthy();
      // Never the raw ISO, and never shifted a day back to the 14th.
      expect(screen.queryByText(/2026-08-15T/)).toBeNull();
      expect(screen.queryByText(/Aug 14, 2026/)).toBeNull();
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it("also formats a plain date-only close date ('2026-08-14') without shifting the day", () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      mockOffers = [makeOffer({ closeDate: "2026-08-14" })];
      renderSeller(<SellerView />);

      expect(screen.getByText(/Aug 14, 2026/)).toBeTruthy();
      expect(screen.queryByText(/Aug 13, 2026/)).toBeNull();
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});

describe("SellerView — referral 'Copy' button actually copies (#262)", () => {
  it("copies the referral URL to the clipboard and shows 'Copied' feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    dealOverrides = { stage: "post_close" };
    renderSeller(<SellerView />);

    // Open the referral modal, then click Copy.
    fireEvent.click(screen.getByRole("button", { name: /refer a friend/i }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(writeText).toHaveBeenCalledWith("realtourflow.com/refer");
    // Feedback: the button flips to a "Copied" state.
    expect(await screen.findByRole("button", { name: /copied/i })).toBeTruthy();
  });
});

describe("SellerView — message send failures are surfaced, draft preserved (#262)", () => {
  it("shows a role='alert' error and keeps the draft when postMessage rejects", async () => {
    vi.mocked(postMessage).mockRejectedValueOnce(new Error("network down"));
    renderSeller(<SellerView />);

    // Open the Messages tab, type a draft, and send via Enter.
    fireEvent.click(screen.getByRole("button", { name: /messages/i }));
    const input = screen.getByPlaceholderText(/message your agent/i);
    fireEvent.change(input, { target: { value: "Please call me back" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The failure is surfaced to the seller…
    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/fail|again|try/i);
    // …and the draft is not lost, so they can retry.
    expect(screen.getByPlaceholderText(/message your agent/i)).toHaveValue("Please call me back");
  });
});

// ─── Listing-prep checklist is persisted, never fabricated (#261) ────────────
// ListingPrepCard used to keep checked state in useState(new Set([0, 1])) — it
// pre-checked "Deep clean / declutter" and "Minor repairs completed" on every
// load with no server data, toggles vanished on reload, and the agent never saw
// progress. It now reads/writes the persisted checklist API (seller items).

const LISTING_PREP_LABELS = [
  "Deep clean / declutter",
  "Minor repairs completed",
  "Professional photos scheduled",
  "Listing copy approved",
  "Disclosures package complete",
  "Lockbox installed",
];

function sellerPrepItems(): ApiChecklistItem[] {
  return LISTING_PREP_LABELS.map((label, i) =>
    apiChecklistItem({ id: `prep-${i}`, label, sort_order: i })
  );
}

describe("SellerView at active_search — listing-prep checklist is real, never fabricated (#261)", () => {
  it("pre-checks nothing: it fetches the checklist and reflects only server state (all unchecked)", async () => {
    dealOverrides = { stage: "active_search" };
    apiGet.mockResolvedValue(sellerPrepItems());
    renderSeller(<SellerView />);

    // The card fetches the persisted checklist for this deal.
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(`/deals/${DEAL_ID}/checklist`)
    );
    await screen.findByText("Deep clean / declutter");

    // No fabricated pre-checks: progress is 0/6, never the old fake 2/6.
    expect(screen.getByText(/0\s*\/\s*6/)).toBeTruthy();
    expect(screen.queryByText(/2\s*\/\s*6/)).toBeNull();

    // The two formerly hard-checked rows render unchecked (no strikethrough).
    expect(screen.getByText("Deep clean / declutter").className).not.toMatch(/line-through/);
    expect(screen.getByText("Minor repairs completed").className).not.toMatch(/line-through/);
  });

  it("reflects server-confirmed checked state for items the API returns as checked", async () => {
    dealOverrides = { stage: "active_search" };
    const items = sellerPrepItems();
    items[0].checked = true; // "Deep clean / declutter" already done server-side
    apiGet.mockResolvedValue(items);
    renderSeller(<SellerView />);

    await screen.findByText("Deep clean / declutter");
    // Checked item is struck through; progress counts it.
    expect(screen.getByText("Deep clean / declutter").className).toMatch(/line-through/);
    expect(screen.getByText(/1\s*\/\s*6/)).toBeTruthy();
  });

  it("toggling a listing-prep item issues the checklist PATCH and reflects the new state", async () => {
    dealOverrides = { stage: "active_search" };
    apiGet.mockResolvedValue(sellerPrepItems());
    renderSeller(<SellerView />);

    const row = await screen.findByText("Professional photos scheduled");
    fireEvent.click(row);

    // PATCH the specific item's checked flag.
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        `/deals/${DEAL_ID}/checklist/prep-2`,
        { checked: true }
      )
    );
    // Optimistic + confirmed: the row now renders checked.
    await waitFor(() =>
      expect(screen.getByText("Professional photos scheduled").className).toMatch(/line-through/)
    );
  });
});

describe("SellerView at pre_close — pre-close checklist is real, not static decoration (#261)", () => {
  it("renders the seller pre-close items from the API and toggling issues a PATCH", async () => {
    dealOverrides = { stage: "pre_close" };
    apiGet.mockResolvedValue([
      apiChecklistItem({ id: "pc-0", label: "Complete agreed repairs", category: "Pre-Close" }),
      apiChecklistItem({ id: "pc-1", label: "Confirm possession date", category: "Pre-Close", sort_order: 1 }),
    ]);
    renderSeller(<SellerView />);

    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(`/deals/${DEAL_ID}/checklist`)
    );
    const row = await screen.findByText("Complete agreed repairs");
    fireEvent.click(row);
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        `/deals/${DEAL_ID}/checklist/pc-0`,
        { checked: true }
      )
    );
  });
});

/**
 * #408 — the seller portal had the same one-way door as the buyer's: completed
 * tasks were filtered out of the list and `TaskCard` ignored clicks once done,
 * so a mis-tapped "done" could never be undone.
 */
describe("SellerView — completed tasks stay visible and re-openable (#408)", () => {
  const TASK_ID = "a1b2c3d4-0000-4f6e-8a2d-3c4b5a697e33";

  function completedSellerTask(): Task {
    return {
      id: TASK_ID,
      dealId: DEAL_ID,
      title: "Clear the driveway for photos",
      assignedTo: "seller",
      assignedToId: "seller-1",
      status: "completed",
      priority: "medium",
      source: "manual",
      stageContext: "offer_active",
      actionType: "confirm",
    } as Task;
  }

  it("renders a completed seller task instead of hiding it", () => {
    mockTasks = [completedSellerTask()];
    renderSeller(<SellerView />);

    expect(screen.getByText("Clear the driveway for photos")).toBeTruthy();
    expect(screen.getByText(/1 task completed/)).toBeTruthy();
  });

  it("PATCHes a completed task back to 'pending' when the seller taps it", async () => {
    mockTasks = [completedSellerTask()];
    renderSeller(<SellerView />);

    fireEvent.click(screen.getByText("Clear the driveway for photos"));

    await waitFor(() => expect(patchTaskStatus).toHaveBeenCalledWith(TASK_ID, "pending"));
    await waitFor(() => expect(mockRefreshTasks).toHaveBeenCalled());
  });
});

/**
 * #420 — the selling-journey rail checked off every stage the deal had walked
 * past, purely on position. A seller whose Listing Prep tasks were still open
 * was shown a green check against Listing Prep the moment the agent moved the
 * deal on. Green means it happened; an open stage gets an open circle.
 */
describe("SellerView — the journey rail only checks off finished stages (#420)", () => {
  function sellerTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-prep",
      dealId: DEAL_ID,
      title: "Declutter the front room",
      assignedTo: "seller",
      assignedToId: "seller-1",
      status: "pending",
      priority: "medium",
      source: "ai",
      stageContext: "active_search",
      ...overrides,
    } as Task;
  }

  it("does not mark a walked-past stage done while its tasks are still open", () => {
    dealOverrides = { stage: "under_contract" };
    mockTasks = [sellerTask()];
    renderSeller(<SellerView />);

    const row = screen.getByTestId("stage-row-active_search");
    expect(row.getAttribute("data-stage-state")).toBe("open");
    expect(row.textContent).toMatch(/1 task open/i);
  });

  it("still checks off a walked-past stage whose tasks are genuinely done", () => {
    dealOverrides = { stage: "under_contract" };
    mockTasks = [sellerTask({ status: "completed" })];
    renderSeller(<SellerView />);

    expect(screen.getByTestId("stage-row-active_search").getAttribute("data-stage-state"))
      .toBe("complete");
  });

  it("leaves a fallen-through deal's 'fell out' marker alone", () => {
    dealOverrides = {
      stage: "under_contract",
      status: "fallen_through",
      fellFromStage: "under_contract",
    } as Partial<MyDeal>;
    mockTasks = [sellerTask({ stageContext: "under_contract" })];
    renderSeller(<SellerView />);

    expect(screen.getByTestId("stage-row-under_contract").getAttribute("data-stage-state"))
      .toBe("fell-out");
  });
});

/**
 * #422 — the seller portal has to explain itself, same as the buyer's.
 *
 * The seller portal had it worse: it never had a STAGE_DESCRIPTIONS map at all,
 * so the only clue about where the seller was in the sale was a two-word label
 * in a pill.
 */
describe("SellerView — portal orientation (#422)", () => {
  const ALL_STAGES: MyDeal["stage"][] = [
    "intake",
    "active_search",
    "offer_active",
    "under_contract",
    "pre_close",
    "closing",
    "post_close",
  ];

  function task(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-seller-1",
      dealId: DEAL_ID,
      title: "Declutter the living room",
      assignedTo: "seller",
      assignedToId: "u-seller",
      status: "pending",
      priority: "medium",
      source: "ai",
      stageContext: "active_search",
      ...overrides,
    } as Task;
  }

  // Case 1 — fails against the old code.
  it.each(ALL_STAGES)("says the agent moves the seller along, at stage %s", (stage) => {
    dealOverrides = { stage };
    renderSeller(<SellerView />);

    const header = screen.getByTestId("portal-stage-header");
    expect(header.textContent).toMatch(/your agent will move you along this process/i);
    expect(header.textContent).toMatch(/notification when something needs you/i);
  });

  it("names the current stage and explains it in plain language", () => {
    dealOverrides = { stage: "active_search" };
    renderSeller(<SellerView />);

    const header = screen.getByTestId("portal-stage-header");
    expect(header.textContent).toMatch(/listing prep/i);
    expect(header.textContent).toMatch(/ready to go on the market/i);
  });

  // Case 2 — the seller's tasks live in a labelled region of their own.
  it("renders the seller's tasks inside a labelled actions region", () => {
    dealOverrides = { stage: "active_search" };
    mockTasks = [task()];
    renderSeller(<SellerView />);

    const actions = screen.getByTestId("portal-actions");
    expect(actions.textContent).toMatch(/what you need to do/i);
    expect(actions.contains(screen.getByText("Declutter the living room"))).toBe(true);

    const stage = screen.getByTestId("portal-stage");
    expect(actions.contains(stage)).toBe(false);
    expect(stage.contains(actions)).toBe(false);
  });

  it("leads with the seller's own work when they have some", () => {
    dealOverrides = { stage: "active_search" };
    mockTasks = [task()];
    renderSeller(<SellerView />);

    const actions = screen.getByTestId("portal-actions");
    const stage = screen.getByTestId("portal-stage");
    expect(
      actions.compareDocumentPosition(stage) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("leads with the stage card when nothing is waiting on the seller", () => {
    dealOverrides = { stage: "intake" };
    mockTasks = [];
    renderSeller(<SellerView />);

    const actions = screen.getByTestId("portal-actions");
    const stage = screen.getByTestId("portal-stage");
    expect(
      stage.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Case 3 — the reorganisation guard.
  it.each(ALL_STAGES)("renders the whole portal at stage %s", (stage) => {
    dealOverrides = { stage };
    renderSeller(<SellerView />);

    expect(screen.getByTestId("portal-root")).toBeTruthy();
    expect(screen.getByTestId("portal-stage-header")).toBeTruthy();
    const section = screen.getByTestId("portal-stage");
    expect((section.textContent ?? "").trim().length).toBeGreaterThan(0);
    expect(
      screen.getByTestId(`stage-row-${stage}`).getAttribute("data-stage-state"),
    ).toBe("current");
  });

  it("frames a fallen-through deal honestly and still says who drives it", () => {
    dealOverrides = {
      stage: "under_contract",
      status: "fallen_through",
      fellFromStage: "under_contract",
    } as Partial<MyDeal>;
    renderSeller(<SellerView />);

    const header = screen.getByTestId("portal-stage-header");
    expect(header.textContent).toMatch(/fell through/i);
    expect(header.textContent).toMatch(/your agent will move you along this process/i);
    // Never a "what you need to do" heading over a deal that fell out.
    expect(screen.getByTestId("portal-actions").textContent).toMatch(/talk to your agent/i);
  });

  // Case 4 — the #407 fix must survive the reorganisation here too.
  it("never shows the onboarding CTA once the intake is submitted", () => {
    dealOverrides = { stage: "intake", intakeSubmitted: true };
    renderSeller(<SellerView />);

    expect(screen.queryByRole("button", { name: /begin my onboarding/i })).toBeNull();
    expect(screen.getByText(/onboarding complete/i)).toBeTruthy();
  });

  it("still shows the onboarding CTA to a seller who has not submitted one", () => {
    dealOverrides = { stage: "intake", intakeSubmitted: false };
    renderSeller(<SellerView />);

    expect(screen.getByRole("button", { name: /begin my onboarding/i })).toBeTruthy();
  });

  it("keeps the journey rail and the agent card in the secondary column", () => {
    dealOverrides = { stage: "active_search" };
    renderSeller(<SellerView />);

    const secondary = screen.getByTestId("portal-secondary");
    expect(secondary.contains(screen.getByTestId("stage-row-active_search"))).toBe(true);
    expect(secondary.textContent).toMatch(/sarah johnson/i);
  });
});
