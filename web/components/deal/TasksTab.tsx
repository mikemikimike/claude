"use client";

import { useState } from "react";
import { Deal, Task } from "@/lib/types";
import { usePermission } from "@/permissions/usePermission";
import { PERMISSIONS } from "@/permissions/permissions";
import { patchTaskStatus, patchTask, postTask } from "@/hooks/useTasks";
import { Calendar, CheckCircle2, CheckSquare, Bot, ChevronDown, Building2, Plus, Users } from "lucide-react";
import { TASK_STATUS_ICON } from "@/components/deal/shared";

const STATUS_SORT_ORDER: Record<string, number> = {
  overdue: 0, in_progress: 1, blocked: 2, pending: 3, completed: 4,
};

// Module-scope constants — moved out of TasksTab to satisfy
// react-hooks/static-components. Constant, no closures needed.
const STATUS_PILL: Record<string, string> = {
  completed:   'bg-green-100 text-green-700',
  in_progress: 'bg-blue-100 text-blue-700',
  overdue:     'bg-red-100 text-red-700',
  pending:     'bg-gray-100 text-gray-500',
  blocked:     'bg-orange-100 text-orange-700',
};

const ASSIGNEE_OPTIONS: { value: Task['assignedTo']; label: string; color: string }[] = [
  { value: 'agent',       label: 'Agent (Me)',      color: 'text-blue-700' },
  { value: 'buyer',       label: 'Buyer (Client)',  color: 'text-green-700' },
  { value: 'seller',      label: 'Seller (Client)', color: 'text-purple-700' },
  { value: 'tc',          label: 'TC',              color: 'text-amber-700' },
  { value: 'third_party', label: 'Third Party',     color: 'text-gray-600' },
];

const ASSIGNEE_LABEL: Record<string, string> = {
  agent: 'Agent', buyer: 'Buyer', seller: 'Seller', tc: 'TC', third_party: 'Third Party', admin: 'Admin',
};

// All the state + callbacks TaskItem and OwnerSection used to close over.
// Now passed as a single `ctx` prop so the components can live at module
// scope and satisfy react-hooks/static-components.
type TaskItemCtx = {
  completedIds: Set<string>;
  toggleComplete: (id: string) => void;
  effectiveStatus: (t: Task) => string;
  assigningTaskId: string | null;
  setAssigningTaskId: (id: string | null) => void;
  canAssign: boolean;
  // Persists the new role via PATCH then refetches — server is the source of
  // truth (#255), no browser-only override.
  reassign: (id: string, assignee: Task['assignedTo']) => void;
  // Due-date editing (#187) — agent/TC only; persists via PATCH.
  canEditDueDate: boolean;
  editingDueDateId: string | null;
  setEditingDueDateId: (id: string | null) => void;
  saveDueDate: (id: string, due: string | null) => void;
};

