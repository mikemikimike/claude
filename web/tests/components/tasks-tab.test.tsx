// @vitest-environment happy-dom
/**
 * TasksTab (DealDetail) — manual task creation + due-date editing (#187).
 *
 * Before this feature the tab rendered only auto-generated tasks: no way to
 * add a task or set a due date, so the deadline/health/calendar machinery
 * was permanently starved.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TasksTab } from "@/components/pages/agent/DealDetail";
import type { Deal, Task } from "@/lib/types";

const postTask = vi.fn();
const patchTask = vi.fn();
const patchTaskStatus = vi.fn();
vi.mock("@/hooks/useTasks", () => ({
  useTasks: vi.fn(() => ({ tasks: [], loading: false, refresh: vi.fn() })),
  useAgentTasks: vi.fn(() => ({ tasks: [], loading: false, refresh: vi.fn() })),
  postTask: (...a: unknown[]) => postTask(...a),
  patchTask: (...a: unknown[]) => patchTask(...a),
  patchTaskStatus: (...a: unknown[]) => patchTaskStatus(...a),
  apiTaskToFrontend: vi.fn(),
}));

// Grant every permission — server-side scoping is the security boundary;
// here we only exercise the agent UI.
vi.mock("@/permissions/usePermission", () => ({
  usePermission: () => ({
    can: () => true,
    canAny: () => true,
    canAll: () => true,
    currentGroup: "agent",
    hasPermission: () => true,
  }),
}));

const DEAL = {
  id: "deal-1",
  clientName: "Jane Doe",
  stage: "under_contract",
  type: "buy",
} as unknown as Deal;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    dealId: "deal-1",
    title: "Order title report",
    assignedTo: "agent",
    assignedToId: "",
    status: "pending",
    priority: "medium",
    source: "manual",
    stageContext: "under_contract",
    dueDate: "2026-07-20",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  postTask.mockResolvedValue(undefined);
  patchTask.mockResolvedValue(undefined);
  patchTaskStatus.mockResolvedValue(undefined);
});

describe("TasksTab — create task (#187)", () => {
  it("creates a task with title, priority, assignee, and due date", async () => {
    const user = userEvent.setup();
    const onTasksChange = vi.fn();
    render(<TasksTab deal={DEAL} tasks={[]} onTasksChange={onTasksChange} />);

    await user.click(screen.getByRole("button", { name: /add task/i }));

    await user.type(screen.getByLabelText(/task title/i), "Call the lender");
    await user.selectOptions(screen.getByLabelText(/assignee/i), "tc");
    await user.selectOptions(screen.getByLabelText(/priority/i), "high");
    fireEvent.change(screen.getByLabelText(/due date/i), {
      target: { value: "2026-08-01" },
    });

    await user.click(screen.getByRole("button", { name: /^add task$/i }));

    await waitFor(() =>
      expect(postTask).toHaveBeenCalledWith(
        "deal-1",
        expect.objectContaining({
          title: "Call the lender",
          priority: "high",
          role: "tc",
          due_date: "2026-08-01",
          source: "manual",
          stage_context: "under_contract",
        })
      )
    );
    expect(onTasksChange).toHaveBeenCalled();
  });

  it("does not submit without a title", async () => {
    const user = userEvent.setup();
    render(<TasksTab deal={DEAL} tasks={[]} onTasksChange={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /add task/i }));
    await user.click(screen.getByRole("button", { name: /^add task$/i }));

    expect(postTask).not.toHaveBeenCalled();
  });

  it("surfaces an error and keeps the form open when create fails", async () => {
    postTask.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    const onTasksChange = vi.fn();
    render(<TasksTab deal={DEAL} tasks={[]} onTasksChange={onTasksChange} />);

    await user.click(screen.getByRole("button", { name: /add task/i }));
    await user.type(screen.getByLabelText(/task title/i), "Call the lender");
    await user.click(screen.getByRole("button", { name: /^add task$/i }));

    expect(await screen.findByText(/couldn't add task/i)).toBeInTheDocument();
    expect(onTasksChange).not.toHaveBeenCalled();
    // Title preserved for retry.
    expect(screen.getByLabelText(/task title/i)).toHaveValue("Call the lender");
  });
});

/**
 * #408 — completing every task on a deal used to REPLACE the whole list with an
 * "All tasks complete" panel (`allDone ? <panel> : <sections>`). `completedIds`
 * is seeded from the server on mount, so the empty state survived a reload and
 * the rows never came back: completion was a one-way door with no UI undo.
 *
 * The panel is now a header ABOVE the sections, which stay mounted.
 */
