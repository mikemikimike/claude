// @vitest-environment happy-dom
/**
 * DealDetail component tests.
 *
 * 1) UploadDocModal — regression tests for issue #190: the blob PUT response
 *    must be checked BEFORE confirmUpload. A failed PUT (413/500) must surface
 *    an error and must NOT create the documents row (phantom document) or show
 *    the green "Document uploaded" success screen. Only a 2xx PUT may confirm.
 *
 * 2) Stage advance (#185) — the modal drafts a client message and promises it
 *    is "Sent to client's portal". Confirming the advance must actually POST
 *    the (edited) draft to the deal's client_thread, an empty draft must post
 *    nothing, a failed post must never break the advance itself, and the
 *    modal must not claim automations that don't exist ("TC alerted to open
 *    file", "Commission paperwork queued").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DealDetail, { UploadDocModal, StageAdvanceModal, SellerBuyerStatusCard } from "@/components/pages/agent/DealDetail";
import {
  FastPassCard,
  SmoothExitCard,
  LoanMilestonesCard,
  PreApprovalStatusCard,
} from "@/components/deal/OverviewTab";
import { FLAG_LABELS } from "@/components/deal/shared";
import { DealHeader } from "@/components/deal/DealHeader";
import { api } from "@/lib/api-client";
import { FAST_PASS_UPSELLS } from "@/lib/fast-pass-display";
import { SMOOTH_EXIT_UPSELLS } from "@/lib/smooth-exit-display";
import type { Deal, Task } from "@/lib/types";

const requestUploadUrl = vi.fn();
const confirmUpload = vi.fn();
// #189 — the direct-to-Blob byte path. Mocked at the SDK boundary so the real
// lib/direct-upload logic (direct → proxy fallback, size-error mapping) runs.
const uploadPresignedMock = vi.fn();
vi.mock("@vercel/blob/client", () => ({
  uploadPresigned: (...a: unknown[]) => uploadPresignedMock(...a),
}));
vi.mock("@/hooks/useDocuments", () => ({
  useDocuments: vi.fn(() => ({
    docs: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
  requestUploadUrl: (...a: unknown[]) => requestUploadUrl(...a),
  confirmUpload: (...a: unknown[]) => confirmUpload(...a),
  getDownloadUrl: vi.fn(),
  deleteDocument: vi.fn(),
  sendForSignatureByUserIds: vi.fn(),
  refreshDocuSignStatus: vi.fn(),
  setDisclosuresComplete: vi.fn(),
}));

// ─── Full-page harness mocks (stage-advance flow, #185) ─────────────────────
// DealDetail is rendered whole, so every hook/store it (or an always-rendered
// child) calls is mocked at the module boundary — the same seam pattern the
// other component tests use. Spies are dereferenced lazily (`(...a) => spy(...a)`)
// so vi.mock hoisting stays safe.

const DEAL_ID = "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01";

function makeDeal(overrides: Partial<Deal> = {}): Deal {
  return {
    id: DEAL_ID,
    type: "buy",
    clientName: "Jane Buyer",
    clientId: "",
    agentId: "agent-1",
    stage: "active_search",
    health: "green",
    priority: "medium",
    property: {
      address: "123 Main Street",
      city: "Birmingham",
      state: "AL",
      zip: "35203",
      price: 350000,
    },
    timeline: {
      createdAt: "2026-05-01T00:00:00Z",
      daysInStage: 4,
    },
    flags: [],
    status: "active",
    estimatedCommission: 10500,
    openTaskCount: 0,
    overdueTaskCount: 0,
    ...overrides,
  };
}

let currentDeal: Deal;

const patchStage = vi.fn();
vi.mock("@/hooks/useDeals", () => ({
  useDeal: () => ({ deal: currentDeal, loading: false, error: null, refresh: vi.fn() }),
  patchStage: (...a: unknown[]) => patchStage(...a),
}));

const postMessage = vi.fn();
vi.mock("@/hooks/useMessages", () => ({
  useMessages: () => ({ messages: [], loading: false, error: null, refresh: vi.fn() }),
  postMessage: (...a: unknown[]) => postMessage(...a),
}));

const postTask = vi.fn();
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: [], loading: false, refresh: vi.fn() }),
  postTask: (...a: unknown[]) => postTask(...a),
  patchTask: vi.fn(),
  patchTaskStatus: vi.fn(),
}));

// The Timeline tab (the default landing tab here) fetches stage history via
// TanStack Query (#256); stub it so these tests need no QueryClientProvider.
vi.mock("@/hooks/useStageHistory", () => ({
  useStageHistory: () => ({ history: [], loading: false }),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ dealId: DEAL_ID }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  // Land on the light Timeline tab — Overview drags in many more cards.
  useSearchParams: () => new URLSearchParams("tab=timeline"),
}));

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel?: (s: unknown) => unknown) => {
    const state = { activeUser: { id: "agent-1", groupId: "agent", name: "Agent Amy" } };
    return sel ? sel(state) : state;
  },
}));

vi.mock("@/permissions/usePermission", () => ({
  usePermission: () => ({
    can: () => true,
    canAny: () => true,
    canAll: () => true,
    currentGroup: "agent",
    hasPermission: () => true,
  }),
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    get: vi.fn(async () => []),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
  },
  ApiError: class ApiError extends Error {
    status: number;
    body?: { gate?: string; blocking_tasks?: { id: string; title: string }[] };
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  setTokenGetter: vi.fn(),
}));

// Hooks/components pulled in by tabs and cards these tests never exercise.
vi.mock("@/hooks/useParticipants", () => ({
  useParticipants: () => ({ participants: [], loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useVendors", () => ({
  useVendors: () => ({ vendors: [], loading: false, refresh: vi.fn() }),
}));
// The Offer Active picker reads these (#410); tests that need an option to
// select push one in.
let trackedProperties: Record<string, unknown>[] = [];
vi.mock("@/hooks/useProperties", () => ({
  useProperties: () => ({ properties: trackedProperties, loading: false, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useShowingAvailability", () => ({
  useShowingAvailability: () => ({ slots: [], loading: false, refresh: vi.fn() }),
  DAYS_OF_WEEK: [],
}));
const addOffer = vi.fn();
vi.mock("@/hooks/useOffers", () => ({
  useOffers: () => ({
    offers: [],
    loading: false,
    refresh: vi.fn(),
    addOffer: (...a: unknown[]) => addOffer(...a),
    removeOffer: vi.fn(),
  }),
}));
vi.mock("@/hooks/useNetSheet", () => ({
  useNetSheet: () => ({ lines: [], loading: false, refresh: vi.fn() }),
  recalcLines: () => [],
  calcNetProceeds: () => 0,
}));
vi.mock("@/hooks/useContingencies", () => ({
  useContingencies: () => ({ contingencies: [], loading: false, refresh: vi.fn() }),
}));
// DealDetail calls this for the Inspection tab's open-item badge (#429). Like
// every other hook here it must be stubbed — the real one reaches for a
// QueryClient these tests deliberately don't mount.
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
vi.mock("@/components/MetroMap", () => ({ default: () => null }));
vi.mock("@/components/DealInviteModal", () => ({ default: () => null }));
vi.mock("@/components/pages/agent/SendTemplateModal", () => ({ default: () => null }));
vi.mock("@/components/net-sheet/AddCustomLineControl", () => ({
  AddCustomLineControl: () => null,
}));
vi.mock("@/components/contingencies/AddContingencyForm", () => ({
  AddContingencyForm: () => null,
}));

// The modal PUTs the file to the capability URL with the global fetch —
// stub it so we control the blob-put response (ok / 413 / 500).
const fetchMock = vi.fn();

const UPLOAD_URL = "https://app.example.com/api/storage/blob-put?key=k&sig=s";
const S3_KEY = "deals/deal-1/contract.pdf";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  requestUploadUrl.mockResolvedValue({ upload_url: UPLOAD_URL, s3_key: S3_KEY });
  confirmUpload.mockResolvedValue({ id: "doc-1" });
  trackedProperties = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILE = new File(["dummy pdf bytes"], "contract.pdf", {
  type: "application/pdf",
});

/** Render the modal, pick a file, and click Upload. */
async function submitUpload() {
  const user = userEvent.setup();
  const onUploaded = vi.fn();
  const onClose = vi.fn();
  render(<UploadDocModal dealId="deal-1" onClose={onClose} onUploaded={onUploaded} />);

  await user.upload(screen.getByLabelText(/browse/i), FILE);
  await user.click(screen.getByRole("button", { name: /^upload$/i }));
  return { user, onUploaded, onClose };
}

