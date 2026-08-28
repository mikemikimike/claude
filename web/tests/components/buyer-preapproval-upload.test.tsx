// @vitest-environment happy-dom
/**
 * Issue #266 — the buyer home-search card (ActiveSearchCard) showed an
 * outside-lender (not Mountain Mortgage), not-pre-approved buyer two CTAs —
 * "Upload pre-approval letter" and "I have one — send later" — whose handlers
 * were literally empty. Clicking did nothing.
 *
 * After the fix:
 *  - "Upload pre-approval letter" routes the picked file through the SAME
 *    presigned flow the TaskCard upload uses (requestUploadUrl →
 *    uploadFileToStorage → confirmUpload), shows uploading/success/error
 *    states, and invalidates the deal's ['documents', dealId] query.
 *  - "I have one — send later" posts a real client_thread message to the agent
 *    and collapses into an acknowledged state (never a silent no-op).
 *  - pre_approved stays agent-set — the buttons are made truthful, they do NOT
 *    auto-approve.
 *
 * On the OLD code every assertion below fails (the handlers do nothing).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MyDeal } from "@/hooks/useMyDeals";

// ─── Shared mocks (mirrors buyer-property-actions-error.test.tsx) ───────────────

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
  useProperties: vi.fn(),
}));

vi.mock("@/hooks/useMLS", () => ({
  useMLSListings: () => ({ listings: [], loading: false, error: null, search: vi.fn() }),
}));

vi.mock("@/hooks/useDocuments", () => ({
  useDocuments: () => ({ docs: [], loading: false, error: null, refresh: vi.fn() }),
  getDownloadUrl: vi.fn(),
  getSigningUrl: vi.fn(),
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
}));

vi.mock("@/lib/direct-upload", () => ({
  uploadFileToStorage: vi.fn(),
}));

vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    markRead: vi.fn(),
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
import { useProperties } from "@/hooks/useProperties";
import type { TrackedProperty } from "@/hooks/useProperties";
import { requestUploadUrl, confirmUpload } from "@/hooks/useDocuments";
import { uploadFileToStorage } from "@/lib/direct-upload";
import { postMessage } from "@/hooks/useMessages";
import BuyerView from "@/components/pages/buyer/BuyerView";

// Outside-lender (no mountain_mortgage flag), NOT pre-approved → the two CTAs
// under test render. baaSigned:true keeps the BAA sub-block a static green
// "signed" box that never interferes with the upload / send-later buttons.
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
  preApproved: false,
  baaSigned: true,
  agentName: "Alice Agent",
  agentEmail: "agent@example.com",
  agentPhone: null,
};

function makeFile() {
  return new File(["hello"], "preapproval.pdf", { type: "application/pdf" });
}

type UsePropertiesReturn = ReturnType<typeof useProperties>;

function makePropertiesReturn(
  overrides: Partial<UsePropertiesReturn> = {}
): UsePropertiesReturn {
  return {
    properties: [],
    loading: false,
    refresh: vi.fn(),
    addProperty: vi.fn().mockResolvedValue(undefined),
    removeProperty: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    updateBuyerNote: vi.fn().mockResolvedValue(undefined),
    updateAgentNote: vi.fn().mockResolvedValue(undefined),
    setOfferRequested: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderView(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

/** Grab the (single) hidden pre-approval file input from the rendered card. */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  return input;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMyDeals).mockReturnValue({
    deals: [DEAL],
    loading: false,
    error: null,
    refresh: vi.fn(),
  });
  vi.mocked(useProperties).mockReturnValue(makePropertiesReturn());
});

describe("ActiveSearchCard — Upload pre-approval letter (#266)", () => {
  it("routes the picked file through the presigned flow and shows a success state", async () => {
    vi.mocked(requestUploadUrl).mockResolvedValue({
      upload_url: "https://blob.example.com/put?sig=abc",
      s3_key: "deals/deal-1/uploads/preapproval.pdf",
    });
    vi.mocked(uploadFileToStorage).mockResolvedValue({ ok: true, tooLarge: false });
    vi.mocked(confirmUpload).mockResolvedValue({ id: "doc-1" } as never);

    const { container, client } = renderView(<BuyerView />);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    // Buyer clicks the CTA (triggers the hidden input) and picks a file.
    fireEvent.click(screen.getByRole("button", { name: /upload pre-approval letter/i }));
    fireEvent.change(fileInput(container), { target: { files: [makeFile()] } });

    await waitFor(() => expect(requestUploadUrl).toHaveBeenCalledTimes(1));
    expect(requestUploadUrl).toHaveBeenCalledWith("deal-1", "preapproval.pdf", "application/pdf");
    expect(uploadFileToStorage).toHaveBeenCalledTimes(1);
    expect(confirmUpload).toHaveBeenCalledWith(
      "deal-1", "preapproval.pdf", "deals/deal-1/uploads/preapproval.pdf", "application/pdf", expect.any(Number),
    );

    // Real success state (not a fake spinner) …
    expect(await screen.findByText(/pre-?approval letter uploaded/i)).toBeInTheDocument();
    // … and the deal's Documents query was invalidated so the doc surfaces.
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents", "deal-1"] });
  });

  it("surfaces an inline error on upload failure and keeps the button usable for retry", async () => {
    vi.mocked(requestUploadUrl).mockResolvedValue({
      upload_url: "https://blob.example.com/put?sig=abc",
      s3_key: "deals/deal-1/uploads/preapproval.pdf",
    });
    // Byte upload fails → the helper returns { ok:false } (never throws, #190).
    vi.mocked(uploadFileToStorage).mockResolvedValue({ ok: false, tooLarge: false });

    const { container } = renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /upload pre-approval letter/i }));
    fireEvent.change(fileInput(container), { target: { files: [makeFile()] } });

    expect(await screen.findByText(/upload failed/i)).toBeInTheDocument();
    // No phantom documents row on a failed byte upload.
    expect(confirmUpload).not.toHaveBeenCalled();
    // The CTA is still there → the buyer can retry.
    expect(
      screen.getByRole("button", { name: /upload pre-approval letter/i })
    ).toBeInTheDocument();
  });
});

