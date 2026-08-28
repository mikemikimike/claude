/**
 * Deal wire contracts (#88): request-body schemas for the deal money routes
 * and the ApiDeal response schema — the single source for the wire type the
 * hooks used to hand-maintain (the string-vs-number lie behind #85).
 *
 * Client-safe: zod + pure libs only (hooks import from here too).
 *
 * Schema philosophy: reject garbage (types that previously 500'd deep in
 * Prisma/Postgres), never tighten contracts. Semantic checks with
 * user-facing messages (required-ness wording, catalog membership) stay in
 * the handlers so responses don't change for payloads that already 400'd.
 */
import { z } from "zod";
import { STAGE_ORDER } from "@/lib/stages";
import { decimalString, dateOnlyString } from "./common";

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** POST /api/deals */
export const createDealBodySchema = z.object({
  // Emptiness + type membership keep their combined handler message
  // ("title and type (buy|sell) are required").
  title: z.string().nullish(),
  type: z.string().nullish(),
  address: z.string().nullish(),
  // number, numeric string (always worked — SQL casts ::decimal), or null.
  price: z.union([z.number(), decimalString]).nullish(),
  arive_linked: z.boolean().nullish(),
  // Agent-entered "Est. Closing Date" (#253). YYYY-MM-DD or null; garbage 400s
  // here instead of being silently dropped. Fallback closing anchor for
  // non-ARIVE deals (ARIVE key dates still win when present).
  closing_date: dateOnlyString.nullish(),
});
export type CreateDealBody = z.output<typeof createDealBodySchema>;

/** PATCH /api/deals/[id]/stage — unknown stages 400 here (previously a 500). */
export const dealStagePatchBodySchema = z.object({
  // null/absent keeps the handler's "stage is required" message.
  stage: z.enum(STAGE_ORDER).nullish(),
});
export type DealStagePatchBody = z.output<typeof dealStagePatchBodySchema>;

/** PATCH /api/deals/[id]/buyer-status — canonical-step check stays in the handler. */
export const buyerStatusPatchBodySchema = z.object({
  buyer_status: z.string().nullish(),
});
export type BuyerStatusPatchBody = z.output<typeof buyerStatusPatchBodySchema>;

/**
 * The deal lifecycle status (#254). `active` deals live in the pipeline;
 * `archived` / `fallen_through` are soft-ended and excluded from the default
 * list. Enforced at the DB by `deals_status_check` (migration 000056).
 */
export const DEAL_STATUSES = ["active", "archived", "fallen_through"] as const;
export const dealStatusSchema = z.enum(DEAL_STATUSES);
export type DealStatus = z.output<typeof dealStatusSchema>;

/**
 * PATCH /api/deals/[id] (#254) — correct a deal's core identity or soft-archive
 * it. `.strict()` rejects unknown keys, which is how `stage` (owned solely by
 * the /stage route + its history invariant) 400s here instead of silently
 * doing nothing. All fields optional; an empty patch (no editable field) 400s
 * in the handler. title cannot be null (NOT NULL); address/price/closing_date
 * accept null to CLEAR. Garbage types (price "banana", bad status, bad date)
 * 400 at the boundary instead of 500ing inside Postgres.
 */
export const dealPatchBodySchema = z
  .object({
    title: z.string().optional(),
    address: z.string().nullish(),
    price: z.union([z.number(), decimalString]).nullish(),
    closing_date: dateOnlyString.nullish(),
    status: dealStatusSchema.optional(),
  })
  .strict();
export type DealPatchBody = z.output<typeof dealPatchBodySchema>;

// ---------------------------------------------------------------------------
// Responses (wire shape the hooks consume)
// ---------------------------------------------------------------------------

export const ariveTrackerSchema = z.object({
  name: z.string(),
  currentTrackerStatus: z.object({ status: z.string() }),
});

export const ariveKeyDatesSchema = z.record(z.string(), z.string().nullable());

export const fastPassApiDataSchema = z.object({
  status: z.string(),
  payment_option: z.string(),
  selected_upsells: z.array(z.string()).optional(),
  total_cents: z.number().optional(),
  enrolled_at: z.string().optional(),
});
export type FastPassApiData = z.output<typeof fastPassApiDataSchema>;