describe("UploadDocModal PUT response handling (#190)", () => {
  it("a failed PUT (413) does NOT confirm the document and shows an error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 413 });
    const { onUploaded } = await submitUpload();

    // An error surfaces…
    expect(await screen.findByText(/file too large/i)).toBeInTheDocument();
    // …no phantom documents row is created, no success screen, no refresh.
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByText(/document uploaded/i)).not.toBeInTheDocument();
  });

  it("a 413 surfaces the size-limit message (max 25MB)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 413 });
    await submitUpload();

    expect(
      await screen.findByText(/file too large \(max 25MB\)/i)
    ).toBeInTheDocument();
  });

  it("a failed PUT (500) does NOT confirm and shows the generic error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { onUploaded } = await submitUpload();

    expect(
      await screen.findByText(/upload failed\. please try again\./i)
    ).toBeInTheDocument();
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(screen.queryByText(/document uploaded/i)).not.toBeInTheDocument();
  });

  it("a successful PUT confirms the upload and shows the success screen", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { onUploaded } = await submitUpload();

    expect(await screen.findByText(/document uploaded/i)).toBeInTheDocument();

    // The PUT went to the capability URL with the file body…
    expect(fetchMock).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({ method: "PUT", body: FILE })
    );
    // …and only then was the documents row confirmed.
    await waitFor(() =>
      expect(confirmUpload).toHaveBeenCalledWith(
        "deal-1",
        "Buyer Agency Agreement", // the default document-type option
        S3_KEY,
        "application/pdf",
        FILE.size
      )
    );
    expect(onUploaded).toHaveBeenCalled();
  });

  it("keeps the form usable after a failed PUT (can retry)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await submitUpload();
    await screen.findByText(/upload failed/i);

    // The Upload button is re-enabled — the agent can retry.
    expect(screen.getByRole("button", { name: /^upload$/i })).toBeEnabled();
  });
});

// ─── Direct-to-Blob upload (#189) ────────────────────────────────────────────
// Vercel Functions reject bodies over ~4.5MB at the edge, so files 4.5–25MB
// could never reach the blob-put proxy in prod. When the server hands back a
// client_upload_url, the modal must push the bytes directly to Blob via the
// SDK's presigned flow — no function in the byte path — while preserving the
// #190 invariant: a failed upload NEVER confirms a documents row.

