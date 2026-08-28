// @vitest-environment happy-dom
/**
 * Regression test for buyer/seller portal task completion (#79 / T11).
 *
 * The buyer & seller portals faked their core action: `handleComplete` only
 * did `setCompletedIds((prev) => new Set([...prev, id]))` — a write-only local
 * Set, NO API call. So the agent/TC never saw the completion and it reappeared
 * on reload. The handler must instead call patchTaskStatus(taskId, 'completed')
 * so the server is the source of truth, optimistically check the task, roll the
 * check back on failure, and surface a visible error (never a silent success).
 *
 * This renders the real BuyerView container with its data hooks mocked and
 * drives the actual TaskCard confirm button the buyer clicks. On the OLD code
 * the patchTaskStatus assertion fails (handleComplete never calls it).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import type { ReactElement } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@/lib/types";
import type { MyDeal } from "@/hooks/useMyDeals";

// ── Mocks ────────────────────────────────────────────────────────────────────
// Child components that pull their own data hooks (and would otherwise need a
// QueryClient / Auth0 context) are stubbed to nothing — they're irrelevant to
// task completion and keep the render light.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ClientNotifications", () => ({ default: () => null }));
vi.mock("@/components/VendorDirectory", () => ({ default: () => null }));
vi.mock("@/components/MetroMap", () => ({ default: () => null }));

vi.mock("@/lib/store/authStore", () => ({
  useAuthStore: (sel: (s: { activeUser: { name: string } }) => unknown) =>
    sel({ activeUser: { name: "Jane Buyer" } }),
}));

// Deals + tasks hooks return canned data; patchTaskStatus is the spy under test.
const mockRefreshTasks = vi.fn();
let mockTasks: Task[] = [];
vi.mock("@/hooks/useMyDeals", () => ({
  useMyDeals: () => ({ deals: [makeDeal()], loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ tasks: mockTasks, loading: false, refresh: mockRefreshTasks }),
  patchTaskStatus: vi.fn(),
}));
// Messages/Documents tabs aren't exercised here but the module is imported.
vi.mock("@/hooks/useMessages", () => ({
  useMessages: () => ({ messages: [], loading: false, refresh: vi.fn() }),
  postMessage: vi.fn(),
}));
// Documents hook: the upload tests spy on the presigned-flow functions.
vi.mock("@/hooks/useDocuments", () => ({
  useDocuments: () => ({ docs: [], loading: false, error: null, refresh: vi.fn() }),
  getDownloadUrl: vi.fn(),
  requestUploadUrl: vi.fn(),
  confirmUpload: vi.fn(),
}));
// BuyerView now reads notifications for the Messages tab badge (#294). Stub the
// hook so its poll doesn't fire a real fetch('/api/notifications') — these tests
// spy on global fetch to assert the upload byte-path, and that count must stay clean.
vi.mock("@/hooks/useNotifications", () => ({
  useNotifications: () => ({
    notifications: [],
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    refresh: vi.fn(),
  }),
}));
// #189 — the direct-to-Blob byte path, mocked at the SDK boundary so the real
// lib/direct-upload logic (direct upload, proxy fallback) runs in these tests.
const uploadPresignedMock = vi.fn();
vi.mock("@vercel/blob/client", () => ({
  uploadPresigned: (...a: unknown[]) => uploadPresignedMock(...a),
}));

import BuyerView from "@/components/pages/buyer/BuyerView";
import { patchTaskStatus } from "@/hooks/useTasks";
import { requestUploadUrl, confirmUpload } from "@/hooks/useDocuments";

const mockPatch = patchTaskStatus as Mock;
const mockRequestUploadUrl = requestUploadUrl as Mock;
const mockConfirmUpload = confirmUpload as Mock;

const DEAL_ID = "5f0f6f6a-9b1c-4f6e-8a2d-3c4b5a697e01";
const TASK_ID = "a1b2c3d4-0000-4f6e-8a2d-3c4b5a697e22";

/**
 * BuyerView now calls useQueryClient (to invalidate the documents query after a
 * task upload), so it must render under a QueryClientProvider. The data hooks
 * are still mocked above — this client only services that invalidation.
 */
function renderBuyer(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

function makeDeal(): MyDeal {
  return {
    id: DEAL_ID,
    type: "buy",
    clientName: "Jane Buyer",
    clientId: "",
    agentId: "agent-1",
    stage: "offer_active", // OfferActiveCard is pure — no extra data hooks
    health: "green",
    priority: "medium",
    property: { address: "123 Main St", city: "Birmingham", state: "AL", zip: "35203", price: 350000 },
    timeline: { createdAt: "2026-05-01T00:00:00Z", daysInStage: 2 },
    flags: [],
    status: "active",
    estimatedCommission: 10500,
    openTaskCount: 1,
    overdueTaskCount: 0,
    agentName: "Sarah Johnson",
    agentEmail: "sarah@realtourflow.com",
    agentPhone: null,
  } as MyDeal;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    dealId: DEAL_ID,
    title: "Send your bank statements",
    assignedTo: "buyer",
    assignedToId: "buyer-1",
    status: "pending",
    priority: "medium",
    source: "manual",
    stageContext: "offer_active",
    actionType: "confirm",
    ...overrides,
  };
}

