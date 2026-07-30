// @vitest-environment happy-dom
/**
 * Issue #279 — the buyer-portal Fast Pass pitch card (FastPassPitch) hardcoded
 * "$1,497 · pay now or at closing" while the catalog / server / survey charged
 * whatever lib/fast-pass-catalog.ts said, surfaced via lib/fast-pass-display.ts
 * (#78). A buyer was quoted one price on the pitch card and charged another at
 * checkout. (The charged figure was $2,977 at the time; it is $1,787 now — the
 * catalog was itself overcharging against the advertised price. That is exactly
 * why nothing here hardcodes a number.)
 *
 * After the fix the pitch card must render the single-sourced base price — the
 * same value POST /deals/[id]/fastpass charges — and must track that constant
 * rather than a literal.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MyDeal } from "@/hooks/useMyDeals";

// ─── Shared mocks (mirror buyer-property-actions-error.test.tsx) ──────────────

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
import { FAST_PASS_BASE_PRICE } from "@/lib/fast-pass-display";
import { FAST_PASS_BASE_PRICE_CENTS } from "@/lib/fast-pass-catalog";
import BuyerView from "@/components/pages/buyer/BuyerView";

// A non-intake, non-post_close, non-fallen-through, un-enrolled buyer deal —
// the exact state in which BuyerView renders <FastPassPitch />.
const DEAL: MyDeal = {
  id: "deal-1",
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

function renderView(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMyDeals).mockReturnValue({
    deals: [DEAL],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
});

describe("FastPassPitch price (#279)", () => {
  it("shows the single-sourced base price the buyer is charged, not the stale $1,497", () => {
    renderView(<BuyerView />);

    // The badge is located by its stable copy so the assertion doesn't depend
    // on the (buggy) number.
    const badge = screen.getByText(/pay now or at closing/i);

    // The displayed price equals the single source used by the survey/checkout.
    expect(badge).toHaveTextContent(`$${FAST_PASS_BASE_PRICE.toLocaleString()}`);
    // And no longer shows the stale, much-lower hardcoded quote.
    expect(badge).not.toHaveTextContent("1,497");
  });

  it("tracks the shared constant — the displayed value derives from the import, not a literal", () => {
    // The display constant is derived from the catalog cents that the server
    // actually charges (lib/fast-pass-catalog.ts → POST /deals/[id]/fastpass),
    // so what the pitch shows is what the buyer pays.
    expect(FAST_PASS_BASE_PRICE).toBe(FAST_PASS_BASE_PRICE_CENTS / 100);

    renderView(<BuyerView />);

    const badge = screen.getByText(/pay now or at closing/i);
    // Assert against the imported binding (never a dollar literal): if the
    // shared constant changes, this expectation — and the card — move with it.
    expect(badge).toHaveTextContent(
      `$${FAST_PASS_BASE_PRICE.toLocaleString()} · pay now or at closing`
    );
  });
});