describe("UploadDocModal direct-to-blob upload (#189)", () => {
  const CLIENT_UPLOAD_URL = "/api/storage/client-upload?key=k&exp=1&sig=s";

  beforeEach(() => {
    requestUploadUrl.mockResolvedValue({
      upload_url: UPLOAD_URL,
      client_upload_url: CLIENT_UPLOAD_URL,
      s3_key: S3_KEY,
    });
  });

  it("uploads directly to Blob (no proxy fetch in the byte path) and confirms", async () => {
    uploadPresignedMock.mockResolvedValue({ pathname: S3_KEY });
    const { onUploaded } = await submitUpload();

    expect(await screen.findByText(/document uploaded/i)).toBeInTheDocument();
    // The SDK presigned upload carried the file, pinned to the server's key.
    expect(uploadPresignedMock).toHaveBeenCalledWith(
      S3_KEY,
      FILE,
      expect.objectContaining({
        access: "private",
        handleUploadUrl: CLIENT_UPLOAD_URL,
        contentType: "application/pdf",
      })
    );
    // The file body never went through the app's own fetch (the ~4.5MB proxy).
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(confirmUpload).toHaveBeenCalledWith(
        "deal-1",
        "Buyer Agency Agreement",
        S3_KEY,
        "application/pdf",
        FILE.size
      )
    );
    expect(onUploaded).toHaveBeenCalled();
  });

  it("a too-large direct upload shows the 25MB error, never confirms, never falls back", async () => {
    uploadPresignedMock.mockRejectedValue(
      new Error("Vercel Blob: the file length cannot be greater than 26214400")
    );
    const { onUploaded } = await submitUpload();

    expect(await screen.findByText(/file too large \(max 25MB\)/i)).toBeInTheDocument();
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
    // A size rejection must not retry through the proxy (it would 413 anyway).
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/document uploaded/i)).not.toBeInTheDocument();
  });

  it("a non-size direct failure falls back to the proxy; a failed fallback never confirms", async () => {
    uploadPresignedMock.mockRejectedValue(new Error("network down"));
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { onUploaded } = await submitUpload();

    expect(await screen.findByText(/upload failed\. please try again\./i)).toBeInTheDocument();
    // The direct path was attempted first…
    expect(uploadPresignedMock).toHaveBeenCalled();
    // …then the fallback attempted the capability-URL proxy…
    expect(fetchMock).toHaveBeenCalledWith(
      UPLOAD_URL,
      expect.objectContaining({ method: "PUT", body: FILE })
    );
    // …and the failed upload still never created a documents row.
    expect(confirmUpload).not.toHaveBeenCalled();
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("a successful proxy fallback still confirms the upload", async () => {
    uploadPresignedMock.mockRejectedValue(new Error("blob api hiccup"));
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const { onUploaded } = await submitUpload();

    expect(await screen.findByText(/document uploaded/i)).toBeInTheDocument();
    expect(uploadPresignedMock).toHaveBeenCalled();
    await waitFor(() => expect(confirmUpload).toHaveBeenCalled());
    expect(onUploaded).toHaveBeenCalled();
  });
});

// ─── Stage advance — drafted client message must actually send (#185) ────────