/** Expand the task row, then click the "Yes, I'm done" confirm button. */
function confirmTask() {
  fireEvent.click(screen.getByText("Send your bank statements"));
  fireEvent.click(screen.getByText(/Yes, I.?m done/));
}

beforeEach(() => {
  mockPatch.mockReset();
  mockRefreshTasks.mockReset();
  mockRequestUploadUrl.mockReset();
  mockConfirmUpload.mockReset();
  uploadPresignedMock.mockReset();
  mockTasks = [makeTask()];
});

describe("Buyer portal task completion", () => {
  it("calls patchTaskStatus(taskId, 'completed') exactly once when a task is confirmed", async () => {
    mockPatch.mockResolvedValue(undefined);
    renderBuyer(<BuyerView />);

    confirmTask();

    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith(TASK_ID, "completed");
  });

  it("refetches tasks after a successful completion so the server is the source of truth", async () => {
    mockPatch.mockResolvedValue(undefined);
    renderBuyer(<BuyerView />);

    confirmTask();

    await waitFor(() => expect(mockRefreshTasks).toHaveBeenCalled());
  });

  it("optimistically checks the task off immediately on click", () => {
    mockPatch.mockReturnValue(new Promise(() => {})); // never resolves — stays in-flight
    renderBuyer(<BuyerView />);

    confirmTask();

    // The optimistic update moves the task out of the OPEN list right away…
    expect(screen.getByText(/All caught up/)).toBeTruthy();
    // …and into the completed list, where it stays visible and re-openable
    // (#408 — it used to disappear entirely, with no way back).
    expect(screen.getByText(/1 task completed/)).toBeTruthy();
    expect(screen.getByText(/Marked complete/)).toBeTruthy();
  });

  it("rolls the optimistic check back AND shows an error when patchTaskStatus rejects", async () => {
    mockPatch.mockRejectedValue(new Error("500 — boom"));
    renderBuyer(<BuyerView />);

    confirmTask();

    // Error surfaced to the user…
    await screen.findByText(/couldn[’']t|could not|try again|failed/i);
    // …and the task is back in the open list (rollback), not silently "done".
    expect(screen.getByText("Send your bank statements")).toBeTruthy();
  });
});

/**
 * #408 — the client half of the one-way-door bug. `openTasks` filters completed
 * tasks out of the list entirely and `TaskCard` set `disabled={isDone}`, so a
 * buyer who mis-tapped "Yes, I'm done" had no way back: the row vanished and
 * the only trace was a "1 task completed" counter.
 *
 * Completed tasks now render (below the open ones) and clicking one PATCHes it
 * back to 'pending', which is what recovers the deal's open-task count, health,
 * and — deliberately — the stage gate. See tests/api/task-uncomplete.test.ts.
 */
describe("Buyer portal task un-completion (#408)", () => {
  beforeEach(() => {
    mockTasks = [makeTask({ status: "completed" })];
  });

  // Case 1 — fails against the old code: completed tasks were never rendered.
  it("still renders a completed task instead of hiding it", () => {
    renderBuyer(<BuyerView />);

    expect(screen.getByText("Send your bank statements")).toBeTruthy();
    expect(screen.getByText(/1 task completed/)).toBeTruthy();
  });

  // Case 2 — fails against the old code: the row was `disabled`.
  it("PATCHes a completed task back to 'pending' when the buyer taps it", async () => {
    mockPatch.mockResolvedValue(undefined);
    renderBuyer(<BuyerView />);

    fireEvent.click(screen.getByText("Send your bank statements"));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith(TASK_ID, "pending");
  });

  it("refetches after a successful un-complete so the server is the source of truth", async () => {
    mockPatch.mockResolvedValue(undefined);
    renderBuyer(<BuyerView />);

    fireEvent.click(screen.getByText("Send your bank statements"));

    await waitFor(() => expect(mockRefreshTasks).toHaveBeenCalled());
  });

  it("surfaces an error and leaves the task complete when the un-complete fails", async () => {
    mockPatch.mockRejectedValue(new Error("500 — boom"));
    renderBuyer(<BuyerView />);

    fireEvent.click(screen.getByText("Send your bank statements"));

    await screen.findByText(/couldn[’']t|could not|try again|failed/i);
    // Still shown as done — an un-complete that never landed must not look done.
    expect(screen.getByText(/1 task completed/)).toBeTruthy();
  });

  it("un-completes a task the buyer only just optimistically completed", async () => {
    mockTasks = [makeTask()]; // still 'pending' server-side
    mockPatch.mockResolvedValue(undefined);
    renderBuyer(<BuyerView />);

    confirmTask();
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith(TASK_ID, "completed"));

    // The optimistic check moved it into the completed list — tap it to undo.
    fireEvent.click(screen.getByText("Send your bank statements"));

    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith(TASK_ID, "pending"));
    // Back in the open list right away (it was never completed server-side).
    expect(screen.queryByText(/task completed/)).toBeNull();
  });
});

describe("Buyer portal document upload (upload task)", () => {
  const UPLOAD_URL = "https://s3.example.com/put?sig=abc";
  const S3_KEY = "deals/x/uploads/letter.pdf";

  function makeFile() {
    return new File(["hello"], "preapproval.pdf", { type: "application/pdf" });
  }

  /** Expand an upload task and return its hidden <input type=file>. */
  function openUploadInput(container: HTMLElement): HTMLInputElement {
    fireEvent.click(screen.getByText("Upload your pre-approval letter"));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    return input;
  }

  beforeEach(() => {
    mockTasks = [makeTask({ title: "Upload your pre-approval letter", actionType: "upload" })];
  });

  it("routes the file through the real presigned flow (requestUploadUrl → PUT → confirmUpload)", async () => {
    mockRequestUploadUrl.mockResolvedValue({ upload_url: UPLOAD_URL, s3_key: S3_KEY });
    mockConfirmUpload.mockResolvedValue({ id: "doc-1" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const { container, client } = renderBuyer(<BuyerView />);
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const input = openUploadInput(container);
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => expect(mockConfirmUpload).toHaveBeenCalledTimes(1));
    expect(mockRequestUploadUrl).toHaveBeenCalledWith(DEAL_ID, "preapproval.pdf", "application/pdf");
    // The S3 PUT used the presigned URL the API handed back.
    const putUrl = fetchSpy.mock.calls[0]?.[0];
    expect(putUrl).toBe(UPLOAD_URL);
    expect(mockConfirmUpload).toHaveBeenCalledWith(
      DEAL_ID, "preapproval.pdf", S3_KEY, "application/pdf", expect.any(Number),
    );
    // Real success state, not a fake spinner.
    expect(await screen.findByText(/uploaded successfully/i)).toBeTruthy();
    // The Documents tab is invalidated so the new doc shows up in-session.
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["documents", DEAL_ID] }),
    );

    fetchSpy.mockRestore();
  });

  it("shows an error — never a fake 'uploaded' state — when the upload fails", async () => {
    mockRequestUploadUrl.mockRejectedValue(new Error("no presigned url"));

    const { container } = renderBuyer(<BuyerView />);
    const input = openUploadInput(container);
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await screen.findByText(/upload failed/i);
    expect(screen.queryByText(/uploaded successfully/i)).toBeNull();
    expect(mockConfirmUpload).not.toHaveBeenCalled();
  });

  // ── Direct-to-Blob upload (#189) ───────────────────────────────────────────
  // When the server returns a client_upload_url, the portal upload must push
  // the bytes straight to Blob (no ~4.5MB function proxy in the byte path).

  it("uses the direct-to-blob path when the server returns client_upload_url (#189)", async () => {
    const CLIENT_UPLOAD_URL = "/api/storage/client-upload?key=k&exp=1&sig=s";
    mockRequestUploadUrl.mockResolvedValue({
      upload_url: UPLOAD_URL,
      client_upload_url: CLIENT_UPLOAD_URL,
      s3_key: S3_KEY,
    });
    mockConfirmUpload.mockResolvedValue({ id: "doc-1" });
    uploadPresignedMock.mockResolvedValue({ pathname: S3_KEY });
    // Never let a wrong code path reach the real network.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 500 }));

    const { container } = renderBuyer(<BuyerView />);
    const input = openUploadInput(container);
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => expect(mockConfirmUpload).toHaveBeenCalledTimes(1));
    // The SDK carried the bytes, pinned to the server-minted key…
    expect(uploadPresignedMock).toHaveBeenCalledWith(
      S3_KEY,
      expect.any(File),
      expect.objectContaining({
        access: "private",
        handleUploadUrl: CLIENT_UPLOAD_URL,
        contentType: "application/pdf",
      }),
    );
    // …and the file never went through the app's own fetch (the 4.5MB proxy).
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await screen.findByText(/uploaded successfully/i)).toBeTruthy();

    fetchSpy.mockRestore();
  });

  it("a failed direct upload with a failed fallback never confirms (#189)", async () => {
    mockRequestUploadUrl.mockResolvedValue({
      upload_url: UPLOAD_URL,
      client_upload_url: "/api/storage/client-upload?key=k&exp=1&sig=s",
      s3_key: S3_KEY,
    });
    uploadPresignedMock.mockRejectedValue(new Error("blob api down"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 500 }));

    const { container } = renderBuyer(<BuyerView />);
    const input = openUploadInput(container);
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await screen.findByText(/upload failed/i);
    expect(screen.queryByText(/uploaded successfully/i)).toBeNull();
    expect(mockConfirmUpload).not.toHaveBeenCalled();
    // The proxy fallback was attempted before giving up.
    expect(fetchSpy).toHaveBeenCalledWith(UPLOAD_URL, expect.objectContaining({ method: "PUT" }));

    fetchSpy.mockRestore();
  });
});
