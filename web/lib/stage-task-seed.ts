import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "./db";
import { stageAutoTasks, type AutoTaskDeal } from "./stage-auto-tasks";
import { autoTaskDueDate } from "./task-due-dates";

/**
 * The pre-approval task's identity (#460).
 *
 * `tasks.source` has always been free-form (`varchar(20) NOT NULL DEFAULT
 * 'manual'`, no CHECK constraint) and already carries two values: `'manual'`
 * for anything a human created and `'ai'` for the stage seeder's auto-tasks.
 * `'preapproval'` is a third, and it is what makes this task findable without
 * reading its copy.
 *
 * #434 shipped it as an `'ai'` task keyed on its TITLE, which made one English
 * sentence structural in two separate places — the idempotency guard below and
 * a hardcoded exception inside `seedStageAutoTasks`'s NOT EXISTS. Rewording it
 * (#435 renders this task to the buyer, so that is exactly where the instinct
 * lands) would have orphaned every existing row and inserted a duplicate beside
 * it on every already-onboarded deal.
 *
 * Two consequences worth knowing before changing this value:
 *   - `seedStageAutoTasks` counts only `source = 'ai'`, so this task is no
 *     longer in the set it looks at and cannot suppress the agent's
 *     `active_search` auto-tasks. That is why the title exception is gone.
 *   - The forward-advance gate's #445 exemption also covers only `'ai'`, so
 *     this task is NEVER treated as a stage leftover: it gates every forward
 *     advance out of Property Search until it is completed, skipped, or
 *     force-advanced past. Deliberate — the pre-approval has to be real before
 *     offers are written. Pinned by test 27 in tests/api/me-intake.test.ts.
 */
export const PRE_APPROVAL_TASK_SOURCE = "preapproval";

/**
 * The pre-approval task (#434).
 *
 * A buyer who picks Mountain Mortgage — or Fast Pass, which is the same lender
 * wrapped in the concierge service — used to be thrown out to the external 1003
 * application in the middle of the questionnaire, losing every answer they had
 * typed; a buyer who ignored that link was never asked again. The ask now lives
 * on their dashboard as a real task row, so the agent sees it too.
 *
 * This is COPY, and since #460 it is only copy: nothing keys off it. Reword it
 * freely — existing rows keep their old wording (there is deliberately no
 * migration or backfill), new ones get the new wording, and no deal ends up
 * with two. `PRE_APPROVAL_TASK_SOURCE` above is the identity.
 */
export const PRE_APPROVAL_TASK_TITLE = "Get pre-approved with Mountain Mortgage";

/**
 * Property Search — the stage the deal lands in after onboarding, and the stage
 * this task gates. An open high-priority task with this `stage_context` holds
 * the deal there on its first forward advance (#419/#445), which is intended:
 * the agent can complete it or force through.
 */
export const PRE_APPROVAL_TASK_STAGE = "active_search";

const PRE_APPROVAL_TASK_DESCRIPTION =
  "Getting your pre-approval letter is the next step — it tells you exactly what you can " +
  "spend and lets you make an offer the moment you find the right home.";

/**
 * Seed a stage's AI auto-tasks when a deal enters that stage (#87).
 *
 * Moved server-side from the browser: DealDetail used to loop POST /tasks after
 * the stage advance, so a tab closed mid-loop (or any non-UI caller) left an
 * advanced deal with missing tasks. The stage PATCH handler now seeds them in
 * one shot, next to the gate/history/contingency logic.
 *
 * Idempotent + race-safe, mirroring `seedStandardContingencies` (#186): a
 * single `INSERT ... SELECT ... WHERE NOT EXISTS` that only fires when the deal
 * has no AI task for this stage yet — so a retry, a double-submit, or a
 * re-entry into the stage never double-seeds. Per-stage default due dates match
 * the old client behavior via `autoTaskDueDate` (#187). No-op for stages with
 * no automation (the generator returns an empty list).
 */