describe("Stage advance posts the drafted client message (#185)", () => {
  beforeEach(() => {
    currentDeal = makeDeal(); // active_search → next stage is offer_active
    patchStage.mockResolvedValue(undefined);
    postTask.mockResolvedValue(undefined);
    postMessage.mockResolvedValue({ id: "msg-1" });
    addOffer.mockResolvedValue(undefined);
    // Advancing to offer_active now requires a property + amount (#410), so
    // the deal needs at least one tracked property to pick.
    trackedProperties = [
      { id: "prop-1", address: "123 Main Street", city: "Birmingham", state: "AL", price: 350000 },
    ];
  });

  /**
   * Render the page, click the advance button, wait for the modal, and fill in
   * the Offer Active property + amount the modal now requires (#410).
   */
  async function openAdvanceModal() {
    const user = userEvent.setup();
    render(<DealDetail />);
    // The advance button is labeled with the next stage's name.
    await user.click(screen.getByRole("button", { name: /offer active/i }));
    await screen.findByRole("button", { name: /confirm & advance/i });
    await user.selectOptions(screen.getByLabelText(/property under offer/i), "prop-1");
    await user.type(screen.getByLabelText(/offer amount/i), "340000");
    return user;
  }

  it("posts the edited draft to the client thread on confirm", async () => {
    const user = await openAdvanceModal();

    // Edit the drafted message, exactly like the repro in the ticket.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox");
    await user.clear(textarea);
    await user.type(textarea, "Custom note for my client");

    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        DEAL_ID,
        "client_thread",
        "Custom note for my client"
      )
    );
    // The stage advance itself is unchanged.
    expect(patchStage).toHaveBeenCalledWith(DEAL_ID, "offer_active", undefined);
  });

  it("posts the default draft as-is when the agent doesn't edit it", async () => {
    const user = await openAdvanceModal();
    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const [dealId, channel, body] = postMessage.mock.calls[0];
    expect(dealId).toBe(DEAL_ID);
    expect(channel).toBe("client_thread");
    // The offer_active draft is personalized with client + address.
    expect(body).toMatch(/Jane/);
    expect(body).toMatch(/123 Main Street/);
  });

  it("an empty draft posts nothing (stage still advances)", async () => {
    const user = await openAdvanceModal();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox"));
    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() =>
      expect(patchStage).toHaveBeenCalledWith(DEAL_ID, "offer_active", undefined)
    );
    // Wait for the flow to finish (modal closes) before asserting no post.
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /confirm & advance/i })
      ).not.toBeInTheDocument()
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("a failed message send never breaks the advance and surfaces a warning", async () => {
    postMessage.mockRejectedValue(new Error("network down"));
    const user = await openAdvanceModal();

    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    // The advance completed…
    await waitFor(() =>
      expect(patchStage).toHaveBeenCalledWith(DEAL_ID, "offer_active", undefined)
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /confirm & advance/i })
      ).not.toBeInTheDocument()
    );
    // …and the failure is surfaced without blocking anything.
    expect(
      await screen.findByText(/client message could not be sent/i)
    ).toBeInTheDocument();
  });

  // ─── #410: the advance must record the property and the amount ────────────

  it("creates the offer with the chosen property and amount", async () => {
    const user = await openAdvanceModal();
    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() => expect(addOffer).toHaveBeenCalledTimes(1));
    expect(addOffer.mock.calls[0][0]).toMatchObject({
      trackedPropertyId: "prop-1",
      offerPrice: 340000,
    });
  });

  it("writes the offer only AFTER the stage patch succeeds", async () => {
    patchStage.mockRejectedValue(new Error("nope"));
    const user = await openAdvanceModal();

    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() => expect(patchStage).toHaveBeenCalled());
    expect(addOffer).not.toHaveBeenCalled();
  });

  it("cannot confirm the advance without a property and an amount", async () => {
    const user = userEvent.setup();
    render(<DealDetail />);
    await user.click(screen.getByRole("button", { name: /offer active/i }));

    const confirm = await screen.findByRole("button", { name: /confirm & advance/i });
    expect(confirm).toBeDisabled();

    await user.click(confirm);
    expect(patchStage).not.toHaveBeenCalled();
    expect(addOffer).not.toHaveBeenCalled();
  });

  it("a failed offer save never breaks the advance and surfaces a warning", async () => {
    addOffer.mockRejectedValue(new Error("network down"));
    const user = await openAdvanceModal();

    await user.click(screen.getByRole("button", { name: /confirm & advance/i }));

    await waitFor(() =>
      expect(patchStage).toHaveBeenCalledWith(DEAL_ID, "offer_active", undefined)
    );
    expect(
      await screen.findByText(/offer details could not be saved/i)
    ).toBeInTheDocument();
  });
});

// ─── Buyer's Progress — agent setter persists via the API (#184) ─────────────
// The old card wrote to an in-browser zustand map the seller could never see.
// The card must read the persisted value from the deal payload and PATCH
// /deals/:id/buyer-status so the seller portal (a different session) sees it.