export const smoothExitApiDataSchema = z.object({
  status: z.string(),
  payment_option: z.string(),
  estimated_sale_price: z.number().optional(),
  fee_cents: z.number().optional(),
  enrolled_at: z.string().optional(),
  selected_upsells: z.array(z.string()).optional(),
  upsell_total_cents: z.number().optional(),
  upsells_paid: z.boolean().optional(),
});
export type SmoothExitApiData = z.output<typeof smoothExitApiDataSchema>;

/**
 * A deal row as the API serializes it. Postgres DECIMAL columns travel as
 * text (`price::text`, `commission_pct::text`) — declaring them as strings
 * here is the whole point (#85).
 */
export const apiDealSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  type: z.enum(["buy", "sell"]),
  stage: z.string(),
  health: z.enum(["green", "yellow", "red"]),
  /**
   * Lifecycle status (#254): active | archived | fallen_through. Optional —
   * payloads that don't SELECT it (e.g. the create RETURNING, /api/me/deals)
   * omit it and the adapter defaults to 'active'.
   */
  status: dealStatusSchema.optional(),
  title: z.string(),
  address: z.string().nullable(),
  /** Postgres DECIMAL serialized as text by the API (`price::text`). */
  price: z.string().nullable(),
  arive_linked: z.boolean(),
  /**
   * Agent-entered manual closing date (`deals.closing_date`), serialized as
   * `YYYY-MM-DD` text by the API (#253). Fallback timeline anchor for non-ARIVE
   * deals; ARIVE key dates take precedence in `apiDealToFrontend`. Optional:
   * payloads that don't SELECT it (e.g. /api/me/deals) omit it.
   */
  closing_date: z.string().nullish(),
  arive_loan_id: z.string().nullish(),
  arive_milestones: z.array(ariveTrackerSchema).nullish(),
  arive_key_dates: ariveKeyDatesSchema.nullish(),
  arive_loan_status: z.string().nullish(),
  notes: z.string().nullish(),
  fee_status: z.string().optional(),
  fee_amount_cents: z.number().optional(),
  fee_paid_at: z.string().nullish(),
  fast_pass: fastPassApiDataSchema.nullish(),
  smooth_exit: smoothExitApiDataSchema.nullish(),
  pre_approved: z.boolean().optional(),
  baa_signed: z.boolean().optional(),
  disclosures_complete: z.boolean().optional(),
  /** Agent-set "Buyer's Progress" step shown on the seller portal (#184). */
  buyer_status: z.string().nullish(),
  /**
   * Whether the client has submitted their onboarding questionnaire (#407).
   * Served by /api/me/deals so the portal can stop rendering the "Begin my
   * onboarding" card at a client who already finished it. Optional: the
   * agent-facing payloads don't SELECT it.
   */
  intake_submitted: z.boolean().optional(),
  /**
   * How the buyer said they're paying (#409), derived server-side from the
   * onboarding intake — never stored, never client-supplied. Null when the
   * buyer hasn't onboarded or it's a sell deal; absent on the payloads that
   * don't SELECT the intake (e.g. the create RETURNING).
   */
  financing_type: z.enum(["cash", "loan"]).nullish(),
  /** Postgres DECIMAL serialized as text by the API (`commission_pct::text`). */
  commission_pct: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * ISO timestamp the deal entered its CURRENT stage — the server "days in
   * stage" anchor (latest `deal_stage_history.changed_at`, else `created_at`).
   * Unlike `updated_at` it is NOT bumped by unrelated writes (#257). Optional:
   * responses that don't join stage history (e.g. the create response) omit
   * it, and the adapter falls back to `created_at`.
   */
  stage_entered_at: z.string().optional(),
  agent_name: z.string().optional(),
  agent_email: z.string().optional(),
  agent_phone: z.string().nullish(),
  open_task_count: z.number().optional(),
  overdue_task_count: z.number().optional(),
});
export type ApiDeal = z.output<typeof apiDealSchema>;

export const apiDealListSchema = z.array(apiDealSchema);
