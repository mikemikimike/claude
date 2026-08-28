import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "./db";
import { stageAutoTasks, type AutoTaskDeal } from "./stage-auto-tasks";
import { autoTaskDueDate } from "./task-due-dates";

/**
 * The pre-approval task (#434).
 *
 * A buyer who picks Mountain Mortgage — or Fast Pass, which is the same lender
 * wrapped in the concierge service — used to be thrown out to the external 1003
 * application in the middle of the questionnaire, losing every answer they had
 * typed; a buyer who ignored that link was never asked again. The ask now lives
 * on their dashboard as a real task row, so the agent sees it too.
 *
 * The title is the idempotency key (there is deliberately no schema change for
 * this — see the ticket), so it must stay stable: changing it on an existing
 * deployment orphans the old row and creates a second one. `seedStageAutoTasks`
 * knows the same constant for the inverse reason — see its NOT EXISTS guard.
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
      WHERE deal_id = ${dealId}::uuid AND source = 'ai' AND stage_context = ${stage}
        -- ...ignoring the pre-approval task (#434). It is an ai-sourced task
        -- carrying stage_context = active_search, but it is created by the
        -- intake write, not by entering the stage. Counted here it would make
        -- this seeder think active_search had already been seeded, and
        -- silently swallow the agent's three real auto-tasks.
        AND title <> ${PRE_APPROVAL_TASK_TITLE}
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
 * Callers decide WHETHER the buyer needs it (`needsPreApprovalTask` in
 * lib/intake.ts reads the questionnaire); this function only decides whether
 * the deal already has one.
 */
export async function seedPreApprovalTask(dealId: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO tasks (deal_id, title, description, priority, source, stage_context, role, due_date)
    SELECT
      d.id,
      ${PRE_APPROVAL_TASK_TITLE}::text,
      ${PRE_APPROVAL_TASK_DESCRIPTION}::text,
      'high'::varchar,
      'ai'::varchar,
      ${PRE_APPROVAL_TASK_STAGE}::varchar,
      'buyer'::varchar,
      ${autoTaskDueDate(PRE_APPROVAL_TASK_STAGE, "high")}::date
    FROM deals d
    WHERE d.id = ${dealId}::uuid
      -- The agent already has the letter — don't ask for it again.
      AND d.pre_approved = FALSE
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.deal_id = d.id AND t.title = ${PRE_APPROVAL_TASK_TITLE}
      )
  `;
}
