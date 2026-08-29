// @vitest-environment happy-dom
/**
 * #484 (FF28) — the READER half. `tests/api/fastpass-refund-status.test.ts`
 * pins the state the webhook writes; this pins what the surfaces do with it.
 *
 * The trap the issue names: every Fast Pass reader is an `=== 'active'` check,
 * so the moment `status` becomes `'refunded'` a refunded client silently
 * collapses into "never enrolled" — the buyer gets pitched Fast Pass again and
 * the agent's card offers to enrol them. "Refunded" is a conversation;
 * "never enrolled" is not, and the two must never render the same.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Deal } from "@/lib/types";
import type { MyDeal } from "@/hooks/useMyDeals";

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

vi.mock("@/lib/api-client", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {
    status = 500;
    body: unknown = null;
  },
  setTokenGetter: vi.fn(),
}));

// ── The buyer portal's surrounding machinery, stubbed to nothing ─────────────
vi.mock("@/hooks/useMyDeals", () => ({ useMyDeals: vi.fn() }));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: [], loading: false, error: null, refresh: vi.fn() }),
  useAgentTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useTaskCompletion", () => ({
  useTaskCompletion: () => ({
    completedIds: new Set<string>(),
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
    addProperty: vi.fn(),
    removeProperty: vi.fn(),
    updateStatus: vi.fn(),
    updateBuyerNote: vi.fn(),
    updateAgentNote: vi.fn(),
    setOfferRequested: vi.fn(),
  }),
}));
vi.mock("@/hooks/useMLS", () => ({
  useMLSListings: () => ({
    listings: [],
    loading: false,
    error: null,
    errorKind: "none",
    search: vi.fn(),
  }),
  useMLSConnection: () => ({
    connected: true,
    known: true,
    loading: false,
    saveMLS: vi.fn(),
    disconnectMLS: vi.fn(),
  }),
}));
vi.mock("@/hooks/useDocuments", () => ({
  useDocuments: () => ({ docs: [], loading: false, error: null }),
  getDownloadUrl: vi.fn(),
  getSigningUrl: vi.fn(),
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
}));
vi.mock("@/hooks/useInspectionItems", () => ({
  useInspectionItems: () => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
  }),
}));
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));
vi.mock("@/components/portal/PortalDealDocuments", () => ({ default: () => null }));
vi.mock("@/components/ClientNotifications", () => ({ default: () => null }));
vi.mock("@/components/MetroMap", () => ({ default: () => null }));
vi.mock("@/components/VendorDirectory", () => ({ default: () => null }));

import { useMyDeals } from "@/hooks/useMyDeals";
import { FastPassCard, SmoothExitCard } from "@/components/deal/OverviewTab";
import BuyerView from "@/components/pages/buyer/BuyerView";

const DEAL_ID = "9c1f2a3b-0000-4000-8000-000000000001";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: DEAL_ID,
    type: "buy",
    clientName: "Betty Buyer",
    clientId: "u-buyer",
    agentId: "u-agent",
    stage: "under_contract",
    health: "green",
    priority: "medium",
    property: {
      address: "123 Oak St",
      city: "Hoover",
      state: "AL",
      zip: "35226",
      price: 300000,
    },
    timeline: { createdAt: "2026-01-01T00:00:00Z", daysInStage: 3 },
    flags: [],
    status: "active",
    estimatedCommission: null,
    commissionPct: 3,
    openTaskCount: 0,
    overdueTaskCount: 0,
    ...overrides,
  } as Deal;
}

/** A Fast Pass enrolment that has been fully refunded (#484). */
const REFUNDED_FAST_PASS: NonNullable<Deal["fastPass"]> = {
  enrolledAt: "2026-06-01T00:00:00.000Z",
  status: "refunded",
  paymentOption: "now",
  selectedUpsells: ["utility_setup"],
  basePriceCents: 178_700,
  upsellPrices: { utility_setup: 9_700 },
  totalPaid: 1884,
  totalCents: 188_400,
  paid: false,
};

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Agent deal card — a refunded Fast Pass (#484)", () => {
  it("says the money was refunded instead of reading as a live enrolment", () => {
    renderWithClient(<FastPassCard deal={makeDeal({ fastPass: REFUNDED_FAST_PASS })} />);

    expect(screen.getByTestId("fp-refunded-note")).toBeTruthy();
    // Two places say it — the status pill and the money line — and both must,
    // because each answers a different question (is it running / where did the
    // money go).
    expect(screen.getAllByText("Refunded").length).toBe(2);
    // Never the live-service wording.
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("keeps the agreed record on screen — the refund reverses money, not history", () => {
    renderWithClient(<FastPassCard deal={makeDeal({ fastPass: REFUNDED_FAST_PASS })} />);

    // The add-on the client bought, and the total they agreed to, both survive.
    // (The card states the agreed total in more than one place — pill and
    // footnote — so this counts rather than demanding a single node.)
    expect(screen.getByText(/utility/i)).toBeTruthy();
    expect(screen.getAllByText(/\$1,884/).length).toBeGreaterThan(0);
  });

  it("does not collapse into the never-enrolled pitch", () => {
    const { unmount } = renderWithClient(
      <FastPassCard deal={makeDeal({ fastPass: REFUNDED_FAST_PASS })} />
    );
    expect(screen.queryByRole("button", { name: /enroll in fast pass/i })).toBeNull();
    unmount();

    // …which is exactly what a deal with NO enrolment still shows.
    renderWithClient(<FastPassCard deal={makeDeal()} />);
    expect(screen.getByRole("button", { name: /enroll in fast pass/i })).toBeTruthy();
  });
});

describe("Agent deal card — refunded Smooth Exit add-ons (#484)", () => {
  const SE_BASE: NonNullable<Deal["smoothExit"]> = {
    enrolledAt: "2026-06-01T00:00:00.000Z",
    status: "active",
    estimatedSalePrice: 450_000,
    fee: 4_500,
    paymentOption: "from_proceeds",
    buyingNext: false,
    selectedUpsells: ["staging_consult"],
    upsellTotalCents: 24_700,
  };

  it("labels refunded add-ons as refunded rather than 'not paid'", () => {
    renderWithClient(
      <SmoothExitCard
        deal={makeDeal({
          type: "sell",
          smoothExit: { ...SE_BASE, upsellsPaid: false, upsellsRefunded: true },
        })}
      />
    );

    expect(screen.getByText(/add-ons refunded/i)).toBeTruthy();
    // "Not paid" reads as money still owed — the opposite of what happened.
    expect(screen.queryByText("Add-ons not paid")).toBeNull();
  });

  it("leaves the enrolment itself running — only the add-ons were refunded", () => {
    renderWithClient(
      <SmoothExitCard
        deal={makeDeal({
          type: "sell",
          smoothExit: { ...SE_BASE, upsellsPaid: false, upsellsRefunded: true },
        })}
      />
    );
    // The 1% fee still comes out of proceeds at closing.
    expect(screen.getByText("active")).toBeTruthy();
  });
});

describe("Buyer portal — a refunded Fast Pass (#484)", () => {
  function buyerDeal(fastPass?: Deal["fastPass"]): MyDeal {
    return {
      ...makeDeal({ stage: "active_search" }),
      ...(fastPass ? { fastPass } : {}),
      preApproved: true,
      baaSigned: true,
      agentName: "Alice Agent",
      agentEmail: "agent@example.com",
      agentPhone: null,
    } as MyDeal;
  }

  it("does not re-pitch Fast Pass to a client who was just refunded", () => {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [buyerDeal(REFUNDED_FAST_PASS)],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderWithClient(<BuyerView />);

    // The pitch's CTA. Offering to sell it again is the "collapsed into never
    // enrolled" failure the issue is about.
    expect(screen.queryByRole("button", { name: /get started/i })).toBeNull();
    // …and the tracker for a service they no longer have is gone too.
    expect(screen.queryByText(/fast pass active/i)).toBeNull();
  });

  it("still pitches a client who never enrolled", () => {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [buyerDeal()],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    renderWithClient(<BuyerView />);

    expect(screen.getByRole("button", { name: /get started/i })).toBeTruthy();
  });
});