export async function seedStageAutoTasks(
  dealId: string,
  stage: string,
  deal: AutoTaskDeal
): Promise<void> {
  const tasks = stageAutoTasks(stage, deal);
  if (tasks.length === 0) return;

  // Each row is fully cast so Postgres can infer the VALUES column types (a
  // bare parameter list in a standalone VALUES has no type context otherwise).
  const rows = tasks.map(
    (t) => Prisma.sql`(
      ${dealId}::uuid,
      ${t.title}::text,
      ${t.description ?? null}::text,
      ${t.priority}::varchar,
      'ai'::varchar,
      ${stage}::varchar,
      ${t.assignedTo}::varchar,
      ${autoTaskDueDate(stage, t.priority)}::date
    )`
  );

  await prisma.$executeRaw`
    INSERT INTO tasks (deal_id, title, description, priority, source, stage_context, role, due_date)
    SELECT * FROM (VALUES ${Prisma.join(rows)})
      AS v(deal_id, title, description, priority, source, stage_context, role, due_date)
    WHERE NOT EXISTS (
      SELECT 1 FROM tasks
      -- source = 'ai' is what "this stage already seeded itself" means, and it
      -- is the ONLY thing this guard reads. The pre-approval task (#434) also
      -- carries stage_context = active_search but is created by the intake
      -- write rather than by entering the stage; it used to be counted here,
      -- which made this seeder believe active_search was already done and
      -- silently swallow the agent's three real auto-tasks. #434 bought its way
      -- out with a hardcoded title inequality; #460 gave that task its own
      -- source instead, so it is simply not in this set. No exception needed —
      -- and nothing here depends on a user-facing string any more.
      WHERE deal_id = ${dealId}::uuid AND source = 'ai' AND stage_context = ${stage}
    )
  `;
}

/**
 * Create the pre-approval task on a deal, exactly once.
 *
 * Same `INSERT … SELECT … WHERE NOT EXISTS` shape as `seedStageAutoTasks`, and
 * with the same honest bound on it: one statement, so a re-submitted
 * questionnaire — the case that actually happens, since the wizard can be
 * re-run and the portal re-posts the intake after a claim — never produces a
 * second row. It is not a substitute for a unique constraint: at READ
 * COMMITTED two *simultaneous* inserts could both find nothing and both write.
 * That needs the same client to submit the questionnaire twice within the same
 * few milliseconds, and the failure mode is a duplicate task rather than
 * anything lost, so it is accepted here exactly as it is for the stage seeder.
 *
 * The `pre_approved` check rides in the same statement rather than a
 * read-then-write for the same reason: it shrinks the window in which the
 * agent could flip the flag to nothing worth reasoning about.
 *
 * What "already has one" means is `source = PRE_APPROVAL_TASK_SOURCE` (#460),
 * NOT the title. A row written under older copy is still recognised, so
 * rewording the task never duplicates it — and never replaces the existing row
 * either, so whatever the buyer or agent already did to it (status, assignee,
 * due date) survives. The trade that buys: an existing task keeps its old
 * wording until someone edits or recreates it. That is the right side of the
 * trade — a stale sentence beats a duplicated, orphaned task.
 *
 * Callers decide WHETHER the buyer needs it (`needsPreApprovalTask` in
 * lib/intake.ts reads the questionnaire); this function only decides whether
 * the deal already has one.
 */
/**
 * Close the deal's open pre-approval task (#437).
 *
 * Both halves of the two-state model land here: the buyer marking *applied*
 * (`POST /api/deals/[id]/pre-approval`) and the agent/admin confirming
 * *pre-approved* (`PATCH /api/deals/[id]/flags`). Neither of those callers
 * should have to know how the task is identified.
 *
 * Keyed on `source`, never on the title — same rule as `seedPreApprovalTask`
 * (#460). And deliberately scoped to tasks that are still open: a row someone
 * already SKIPPED stays skipped rather than being rewritten to 'completed',
 * because "the agent waved this away" and "this got done" are different
 * answers and only one of them is ours to give.
 *
 * A no-op when the deal has no such task — a cash buyer, or a deal where it
 * was already closed. Callers can fire it unconditionally.
 */
export async function closePreApprovalTask(dealId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE tasks
    SET status = 'completed', updated_at = NOW()
    WHERE deal_id = ${dealId}::uuid
      AND source = ${PRE_APPROVAL_TASK_SOURCE}
      AND status NOT IN ('completed', 'skipped')
  `;
}

export async function seedPreApprovalTask(dealId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO tasks (deal_id, title, description, priority, source, stage_context, role, due_date)
    SELECT
      d.id,
      ${PRE_APPROVAL_TASK_TITLE}::text,
      ${PRE_APPROVAL_TASK_DESCRIPTION}::text,
      'high'::varchar,
      ${PRE_APPROVAL_TASK_SOURCE}::varchar,
      ${PRE_APPROVAL_TASK_STAGE}::varchar,
      'buyer'::varchar,
      ${autoTaskDueDate(PRE_APPROVAL_TASK_STAGE, "high")}::date
    FROM deals d
    WHERE d.id = ${dealId}::uuid
      -- The agent already has the letter — don't ask for it again.
      AND d.pre_approved = FALSE
      -- Keyed on source, never on the copy (#460).
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.deal_id = d.id AND t.source = ${PRE_APPROVAL_TASK_SOURCE}
      )
  `;
}