describe("SellerBuyerStatusCard persists buyer status via the API (#184)", () => {
  function renderCard(overrides: Partial<Deal> = {}) {
    const onRefresh = vi.fn();
    const deal = makeDeal({ type: "sell", stage: "under_contract", ...overrides });
    render(<SellerBuyerStatusCard deal={deal} onRefresh={onRefresh} />);
    return { onRefresh };
  }

  it("shows the persisted status from the deal payload (not a client store)", () => {
    renderCard({ buyerStatus: "Inspection complete" });
    expect(screen.getByRole("combobox")).toHaveValue("Inspection complete");
  });

  it("PATCHes /deals/:id/buyer-status and refreshes the deal on change", async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderCard();

    await user.selectOptions(screen.getByRole("combobox"), "Appraisal ordered");

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/deals/${DEAL_ID}/buyer-status`, {
        buyer_status: "Appraisal ordered",
      })
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it("clearing back to '— Not set —' PATCHes null", async () => {
    const user = userEvent.setup();
    renderCard({ buyerStatus: "Appraisal ordered" });

    await user.selectOptions(screen.getByRole("combobox"), "");

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(`/deals/${DEAL_ID}/buyer-status`, {
        buyer_status: null,
      })
    );
  });

  it("a failed save surfaces an error and never claims success", async () => {
    vi.mocked(api.patch).mockRejectedValueOnce(new Error("network down"));
    const user = userEvent.setup();
    const { onRefresh } = renderCard();

    await user.selectOptions(screen.getByRole("combobox"), "Clear to close");

    expect(await screen.findByText(/could not (be )?sav/i)).toBeInTheDocument();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText(/currently showing/i)).not.toBeInTheDocument();
  });
});

// ─── Stage-advance modal — no fictional automation claims (#185) ─────────────

describe("StageAdvanceModal automation claims match reality (#185)", () => {
  const noop = () => {};

  it("under_contract: no 'TC alerted to open file' claim", () => {
    render(
      <StageAdvanceModal
        deal={makeDeal({ stage: "offer_active" })}
        nextStage="under_contract"
        gateError={null}
        onConfirm={noop}
        onCancel={noop}
      />
    );
    expect(screen.queryByText(/tc alerted/i)).not.toBeInTheDocument();
    // The honest items stay: auto tasks + the (now real) client message send.
    // #420 reworded them from the past tense — nothing has run yet.
    expect(screen.getByText(/auto-generate \d+ tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/post the client message to jane buyer/i)).toBeInTheDocument();
  });

  it("post_close: no 'Commission paperwork queued' claim", () => {
    render(
      <StageAdvanceModal
        deal={makeDeal({ stage: "closing" })}
        nextStage="post_close"
        gateError={null}
        onConfirm={noop}
        onCancel={noop}
      />
    );
    expect(screen.queryByText(/commission paperwork queued/i)).not.toBeInTheDocument();
  });

  it("pre_close keeps the real calendar-sync claim", () => {
    render(
      <StageAdvanceModal
        deal={makeDeal({ stage: "under_contract" })}
        nextStage="pre_close"
        gateError={null}
        onConfirm={noop}
        onCancel={noop}
      />
    );
    expect(screen.getByText(/sync the closing date to your calendar/i)).toBeInTheDocument();
  });

  it("clearing the draft removes the client-message line", async () => {
    const user = userEvent.setup();
    render(
      <StageAdvanceModal
        deal={makeDeal()}
        nextStage="offer_active"
        gateError={null}
        onConfirm={noop}
        onCancel={noop}
      />
    );
    expect(screen.getByText(/post the client message to jane buyer/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByRole("textbox"));

    expect(screen.queryByText(/post the client message/i)).not.toBeInTheDocument();
  });
});

// ─── Fast Pass / Smooth Exit enrollment cards (#426, US-08 of epic #441) ─────
//
// The agent could see that a client enrolled and what it cost, and nothing
// else: no add-ons, no payment option, no survey answers, and the card was not
// clickable. These render the two cards directly (rendering all of DealDetail's
// Overview tab drags in every other card for no benefit).
//
// Every asserted price is DERIVED from the shared catalogs, never typed here —
// a repricing like #430 must not need a test edit, and a hand-typed number is
// exactly how displayed copy drifts from what Stripe charges.

describe("FastPassCard — what the client bought (#426)", () => {
  const deepClean = FAST_PASS_UPSELLS.find((u) => u.id === "deep_clean")!;
  const utilitySetup = FAST_PASS_UPSELLS.find((u) => u.id === "utility_setup")!;

  const SURVEY = {
    currentSituation: "renting",
    targetMoveDate: "2026-09-15",
    dateFlexibility: "firm",
    moveSize: "3_bedroom",
    moverPreference: "full_service",
    packingPreference: "pack_for_me",
    utilities: ["Electric", "Internet"],
    notes: "Cat is scared of movers — call before arriving.",
  };

  function enrolledDeal(fp: Partial<NonNullable<Deal["fastPass"]>> = {}): Deal {
    return makeDeal({
      type: "buy",
      fastPass: {
        enrolledAt: "2026-08-27T15:00:00Z",
        status: "active",
        paymentOption: "at_closing",
        selectedUpsells: ["deep_clean", "utility_setup"],
        totalPaid: 2740,
        totalCents: 274000,
        paid: true,
        surveyAnswers: SURVEY,
        ...fp,
      },
    });
  }

  it("lists every selected add-on by display name and catalog price", () => {
    render(<FastPassCard deal={enrolledDeal()} />);

    expect(screen.getByText(deepClean.name)).toBeInTheDocument();
    expect(screen.getByText(utilitySetup.name)).toBeInTheDocument();
    expect(
      screen.getByText(`$${deepClean.price.toLocaleString()}`)
    ).toBeInTheDocument();
    expect(
      screen.getByText(`$${utilitySetup.price.toLocaleString()}`)
    ).toBeInTheDocument();

    // Add-ons the client did NOT buy stay off the card.
    expect(screen.queryByText("Rate Refi Monitoring")).not.toBeInTheDocument();
  });

  it("shows the payment option and the paid state", () => {
    render(<FastPassCard deal={enrolledDeal()} />);

    expect(screen.getByText(/at closing/i)).toBeInTheDocument();
    expect(screen.getByText(/^paid$/i)).toBeInTheDocument();
  });

  it("shows a promo code and its discount when one was applied", () => {
    render(
      <FastPassCard
        deal={enrolledDeal({ promoCode: "LAUNCH100", discountCents: 10000 })}
      />
    );

    expect(screen.getByText(/LAUNCH100/)).toBeInTheDocument();
    expect(screen.getByText(/−\$100/)).toBeInTheDocument();
  });

  it("opens a detail panel with the client's survey answers on click", async () => {
    const user = userEvent.setup();
    render(<FastPassCard deal={enrolledDeal()} />);

    // Collapsed by default — the notes are not on screen yet.
    expect(screen.queryByText(SURVEY.notes)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /fast pass details/i }));

    expect(await screen.findByText(SURVEY.notes)).toBeInTheDocument();
    expect(screen.getByText(/electric, internet/i)).toBeInTheDocument();
    expect(screen.getByText(/full service/i)).toBeInTheDocument();
  });

  it("a pending_payment enrollment reads as awaiting payment, not paid", () => {
    render(
      <FastPassCard
        deal={enrolledDeal({
          status: "pending_payment",
          paymentOption: null,
          paid: false,
        })}
      />
    );

    expect(screen.getByText(/awaiting payment/i)).toBeInTheDocument();
    // The add-ons they picked are still listed — they committed to them.
    expect(screen.getByText(deepClean.name)).toBeInTheDocument();
    // …but nothing may claim it is paid or that an option was chosen.
    expect(screen.queryByText(/^paid$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not chosen yet/i)).toBeInTheDocument();
  });

  it("a deal with no enrollment still shows the Enroll CTA", () => {
    render(<FastPassCard deal={makeDeal({ type: "buy" })} />);

    expect(
      screen.getByRole("button", { name: /enroll in fast pass/i })
    ).toBeInTheDocument();
  });

  it("is read-only — nothing on the card mutates the enrollment", async () => {
    const user = userEvent.setup();
    render(<FastPassCard deal={enrolledDeal()} />);

    for (const btn of screen.getAllByRole("button")) await user.click(btn);
    for (const btn of screen.getAllByRole("button")) await user.click(btn);

    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  // ── #464 (FF24): the price the client actually agreed to, per line ─────────
  //
  // #430 repriced deep_clean $197 → $425 the same day #426 shipped this card,
  // so an add-on bought last week renders at today's number next to a total
  // that still reflects last week's. The enrolment now stores the price it was
  // sold at; the card must render THAT, and must say so plainly when an older
  // enrolment has none.
  //
  // The historical price is a literal because it can only be a literal — it is
  // what the catalog said before the reprice, and the catalog no longer knows
  // it. Every CURRENT price below still comes from the catalog import.
  const AGREED_DEEP_CLEAN_CENTS = 19700; // deep_clean, pre-#430

  it("renders the price stored at enrolment, not today's catalog price (#464)", () => {
    render(
      <FastPassCard
        deal={enrolledDeal({
          upsellPrices: {
            deep_clean: AGREED_DEEP_CLEAN_CENTS,
            utility_setup: utilitySetup.price * 100,
          },
        })}
      />
    );

    expect(
      screen.getByText(`$${(AGREED_DEEP_CLEAN_CENTS / 100).toLocaleString()}`)
    ).toBeInTheDocument();
    // The catalog has moved since; today's number must not be on the card.
    expect(
      screen.queryByText(`$${deepClean.price.toLocaleString()}`)
    ).not.toBeInTheDocument();
    // And nothing hedges a figure we actually hold.
    expect(screen.queryAllByTestId("fp-unpriced-line")).toHaveLength(0);
  });

  it("a legacy enrolment marks its lines as today's list price, never as agreed (#464)", () => {
    // No `upsellPrices` — an enrolment persisted before this change.
    render(<FastPassCard deal={enrolledDeal()} />);

    // It still renders, and still lists what they bought.
    expect(screen.getByText(deepClean.name)).toBeInTheDocument();
    expect(screen.getByText(utilitySetup.name)).toBeInTheDocument();
    // Both lines are explicitly flagged as a current estimate…
    expect(screen.getAllByTestId("fp-unpriced-line")).toHaveLength(2);
    expect(screen.getAllByTestId("fp-unpriced-line")[0]).toHaveTextContent(
      /today's list/i
    );
    // …and the one figure presented as agreed is the stored total.
    expect(screen.getByText(/agreed total is \$2,740/i)).toBeInTheDocument();
  });

  it("flags only the lines whose price is missing (#464)", () => {
    render(
      <FastPassCard
        deal={enrolledDeal({ upsellPrices: { deep_clean: AGREED_DEEP_CLEAN_CENTS } })}
      />
    );

    // deep_clean is priced from the enrolment; utility_setup falls back.
    expect(screen.getAllByTestId("fp-unpriced-line")).toHaveLength(1);
    expect(
      screen.getByText(`$${(AGREED_DEEP_CLEAN_CENTS / 100).toLocaleString()}`)
    ).toBeInTheDocument();
  });

  it("never renders the Stripe checkout session id, stored prices or not (#426 guard)", () => {
    // The adapter drops this field (tests/unit/deal-adapter.test.ts holds that
    // guard — this file mocks @/hooks/useDeals, so the real adapter can't run
    // here). This is the second half: even handed one, the card renders nothing
    // that could put Stripe plumbing on an agent's screen.
    const deal = enrolledDeal({
      upsellPrices: { deep_clean: AGREED_DEEP_CLEAN_CENTS },
      ...({ checkoutSessionId: "cs_test_should_not_leak" } as unknown as Partial<
        NonNullable<Deal["fastPass"]>
      >),
    });

    const { container } = render(<FastPassCard deal={deal} />);
    expect(container.innerHTML).not.toContain("cs_test_should_not_leak");
    expect(container.innerHTML).not.toMatch(/checkout[_-]?session/i);
  });
});

describe("SmoothExitCard — what the seller bought (#426)", () => {
  const stagingConsult = SMOOTH_EXIT_UPSELLS.find((u) => u.id === "staging_consult")!;

  const SE_SURVEY = {
    nextStep: "downsizing" as const,
    estimatedSalePrice: 450000,
    moveOutDate: "2026-10-01",
    moverPreference: "full_service",
    wantsDeepClean: true,
    utilities: ["Electric"],
    notes: "Wants to stay through the holidays if possible.",
  };

  function enrolledSellDeal(): Deal {
    return makeDeal({
      type: "sell",
      smoothExit: {
        enrolledAt: "2026-08-27T15:00:00Z",
        status: "active",
        paymentOption: "from_proceeds",
        estimatedSalePrice: 450000,
        fee: 4500,
        buyingNext: false,
        selectedUpsells: ["staging_consult"],
        upsellTotalCents: 24700,
        upsellsPaid: true,
        surveyAnswers: SE_SURVEY,
      },
    });
  }

  it("lists the seller's add-ons by name and catalog price", () => {
    render(<SmoothExitCard deal={enrolledSellDeal()} />);

    expect(screen.getByText(stagingConsult.name)).toBeInTheDocument();
    expect(
      screen.getByText(`$${stagingConsult.price.toLocaleString()}`)
    ).toBeInTheDocument();
    expect(screen.getByText(/from sale proceeds/i)).toBeInTheDocument();
  });

  it("opens a detail panel with the seller's survey answers on click", async () => {
    const user = userEvent.setup();
    render(<SmoothExitCard deal={enrolledSellDeal()} />);

    expect(screen.queryByText(SE_SURVEY.notes)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /smooth exit details/i }));

    expect(await screen.findByText(SE_SURVEY.notes)).toBeInTheDocument();
    expect(screen.getByText(/downsizing/i)).toBeInTheDocument();
  });

  it("a sell deal with no enrollment still shows the Enroll CTA", () => {
    render(<SmoothExitCard deal={makeDeal({ type: "sell" })} />);

    expect(
      screen.getByRole("button", { name: /enroll in smooth exit/i })
    ).toBeInTheDocument();
  });
});

/**
 * ─── Pre-approval state, on the deal (#438) ──────────────────────────────────
 *
 * FF15. Once FF11–FF14 land the pre-approval state exists, but the agent could
 * only infer it: a task row that says nothing about whether the buyer acted,
 * plus a `pre_approved` toggle in the header that is only ever the LAST of the
 * three states. Paul's ask was "I want it easily noticed by the agent."
 *
 * The three states:
 *   not started  — a pre-approval task exists, nothing applied yet
 *   applied      — `preApprovalAppliedAt` set, `preApproved` still false
 *   pre-approved — `preApproved` true
 *
 * Keyed on the task's `source` (`'preapproval'`), NEVER on its title — #460
 * deliberately removed the copy from every structural position so it stays
 * rewordable. Matching on the sentence would put that trap straight back.
 */
describe("PreApprovalStatusCard — the three-way state (#438)", () => {
  function preApprovalTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-preapproval-1",
      dealId: DEAL_ID,
      title: "Get pre-approved with Mountain Mortgage",
      assignedTo: "buyer",
      assignedToId: "",
      status: "pending",
      priority: "high",
      source: "preapproval",
      stageContext: "active_search",
      ...overrides,
    };
  }

  /** A non-pre-approval task, to prove the card keys on `source` alone. */
  function otherTask(): Task {
    return preApprovalTask({ id: "task-other", source: "ai" });
  }

  function stateEl(): HTMLElement {
    return screen.getByTestId("pre-approval-state");
  }

  it("1. an open pre-approval task with no applied date renders 'not started'", () => {
    render(
      <PreApprovalStatusCard
        deal={makeDeal({ flags: ["mountain_mortgage"], preApproved: false })}
        tasks={[preApprovalTask()]}
      />
    );

    expect(stateEl()).toHaveAttribute("data-state", "not_started");
    expect(within(stateEl()).getByText(/not started/i)).toBeInTheDocument();
    // The other two states must not also be claimed.
    expect(within(stateEl()).queryByText(/applied/i)).not.toBeInTheDocument();
    expect(within(stateEl()).queryByText(/^pre-approved$/i)).not.toBeInTheDocument();
  });

  it("2. an applied date with pre_approved false renders 'applied', with the date", () => {
    render(
      <PreApprovalStatusCard
        deal={makeDeal({
          flags: ["mountain_mortgage"],
          preApproved: false,
          preApprovalAppliedAt: "2026-08-12T12:00:00Z",
        })}
        tasks={[preApprovalTask()]}
      />
    );

    expect(stateEl()).toHaveAttribute("data-state", "applied");
    expect(within(stateEl()).getByText(/applied/i)).toBeInTheDocument();
    // The date is the whole point of this state — an agent chasing a buyer
    // needs to know whether "applied" was yesterday or five weeks ago.
    expect(within(stateEl()).getByText(/Aug 12, 2026/)).toBeInTheDocument();
    expect(within(stateEl()).queryByText(/not started/i)).not.toBeInTheDocument();
  });

  it("3. pre_approved true renders 'pre-approved', outranking a stale applied date", () => {
    render(
      <PreApprovalStatusCard
        deal={makeDeal({
          flags: ["mountain_mortgage"],
          preApproved: true,
          preApprovalAppliedAt: "2026-08-12T12:00:00Z",
        })}
        tasks={[preApprovalTask({ status: "completed" })]}
      />
    );

    expect(stateEl()).toHaveAttribute("data-state", "pre_approved");
    expect(within(stateEl()).getByText(/pre-approved/i)).toBeInTheDocument();
    expect(within(stateEl()).queryByText(/not started/i)).not.toBeInTheDocument();
  });

  it("4. a cash buyer with no pre-approval task renders nothing and does not throw", () => {
    const { container } = render(
      <PreApprovalStatusCard
        deal={makeDeal({ financingType: "cash", preApproved: false })}
        tasks={[otherTask()]}
      />
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("pre-approval-state")).not.toBeInTheDocument();
  });

  it("4b. a financed deal with no pre-approval task and no state renders nothing", () => {
    const { container } = render(
      <PreApprovalStatusCard deal={makeDeal({ preApproved: false })} tasks={[otherTask()]} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("4c. a sell deal never shows a pre-approval card", () => {
    const { container } = render(
      <PreApprovalStatusCard
        deal={makeDeal({ type: "sell", preApproved: true })}
        tasks={[preApprovalTask()]}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("4d. an empty task list is safe", () => {
    const { container } = render(
      <PreApprovalStatusCard deal={makeDeal()} tasks={[]} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("names the lender so the agent knows who is involved without digging", () => {
    render(
      <PreApprovalStatusCard
        deal={makeDeal({ flags: ["mountain_mortgage"] })}
        tasks={[preApprovalTask()]}
      />
    );

    // Reuses FLAG_LABELS.mountain_mortgage rather than hand-typing a label.
    expect(screen.getByText(FLAG_LABELS.mountain_mortgage)).toBeInTheDocument();
  });
});

/**
 * ─── The header pill and the Overview card must agree (#437 + #438) ──────────
 *
 * #437 put the buyer's "Applied {date}" on the deal header's pre-approval
 * TOGGLE; #438 puts the same three-way state on the Overview tab. Both are on
 * screen at once, so a disagreement is a bug the agent has to adjudicate — and
 * there was one: an un-started pre-approval was amber in the header and red on
 * the card. The header now takes its colour from the same shared palette.
 *
 * #437's invariant is the thing to protect: green — and ONLY green — means the
 * offer gate is open, which only agent-set `preApproved` produces. A buyer's
 * own "I applied" must never turn this pill green.
 */
describe("DealHeader — pre-approval colour matches the Overview card (#438)", () => {
  function headerPill(): HTMLElement {
    return screen.getByRole("button", {
      name: /pre-approved|applied/i,
    });
  }

  it("not started: red in the header, red on the card", () => {
    render(<DealHeader deal={makeDeal({ preApproved: false })} />);
    expect(headerPill().className).toContain("bg-red-100");
    expect(headerPill().className).not.toContain("green");
  });

  it("applied: amber in the header, and NOT green — the gate is still shut", () => {
    render(
      <DealHeader
        deal={makeDeal({ preApproved: false, preApprovalAppliedAt: "2026-08-12T12:00:00Z" })}
      />
    );

    const pill = headerPill();
    expect(pill.textContent).toMatch(/Applied/);
    expect(pill.className).toContain("bg-amber-100");
    // #437's invariant.
    expect(pill.className).not.toContain("green");
  });

  it("pre-approved: green, the one state that opens the offer gate", () => {
    render(<DealHeader deal={makeDeal({ preApproved: true })} />);
    expect(headerPill().className).toContain("bg-green-100");
  });

  it("an unparseable applied date falls back to not-started, colour included", () => {
    // The label already degraded to "Pre-approved?"; the colour must degrade
    // with it, or the pill reads amber while saying it never started.
    render(
      <DealHeader deal={makeDeal({ preApproved: false, preApprovalAppliedAt: "not-a-date" })} />
    );

    const pill = headerPill();
    expect(pill.textContent).toMatch(/Pre-approved\?/);
    expect(pill.className).toContain("bg-red-100");
  });

  it("header and Overview card render the SAME state class for one deal", () => {
    const deal = makeDeal({
      preApproved: false,
      preApprovalAppliedAt: "2026-08-12T12:00:00Z",
      flags: ["mountain_mortgage"],
    });
    const task: Task = {
      id: "t-agree", dealId: DEAL_ID, title: "x", assignedTo: "buyer", assignedToId: "",
      status: "pending", priority: "high", source: "preapproval",
      stageContext: "active_search",
    };
    render(
      <>
        <DealHeader deal={deal} />
        <PreApprovalStatusCard deal={deal} tasks={[task]} />
      </>
    );

    expect(screen.getByTestId("pre-approval-state")).toHaveAttribute("data-state", "applied");
    expect(headerPill().className).toContain("bg-amber-100");
  });
});

/**
 * ─── #438 regression guard: `mountain_mortgage` is load-bearing ──────────────
 *
 * The flag drives `isLinked` inside LoanMilestonesCard, which decides whether
 * the agent sees "ARIVE loan linked — milestones syncing" or the manual
 * link-a-loan-ID form. FF15 READS that flag for its lender label; it must never
 * repurpose or overload it. `apiDealToFrontend` sets the flag from
 * `arive_linked`, so this is the ARIVE round trip in one assertion.
 */
describe("LoanMilestonesCard — mountain_mortgage still drives ARIVE linkage (#438)", () => {
  it("a flagged buy deal reads as ARIVE-linked", () => {
    render(<LoanMilestonesCard deal={makeDeal({ flags: ["mountain_mortgage"] })} />);

    expect(screen.getByText(/arive loan linked/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync/i })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/arive loan id/i)).not.toBeInTheDocument();
  });

  it("an unflagged buy deal still offers the manual ARIVE link form", () => {
    render(<LoanMilestonesCard deal={makeDeal({ flags: [] })} />);

    expect(screen.getByPlaceholderText(/arive loan id/i)).toBeInTheDocument();
    expect(screen.queryByText(/arive loan linked/i)).not.toBeInTheDocument();
  });

  it("the pre-approval card does not change what the flag means to ARIVE", () => {
    // Both cards rendered against ONE deal — the state the agent actually sees.
    const deal = makeDeal({
      flags: ["mountain_mortgage"],
      preApproved: false,
      preApprovalAppliedAt: "2026-08-12T12:00:00Z",
    });
    const task: Task = {
      id: "t1",
      dealId: DEAL_ID,
      title: "x",
      assignedTo: "buyer",
      assignedToId: "",
      status: "pending",
      priority: "high",
      source: "preapproval",
      stageContext: "active_search",
    };
    render(
      <>
        <PreApprovalStatusCard deal={deal} tasks={[task]} />
        <LoanMilestonesCard deal={deal} />
      </>
    );

    expect(screen.getByTestId("pre-approval-state")).toHaveAttribute("data-state", "applied");
    expect(screen.getByText(/arive loan linked/i)).toBeInTheDocument();
  });
});
