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
import { seedPreApprovalTask, seedStageAutoTasks } from "./stage-task-seed";

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

/** How the buyer is paying, as answered in onboarding (#409). */
export type FinancingType = "cash" | "loan";

/**
 * The buyer questionnaire's cash-or-loan answer key. It is screen 0 of
 * `components/pages/onboarding/BuyerOnboarding.tsx` ("💰 Cash purchase" /
 * "🏦 Getting a loan") and it also drives that wizard's `CASH_SKIP` set.
 *
 * This constant is the ONE place the key name lives on the read side — the
 * offer gate must not go spelunking through `deals.intake` at each call site.
 */
const FINANCING_ANSWER_KEY = "cashOrLoan";

/**
 * The buyer's financing choice from a validated answers object, or null when
 * they didn't answer it (or it isn't a buy-side questionnaire).
 */
export function financingTypeFromAnswers(
  role: IntakeRole,
  answers: Record<string, unknown>
): FinancingType | null {
  if (role !== "buyer") return null;
  const v = answers[FINANCING_ANSWER_KEY];
  return v === "cash" || v === "loan" ? v : null;
}

/**
 * Narrows a `deals.financing_type` column value (#451).
 *
 * The column has a CHECK constraint, so in practice this only ever sees
 * `'cash'`, `'loan'` or `null` — but it is the last thing between the database
 * and the pre-approval offer gate, so it fails closed on anything else. That
 * default direction is load-bearing: `null` keeps the existing gate, while a
 * wrong "cash" would unlock the offer CTA for a financed buyer with no letter.
 */
export function normalizeFinancingType(value: unknown): FinancingType | null {
  return value === "cash" || value === "loan" ? value : null;
}

/**
 * Row mapper for the deal API payloads: normalizes the `deals.financing_type`
 * column onto the response (#451).
 *
 * The property is REQUIRED on the input row, on purpose. #409's version took
 * `{ intake?: unknown }` and derived the value from the questionnaire JSON, so
 * a deal SELECT that forgot to include the source column still compiled and
 * quietly produced `financing_type: null` — silently putting the pre-approval
 * gate back in front of every cash buyer. Now such a SELECT is a type error,
 * and if one slips past the types anyway (raw SQL is unchecked) the missing key
 * throws instead of failing silently. Postgres gives `null` for a NULL column
 * and omits the key entirely only when the column was never selected, so the
 * two are cleanly distinguishable.
 */
export function withFinancingType<T extends { financing_type: unknown }>(
  row: T
): Omit<T, "financing_type"> & { financing_type: FinancingType | null } {
  const { financing_type, ...rest } = row;
  if (financing_type === undefined) {
    throw new Error(
      "withFinancingType: row is missing financing_type — the SELECT must include deals.financing_type"
    );
  }
  return { ...rest, financing_type: normalizeFinancingType(financing_type) };
}

/** Which lender the buyer picked in onboarding (#434). */
export type LenderChoice = "mountain" | "fastpass" | "other";

/**
 * The buyer questionnaire's lender-choice answer key. It is written by
 * `PitchPage` ("Mountain Mortgage" / "Fast Pass" / "I have my own lender") via
 * `BuyerOnboarding`, whose `LenderChoice` union these three values mirror.
 *
 * Same rule as FINANCING_ANSWER_KEY above: this constant is the ONE place the
 * key name lives on the read side. Nothing else reaches into `deals.intake`
 * looking for it.
 */
const LENDER_ANSWER_KEY = "lenderChoice";

/**
 * The buyer's lender choice from a validated answers object, or null when they
 * didn't answer it (or it isn't a buy-side questionnaire).
 *
 * Strict equality only — no trimming, no case-folding. `deals.intake` is
 * free-form client-written JSON, and the safe default here is `null`: it means
 * "no pre-approval task", and a task nobody needs is worse than a missing one
 * because an open high-priority task holds the deal at Property Search.
 */
export function lenderChoiceFromAnswers(
  role: IntakeRole,
  answers: Record<string, unknown>
): LenderChoice | null {
  if (role !== "buyer") return null;
  const v = answers[LENDER_ANSWER_KEY];
  return v === "mountain" || v === "fastpass" || v === "other" ? v : null;
}

/**
 * Whether finishing this questionnaire should put a pre-approval task on the
 * deal (#434) — true only for a buyer who picked Mountain Mortgage or Fast
 * Pass (the same lender, wrapped in the concierge service) and is not paying
 * cash.
 *
 * The buyer wizard skips the lender screen for cash buyers, so the cash +
 * lender pairing should not occur; when the answers contradict each other it
 * resolves toward NOT creating the task, because a cash buyer has nothing to
 * get pre-approved for.
 *
 * Note what is NOT decided here: whether the deal is already `pre_approved`.
 * That is a property of the deal, not the questionnaire, and it is checked in
 * the same statement that inserts the row (`seedPreApprovalTask`) so the agent
 * can't flip the flag in between.
 */
export function needsPreApprovalTask(
  role: IntakeRole,
  answers: Record<string, unknown>
): boolean {
  const lender = lenderChoiceFromAnswers(role, answers);
  if (lender !== "mountain" && lender !== "fastpass") return false;
  return financingTypeFromAnswers(role, answers) !== "cash";
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
  // #451 — the buyer's cash/loan answer is promoted to a real column here, the
  // same way the seller's address is. Only a recognized answer is written: a
  // questionnaire that doesn't answer it (or answers it with something that
  // isn't literally 'cash'/'loan') leaves the column exactly as it was, so a
  // re-submitted onboarding can neither invent a financing type nor wipe the
  // agent's correction.
  const financingType = financingTypeFromAnswers(opts.role, opts.answers);
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
        ...(financingType ? { financing_type: financingType } : {}),
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

  if (advanceTo) {
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
  }

  // #434 — a Mountain Mortgage / Fast Pass buyer gets their pre-approval task.
  //
  // Runs on every intake write, not only the ones that advanced the deal: a
  // client re-submitting onboarding from a deal the agent already moved on
  // still needs the task, and `seedPreApprovalTask` is idempotent so the
  // re-entry is free.
  //
  // Best-effort, and deliberately OUTSIDE the transaction above: a missing
  // task is recoverable (the agent can add it, or the next submit creates it);
  // a lost onboarding is not.
  if (needsPreApprovalTask(opts.role, opts.answers)) {
    try {
      await seedPreApprovalTask(opts.dealId);
    } catch (err) {
      console.error("pre-approval task seed failed", err);
    }
  }

  return advanceTo;
}
