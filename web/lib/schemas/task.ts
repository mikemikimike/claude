/**
 * Task wire contracts (#88): request bodies for task create/patch and the
 * ApiTask response schema. Client-safe: zod only.
 *
 * Semantic checks stay in the handlers (their 400 messages are asserted in
 * tests): title emptiness, YYYY-MM-DD due-date format, the status
 * whitelist, and deal-membership of assignees.
 */
import { z } from "zod";

/** POST /api/deals/[id]/tasks */
export const createTaskBodySchema = z.object({
  title: z.string().nullish(),
  description: z.string().nullish(),
  priority: z.enum(["high", "medium", "low"]).nullish(),
  source: z.enum(["ai", "manual"]).nullish(),
  stage_context: z.string().nullish(),
  role: z.enum(["agent", "buyer", "seller", "tc", "admin", "third_party"]).nullish(),
  due_date: z.string().nullish(),
  assigned_to: z.string().nullish(),
});
export type CreateTaskBody = z.output<typeof createTaskBodySchema>;

/**
 * PATCH /api/tasks/[id]/status — accepts any combination of the editable
 * fields (#187 status/due_date/assigned_to; #255 `role`, the agent/tc/buyer/
 * seller/third_party/admin bucket the Tasks-tab reassign dropdown changes).
 * "no fields to update" presence check + the role whitelist stay in the
 * handler (zod preserves key presence for JSON inputs).
 */
export const patchTaskBodySchema = z.object({
  status: z.string().optional(),
  due_date: z.string().nullish(),
  assigned_to: z.string().nullish(),
  role: z.string().optional(),
});
export type PatchTaskBody = z.output<typeof patchTaskBodySchema>;

/** A task row as the API serializes it (`status::text`, `due_date::text`). */
export const apiTaskSchema = z.object({
  id: z.string(),
  deal_id: z.string(),
  assigned_to: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["pending", "in_progress", "completed", "skipped"]),
  priority: z.string(),
  source: z.string(),
  stage_context: z.string().nullable(),
  role: z.string(),
  due_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ApiTask = z.output<typeof apiTaskSchema>;

export const apiTaskListSchema = z.array(apiTaskSchema);