function TaskItem({ task, ctx }: { task: Task; ctx: TaskItemCtx }) {
  const { completedIds, toggleComplete, effectiveStatus, assigningTaskId, setAssigningTaskId, canAssign, reassign, canEditDueDate, editingDueDateId, setEditingDueDateId, saveDueDate } = ctx;
  const isDone = completedIds.has(task.id);
  const status = effectiveStatus(task);
  const assignee = task.assignedTo;
  const isAssigning = assigningTaskId === task.id;
  const isEditingDue = editingDueDateId === task.id;
  const [dueDraft, setDueDraft] = useState(task.dueDate ?? '');

  return (
    <div className={`flex items-start gap-3 rounded-lg px-3 py-3 transition-colors group ${isDone ? 'opacity-60' : 'hover:bg-brand-bg'}`}>
      <button
        onClick={() => toggleComplete(task.id)}
        className={`mt-0.5 flex-shrink-0 rounded-full transition-all ${
          isDone ? 'text-green-500 hover:text-gray-300' : 'text-gray-300 hover:text-green-400'
        }`}
        title={isDone ? 'Mark incomplete' : 'Mark complete'}
        // The icon carries no text, so name the control explicitly — this is
        // the only undo path for a completed task (#408).
        aria-label={isDone ? `Mark incomplete: ${task.title}` : `Mark complete: ${task.title}`}
      >
        {isDone
          ? <CheckCircle2 size={16} className="text-green-500" />
          : TASK_STATUS_ICON[status]}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 flex-wrap">
          <span className={`text-sm font-medium transition-colors ${isDone ? 'line-through text-gray-400' : 'text-brand-navy'}`}>
            {task.title}
          </span>
          {task.source === 'ai' && !isDone && (
            <span className="flex items-center gap-0.5 rounded-full bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-600">
              <Bot size={10} /> AI
            </span>
          )}
        </div>
        {task.description && !isDone && (
          <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">{task.description}</p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_PILL[status]}`}>
            {status.replace('_', ' ')}
          </span>
          {task.priority === 'high' && !isDone && (
            <span className="rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-semibold text-red-500 uppercase">High Priority</span>
          )}
          {!isDone && (canEditDueDate ? (
            isEditingDue ? (
              <span className="flex items-center gap-1">
                <input
                  type="date"
                  aria-label="New due date"
                  value={dueDraft}
                  onChange={(e) => setDueDraft(e.target.value)}
                  className="rounded border border-gray-200 px-1.5 py-0.5 text-[11px] text-gray-600"
                />
                <button
                  onClick={() => saveDueDate(task.id, dueDraft || null)}
                  className="rounded bg-brand-navy px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-brand-navy/90 transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingDueDateId(null)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                aria-label={task.dueDate ? 'Edit due date' : 'Set due date'}
                onClick={() => { setDueDraft(task.dueDate ?? ''); setEditingDueDateId(task.id); }}
                className="flex items-center gap-0.5 text-[11px] text-gray-400 hover:text-brand-navy transition-colors"
              >
                <Calendar size={10} /> {task.dueDate ?? 'Set due date'}
              </button>
            )
          ) : (
            task.dueDate && (
              <span className="flex items-center gap-0.5 text-[11px] text-gray-400">
                <Calendar size={10} /> {task.dueDate}
              </span>
            )
          ))}

          {/* Assign button — only for agent/admin */}
          {canAssign && !isDone && (
            <div className="relative ml-auto">
              <button
                onClick={() => setAssigningTaskId(isAssigning ? null : task.id)}
                className={[
                  'flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors',
                  isAssigning
                    ? 'border-brand-navy bg-brand-navy text-white'
                    : 'border-gray-200 bg-white text-gray-500 hover:border-brand-navy hover:text-brand-navy',
                ].join(' ')}
              >
                <Users size={10} />
                {ASSIGNEE_LABEL[assignee] ?? assignee}
                <ChevronDown size={9} />
              </button>

              {isAssigning && (
                <div className="absolute right-0 top-full mt-1 z-50 w-44 rounded-xl border border-gray-100 bg-white shadow-xl overflow-hidden">
                  <div className="px-3 py-2 border-b border-gray-50">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400">Assign to</p>
                  </div>
                  {ASSIGNEE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => reassign(task.id, opt.value)}
                      className={[
                        'flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs transition-colors hover:bg-brand-bg',
                        assignee === opt.value ? 'font-bold bg-brand-bg' : 'font-medium',
                        opt.color,
                      ].join(' ')}
                    >
                      {assignee === opt.value && <CheckCircle2 size={11} className="flex-shrink-0" />}
                      {assignee !== opt.value && <span className="w-[11px]" />}
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OwnerSection({
  label,
  sublabel,
  icon: Icon,
  tasks,
  ctx,
}: {
  label: string;
  sublabel: string;
  icon: React.ElementType;
  tasks: Task[];
  ctx: TaskItemCtx;
}) {
  const doneCount = tasks.filter((t) => ctx.completedIds.has(t.id)).length;
  const total = tasks.length;
  if (total === 0) return null;
  const allSectionDone = doneCount === total;
  return (
    <div className="rounded-xl bg-white shadow-sm overflow-hidden">
      {/* Section header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-brand-navy border-b border-brand-navy">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/10">
          <Icon size={14} className="text-brand-gold" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold leading-none text-white">{label}</div>
          <div className="text-[11px] mt-0.5 text-white/50">{sublabel}</div>
        </div>
        <div className="flex items-center gap-1.5">
          {allSectionDone && <CheckCircle2 size={13} className="text-green-400" />}
          <span className="text-xs font-bold text-brand-gold">{doneCount}/{total}</span>
        </div>
      </div>
      <div className="divide-y divide-gray-50">
        {tasks.map((t) => <TaskItem key={t.id} task={t} ctx={ctx} />)}
      </div>
    </div>
  );
}

// Exported for tests (see tests/components/tasks-tab.test.tsx).
export function TasksTab({ deal, tasks, onTasksChange }: { deal: Deal; tasks: Task[]; onTasksChange: () => void }) {
  const { can } = usePermission();
  const canAssign = can(PERMISSIONS.TASK_ASSIGN_ANY);
  const canCreate = can(PERMISSIONS.TASK_CREATE);
  const canEditDueDate = can(PERMISSIONS.TASK_EDIT);

  const [completedIds, setCompletedIds] = useState<Set<string>>(
    new Set(tasks.filter((t) => t.status === 'completed').map((t) => t.id))
  );
  const [assigningTaskId, setAssigningTaskId] = useState<string | null>(null);

  // Add-task form (#187)
  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newRole, setNewRole] = useState<Task['assignedTo']>('agent');
  const [newPriority, setNewPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [newDueDate, setNewDueDate] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Due-date editing (#187)
  const [editingDueDateId, setEditingDueDateId] = useState<string | null>(null);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const title = newTitle.trim();
    if (!title) {
      setCreateError('Title is required.');
      return;
    }
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      await postTask(deal.id, {
        title,
        priority: newPriority,
        role: newRole,
        source: 'manual',
        stage_context: deal.stage,
        ...(newDueDate ? { due_date: newDueDate } : {}),
      });
      setNewTitle('');
      setNewDueDate('');
      setNewRole('agent');
      setNewPriority('medium');
      setShowAddForm(false);
      onTasksChange();
    } catch {
      setCreateError("Couldn't add task. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function saveDueDate(taskId: string, due: string | null) {
    try {
      await patchTask(taskId, { due_date: due });
      setEditingDueDateId(null);
      onTasksChange();
    } catch {
      // keep the editor open so the agent can retry
    }
  }

  async function toggleComplete(id: string) {
    const willBeCompleted = !completedIds.has(id);
    const newStatus = willBeCompleted ? 'completed' : 'pending';
    setCompletedIds((prev) => {
      const next = new Set(prev);
      if (willBeCompleted) next.add(id); else next.delete(id);
      return next;
    });
    try {
      await patchTaskStatus(id, newStatus);
    } catch {
      setCompletedIds((prev) => {
        const next = new Set(prev);
        if (willBeCompleted) next.delete(id); else next.add(id);
        return next;
      });
    }
  }

  // Reassignment persists the task's `role` server-side then refetches, so the
  // agent↔TC handoff survives reload / other device / TC session (#255). It no
  // longer stashes the change in a browser-only zustand override.
  async function reassign(taskId: string, assignee: Task['assignedTo']) {
    setAssigningTaskId(null);
    try {
      await patchTask(taskId, { role: assignee });
      onTasksChange();
    } catch {
      // Leave the current grouping in place; the next refetch reflects the
      // server's truth so no stale optimistic state lingers.
    }
  }

  function effectiveStatus(t: Task) {
    return completedIds.has(t.id) ? 'completed' : t.status;
  }

  function sortByStatus(a: Task, b: Task) {
    return (STATUS_SORT_ORDER[effectiveStatus(a)] ?? 5) - (STATUS_SORT_ORDER[effectiveStatus(b)] ?? 5);
  }

  const agentTasks   = tasks.filter((t) => t.assignedTo === 'agent').sort(sortByStatus);
  const clientTasks  = tasks.filter((t) => t.assignedTo === 'buyer' || t.assignedTo === 'seller').sort(sortByStatus);
  const supportTasks = tasks.filter((t) => t.assignedTo === 'tc' || t.assignedTo === 'third_party' || t.assignedTo === 'admin').sort(sortByStatus);

  const ctx: TaskItemCtx = {
    completedIds,
    toggleComplete,
    effectiveStatus,
    assigningTaskId,
    setAssigningTaskId,
    canAssign,
    reassign,
    canEditDueDate,
    editingDueDateId,
    setEditingDueDateId,
    saveDueDate,
  };

  const allDone = tasks.length > 0 && completedIds.size === tasks.length;

  return (
    <div className="space-y-3">
      {/* Add task (#187) — agents/TCs create tasks with a due date so the
          deadline/health/calendar machinery has real data. */}
      {canCreate && (
        <div className="rounded-xl bg-white shadow-sm">
          {showAddForm ? (
            <form onSubmit={handleCreate} className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-brand-navy">New task</p>
                <button
                  type="button"
                  onClick={() => { setShowAddForm(false); setCreateError(null); }}
                  className="text-xs font-semibold text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
              <input
                type="text"
                aria-label="Task title"
                placeholder="Task title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-brand-navy placeholder:text-gray-300 focus:border-brand-navy focus:outline-none"
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Assignee"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as Task['assignedTo'])}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-600 focus:border-brand-navy focus:outline-none"
                >
                  {ASSIGNEE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <select
                  aria-label="Priority"
                  value={newPriority}
                  onChange={(e) => setNewPriority(e.target.value as 'high' | 'medium' | 'low')}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-600 focus:border-brand-navy focus:outline-none"
                >
                  <option value="high">High priority</option>
                  <option value="medium">Medium priority</option>
                  <option value="low">Low priority</option>
                </select>
                <input
                  type="date"
                  aria-label="Due date"
                  value={newDueDate}
                  onChange={(e) => setNewDueDate(e.target.value)}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-xs text-gray-600 focus:border-brand-navy focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={creating}
                  className="ml-auto rounded-lg bg-brand-navy px-4 py-1.5 text-xs font-semibold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-50"
                >
                  {creating ? 'Adding…' : 'Add task'}
                </button>
              </div>
              {createError && (
                <p className="text-xs font-medium text-red-500">{createError}</p>
              )}
            </form>
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex w-full items-center justify-center gap-1.5 px-4 py-3 text-sm font-semibold text-brand-navy hover:bg-brand-bg transition-colors rounded-xl"
            >
              <Plus size={14} /> Add Task
            </button>
          )}
        </div>
      )}

      {/* #408: the all-done state is a BANNER, never a replacement for the
          list. It used to render instead of the sections — and because
          `completedIds` is seeded from the server on mount, that empty state
          survived a reload, so the last task an agent ticked could never be
          un-ticked. The sections below always stay mounted; each already shows
          its own doneCount/total and a green check when it is fully done, so
          nothing about "everything is finished" is lost by keeping them. */}
      {allDone && (
        <div className="rounded-xl bg-white shadow-sm flex flex-col items-center py-8 gap-2">
          <CheckCircle2 size={36} className="text-green-400" />
          <p className="text-sm font-semibold text-green-700">All tasks complete</p>
          <p className="text-xs text-gray-400">Great work on this deal.</p>
        </div>
      )}

      <OwnerSection
        label="Your Tasks"
        sublabel="Action required from you"
        icon={CheckSquare}
        tasks={agentTasks}
        ctx={ctx}
      />
      <OwnerSection
        label="Client's Tasks"
        sublabel={`${deal.clientName} needs to complete these`}
        icon={Users}
        tasks={clientTasks}
        ctx={ctx}
      />
      <OwnerSection
        label="TC / Third Party"
        sublabel="Handled by your team or vendors"
        icon={Building2}
        tasks={supportTasks}
        ctx={ctx}
      />

    </div>
  );
}

// ─── Messages Tab ────────────────────────────────────────────────────────────
