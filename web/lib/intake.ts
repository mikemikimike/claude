/**
 * #175 — persisted onboarding intake.
 *
 * The buyer/seller onboarding questionnaire is stored as JSON on the deal
 * itself (`deals.intake` JSONB — migration 000050):
 *
 *   { role: "buyer" | "seller", submitted_at: ISO string, answers: {...} }
 *
 * Two write paths share these helpers:
 *   - POST /api/invites/[token]/claim — the intake rides along with the claim
 *     so the invite's deal gets it atomically.
 *   - POST /api/me/intake — authenticated clients (account-first flow, or a
 *     claim that already happened during AuthSetup) write to their own
 *     participant deal.
 *
 * Read path: GET /api/deals/[id]/intake (agent- or participant-scoped).
 */
import { prisma } from "./db";
import type { DealStage } from "./stages";
import { seedStageAutoTasks } from "./stage-task-seed";

export type IntakeRole = "buyer" | "seller";

export type DealIntake = {
  role: IntakeRole;
  submitted_at: string;
  answers: Record<string, unknown>;
};

/** Upper bound on the serialized answers payload — the real questionnaires are
 * ~1–2 KB; anything bigger is abuse or a client bug. */
const MAX_ANSWERS_JSON_CHARS = 20_000;

export function isIntakeRole(v: unknown): v is IntakeRole {
  return v === "buyer" || v === "seller";
}

/**
 * Validates a client-supplied answers payload. Returns the object when it is
 * a plain JSON object under the size cap, otherwise null.
 */
export function parseIntakeAnswers(input: unknown): Record<string, unknown> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  try {
    if (JSON.stringify(input).length > MAX_ANSWERS_JSON_CHARS) return null;
  } catch {
    return null; // circular / non-serializable
  }
  return input as Record<string, unknown>;
}

/** The seller's property address from the answers, when present. */
export function sellerAddressFromAnswers(
  role: IntakeRole,
  answers: Record<string, unknown>
): string | null {
  if (role !== "seller") return null;
  const v = answers.address;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * The stage a deal moves into once its client finishes onboarding (#407).
 * `intake` is the questionnaire stage; the next stop is the same for buy and
 * sell deals (STAGE_ORDER is shared) — the buyer's home search / the seller's
 * listing prep.
 */
export const POST_INTAKE_STAGE: DealStage = "active_search";

/**
 * Writes the intake JSON onto the deal, and — the #407 fix — advances the deal
 * off `intake` in the same transaction.
 *
 * Before this, finishing onboarding only wrote `deals.intake`. The deal stayed
 * in `intake` forever, so the client portal kept rendering "Begin my
 * onboarding" at a client who had just completed it; the only escape was the
 * agent advancing the stage by hand.
 *
 * The advance lives HERE rather than in a route because both intake write paths
 * (POST /api/me/intake and the intake riding along with the invite claim) share
 * this helper. It deliberately does NOT go through PATCH
 * /api/deals/[id]/stage: that route scopes on `agent_id = userId`, so a client
 * calling it 404s.
 *
 * Invariants:
 *   - A stage change ALWAYS writes a `deal_stage_history` row (CLAUDE.md), in
 *     the same transaction as the update, attributed to the submitting client.
 *   - Only a deal still in `intake` advances. A deal the agent already moved
 *     on (or a re-submitted questionnaire) keeps its stage and writes no
 *     history row — no retreat, no duplicate rows.
 *   - The stage's auto-tasks are seeded exactly as an agent-driven advance
 *     seeds them (idempotent + best-effort, mirroring the stage PATCH route).
 *
 * For seller intakes it also fills the deal's address when the agent hasn't set
 * one yet — never clobbers an existing address (the seller's version stays
 * visible inside the intake).
 *
 * @returns the stage the deal was advanced into, or null when it did not move.
 */
export async function applyIntakeToDeal(opts: {
  dealId: string;
  role: IntakeRole;
  answers: Record<string, unknown>;
  /** The client submitting the questionnaire — `deal_stage_history.changed_by`. */
  submittedBy?: string;
}): Promise<DealStage | null> {
  const intake: DealIntake = {
    role: opts.role,
    submitted_at: new Date().toISOString(),
    answers: opts.answers,
  };
  const address = sellerAddressFromAnswers(opts.role, opts.answers);
  const deal = await prisma.deals.findUnique({
    where: { id: opts.dealId },
    select: { address: true, stage: true, type: true, title: true },
  });

  // Only a deal still parked in `intake` advances, and only when we know who
  // to attribute the transition to (the history row's changed_by is NOT NULL).
  const shouldAdvance = deal?.stage === "intake" && Boolean(opts.submittedBy);

  const advanceTo = await prisma.$transaction(async (tx): Promise<DealStage | null> => {
    await tx.deals.update({
      where: { id: opts.dealId },
      data: {
        // Cast for Prisma's InputJsonValue: `Record<string, unknown>` answers
        // are guaranteed JSON-serializable by parseIntakeAnswers.
        intake: intake as object,
        ...(address && !deal?.address?.trim() ? { address } : {}),
        updated_at: new Date(),
      },
    });
    if (!shouldAdvance || !opts.submittedBy) return null;

    // The `stage: 'intake'` predicate — not the read above — is what decides
    // the advance, so a double-submitted questionnaire can't produce two
    // history rows: the second transaction blocks on this row lock and then
    // re-evaluates the WHERE against the committed `active_search`, matching
    // nothing.
    const moved = await tx.deals.updateMany({
      where: { id: opts.dealId, stage: "intake" },
      data: { stage: POST_INTAKE_STAGE },
    });
    if (moved.count === 0) return null;

    await tx.deal_stage_history.create({
      data: {
        deal_id: opts.dealId,
        from_stage: "intake",
        to_stage: POST_INTAKE_STAGE,
        changed_by: opts.submittedBy,
      },
    });
    return POST_INTAKE_STAGE;
  });

  if (!advanceTo) return null;

  // Same seeding hook the agent-driven advance runs, so an intake-driven one
  // produces the same tasks (#87). Idempotent + best-effort: a seed failure
  // must never fail the client's onboarding submission — the intake and the
  // stage change are already committed above.
  try {
    await seedStageAutoTasks(opts.dealId, advanceTo, {
      type: deal?.type ?? "buy",
      clientName: deal?.title ?? "",
    });
  } catch (err) {
    console.error("intake stage auto-task seed failed", err);
  }

  return advanceTo;
}