describe("ActiveSearchCard — I have one, send later (#266)", () => {
  it("posts a client_thread message to the agent and collapses into an acknowledged state", async () => {
    vi.mocked(postMessage).mockResolvedValue({ id: "m-1" } as never);

    renderView(<BuyerView />);

    fireEvent.click(screen.getByRole("button", { name: /send later/i }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith(
      "deal-1",
      "client_thread",
      expect.stringMatching(/pre-?approval/i),
    );
    // Not a silent no-op — the buyer sees a real acknowledgement.
    expect(
      await screen.findByText(/let your agent know|agent has been notified/i)
    ).toBeInTheDocument();
  });

  it("does NOT flip pre_approved — the buttons only get truthful, they don't auto-approve", async () => {
    vi.mocked(postMessage).mockResolvedValue({ id: "m-1" } as never);

    renderView(<BuyerView />);

    // The pre-approval banner is still present after acknowledging (agent sets
    // pre_approved server-side; the buyer's message doesn't grant it).
    fireEvent.click(screen.getByRole("button", { name: /send later/i }));

    expect(
      await screen.findByText(/let your agent know|agent has been notified/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/get pre-approved to make an offer/i)
    ).toBeInTheDocument();
  });
});

/**
 * Issue #409 — the offer gate ran purely off agent-set `pre_approved`, so a
 * buyer who answered "💰 Cash purchase" in onboarding was told "Pre-approval
 * required to make an offer" on every property, forever, with no way out.
 *
 * The financing answer now rides onto the deal (derived from `deals.intake` —
 * see lib/intake.ts) and the gate becomes `preApproved || cash`.
 */
describe("ActiveSearchCard — cash buyers skip the pre-approval gate (#409)", () => {
  const PROPERTY: TrackedProperty = {
    id: "prop-1",
    dealId: "deal-1",
    address: "456 Elm St",
    city: "Hoover",
    state: "AL",
    price: 350000,
    beds: 3,
    baths: 2,
    sqft: 1900,
    thumbnailUrl: "",
    sourceUrl: "",
    status: "interested",
    addedBy: "agent",
  };

  function renderWithDeal(deal: MyDeal) {
    vi.mocked(useMyDeals).mockReturnValue({
      deals: [deal],
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    vi.mocked(useProperties).mockReturnValue(
      makePropertiesReturn({ properties: [PROPERTY] })
    );
    return renderView(<BuyerView />);
  }

  // Case 2 — fails against the pre-#409 code.
  it("a cash buyer with pre_approved=false can still make an offer", () => {
    renderWithDeal({ ...DEAL, preApproved: false, financingType: "cash" });

    expect(screen.getByRole("button", { name: /make an offer/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/pre-approval required to make an offer/i)
    ).not.toBeInTheDocument();
  });

  // Case 2b — the amber banner is the other half of the dead end.
  it("shows a cash buyer no pre-approval banner anywhere", () => {
    renderWithDeal({ ...DEAL, preApproved: false, financingType: "cash" });

    expect(
      screen.queryByText(/get pre-approved to make an offer/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload pre-approval letter/i })
    ).not.toBeInTheDocument();
  });

  // Case 3 — no regression: this is the case the gate exists for.
  it("still gates a financed buyer with pre_approved=false", () => {
    renderWithDeal({ ...DEAL, preApproved: false, financingType: "loan" });

    expect(
      screen.getByText(/pre-approval required to make an offer/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/get pre-approved to make an offer/i)
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /make an offer/i })).not.toBeInTheDocument();
  });

  // A deal with no intake yet must fall back to the old behaviour, not unlock.
  it("still gates a buyer whose financing type is unknown", () => {
    renderWithDeal({ ...DEAL, preApproved: false, financingType: undefined });

    expect(
      screen.getByText(/pre-approval required to make an offer/i)
    ).toBeInTheDocument();
  });

  // Case 4 — no regression.
  it("lets a pre-approved financed buyer make an offer", () => {
    renderWithDeal({ ...DEAL, preApproved: true, financingType: "loan" });

    expect(screen.getByRole("button", { name: /make an offer/i })).toBeInTheDocument();
    expect(
      screen.queryByText(/pre-approval required to make an offer/i)
    ).not.toBeInTheDocument();
  });
});
