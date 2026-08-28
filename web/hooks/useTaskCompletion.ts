"use client";

import { useCallback, useState } from "react";
import { patchTaskStatus } from "@/hooks/useTasks";

/**
 * Shared task-completion logic for the buyer & seller portals.
 *
 * Clients used to fake completion with a write-only `completedIds` Set and no
 * API call (#79). This hook does the real thing: it optimistically marks the
 * task done, calls patchTaskStatus(id, 'completed') so the agent/TC see it and
 * it survives a reload, then refetches so the server is the source of truth.
 * On failure it rolls the optimistic check back and surfaces a visible error.
 *
 * `completedIds` is the in-flight optimistic layer the list filters on; once the
 * refetch lands the task's real status is 'completed' too, so a task can be in
 * both. Callers must treat "done" as the UNION (`status === 'completed' ||
 * completedIds.has(id)`) and partition their task array on it — never add the
 * two counts, or a refetched completion is counted twice.
 *
 * `uncomplete` (#408) is the undo. A client who mis-tapped "Yes, I'm done" had
 * no way back — the row vanished from the list and `TaskCard` was `disabled`.
 * It PATCHes the task to 'pending', which is what makes the deal's open-task
 * count, health, and the forward-advance gate recover server-side.
 *
 * Undo is deliberately NOT optimistic for a task the server already has as
 * 'completed': there is no second "re-opened" set, so the row simply stays
 * shown as done until the refetch lands. That keeps the two states honest
 * (nothing claims to be re-opened before the PATCH returns) and means a failed
 * undo has nothing to roll back. For a task that was only optimistically
 * complete, dropping it from `completedIds` returns it to the open list
 * immediately, and a failure puts it back.
 */
export function useTaskCompletion(refetch?: () => void): {
  completedIds: Set<string>;
  error: string | null;
  clearError: () => void;
  complete: (id: string) => Promise<void>;
  uncomplete: (id: string) => Promise<void>;
} {
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const complete = useCallback(
    async (id: string) => {
      setError(null);
      // Optimistic: check it off immediately.
      setCompletedIds((prev) => new Set(prev).add(id));
      try {
        await patchTaskStatus(id, "completed");
        refetch?.();
      } catch {
        // Roll the optimistic check back and tell the user.
        setCompletedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setError("Couldn't mark that task complete. Please try again.");
      }
    },
    [refetch],
  );

  const uncomplete = useCallback(
    async (id: string) => {
      setError(null);
      // Drop any optimistic completion so a task the client only just ticked
      // goes straight back to the open list. A server-'completed' task is not
      // in this set, so it stays shown as done until the refetch lands.
      setCompletedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      try {
        await patchTaskStatus(id, "pending");
        refetch?.();
      } catch {
        // Re-assert "done" and tell the user. Safe either way: for a
        // server-completed task this is a no-op the next refetch confirms.
        setCompletedIds((prev) => new Set(prev).add(id));
        setError("Couldn't re-open that task. Please try again.");
      }
    },
    [refetch],
  );

  return {
    completedIds,
    error,
    clearError: useCallback(() => setError(null), []),
    complete,
    uncomplete,
  };
}