describe("TasksTab — all-complete state stays un-doable (#408)", () => {
  const DONE_A = makeTask({ id: "task-1", title: "Order title report", status: "completed" });
  const DONE_B = makeTask({
    id: "task-2",
    title: "Send wire instructions",
    assignedTo: "tc",
    status: "completed",
  });

  // Case 1 — fails against the old code: the sections were unmounted entirely.
  it("keeps every task row rendered when all tasks are complete", () => {
    render(
      <TasksTab deal={DEAL} tasks={[DONE_A, DONE_B]} onTasksChange={vi.fn()} />
    );

    expect(screen.getByText("Order title report")).toBeInTheDocument();
    expect(screen.getByText("Send wire instructions")).toBeInTheDocument();
  });

  // Case 2 — fails against the old code: there was no toggle left to click.
  it("un-completes a task from the all-complete state, PATCHing it back to pending", async () => {
    const user = userEvent.setup();
    render(
      <TasksTab deal={DEAL} tasks={[DONE_A, DONE_B]} onTasksChange={vi.fn()} />
    );

    await user.click(screen.getAllByRole("button", { name: /mark incomplete/i })[0]);

    await waitFor(() =>
      expect(patchTaskStatus).toHaveBeenCalledWith("task-1", "pending")
    );
  });

  // Case 3 — no regression: a partially-done deal shows no congratulations.
  it("does not show the all-complete panel while a task is still open", () => {
    render(
      <TasksTab
        deal={DEAL}
        tasks={[DONE_A, makeTask({ id: "task-3", title: "Call the lender" })]}
        onTasksChange={vi.fn()}
      />
    );

    expect(screen.queryByText(/all tasks complete/i)).toBeNull();
    expect(screen.getByText("Order title report")).toBeInTheDocument();
    expect(screen.getByText("Call the lender")).toBeInTheDocument();
  });

  // Case 4 — the celebration still happens, it just no longer hides anything.
  it("shows the all-complete panel alongside the list when everything is done", () => {
    render(
      <TasksTab deal={DEAL} tasks={[DONE_A, DONE_B]} onTasksChange={vi.fn()} />
    );

    expect(screen.getByText(/all tasks complete/i)).toBeInTheDocument();
    expect(screen.getByText("Order title report")).toBeInTheDocument();
  });

  it("drops the all-complete panel as soon as one task is re-opened", async () => {
    const user = userEvent.setup();
    render(
      <TasksTab deal={DEAL} tasks={[DONE_A, DONE_B]} onTasksChange={vi.fn()} />
    );
    expect(screen.getByText(/all tasks complete/i)).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /mark incomplete/i })[0]);

    await waitFor(() => expect(screen.queryByText(/all tasks complete/i)).toBeNull());
    // …and the row the agent just re-opened is still on screen.
    expect(screen.getByText("Order title report")).toBeInTheDocument();
  });
});

describe("TasksTab — edit due date (#187)", () => {
  it("edits an existing task's due date", async () => {
    const user = userEvent.setup();
    const onTasksChange = vi.fn();
    render(
      <TasksTab deal={DEAL} tasks={[makeTask()]} onTasksChange={onTasksChange} />
    );

    await user.click(screen.getByRole("button", { name: /edit due date/i }));
    fireEvent.change(screen.getByLabelText(/new due date/i), {
      target: { value: "2026-09-15" },
    });
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(patchTask).toHaveBeenCalledWith("task-1", { due_date: "2026-09-15" })
    );
    expect(onTasksChange).toHaveBeenCalled();
  });

  it("offers 'Set due date' for a task without one", async () => {
    const user = userEvent.setup();
    render(
      <TasksTab
        deal={DEAL}
        tasks={[makeTask({ dueDate: undefined })]}
        onTasksChange={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /set due date/i }));
    fireEvent.change(screen.getByLabelText(/new due date/i), {
      target: { value: "2026-09-01" },
    });
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(patchTask).toHaveBeenCalledWith("task-1", { due_date: "2026-09-01" })
    );
  });
});
