import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "./db";
import { hasRole } from "./roles";
import { withFinancingType } from "./intake";
import {
  DEFAULT_STAGE_THRESHOLDS,
  getStageThresholds,
  type StageThresholds,
} from "./system-config";

/**
 * The instant a deal entered its CURRENT stage: the latest
 * `deal_stage_history.changed_at`, or `deals.created_at` if it has never
 * advanced. This — NOT `deals.updated_at`, which ANY write bumps — is the true
 * "days in stage" anchor (#257). Correlated on the outer `deals` row, so any
 * SELECT with `deals` in its FROM can interpolate it.
 *
 * Both `healthExpr` (its yellow-branch age check) and the `stage_entered_at`
 * response column build on this ONE fragment so the client's number can never
 * drift from the server's health anchor. Parameter-free (pure column refs), so
 * nesting it inside other `Prisma.sql` fragments never disturbs their bound
 * parameters.
 */
export const stageEnteredAtExpr: Prisma.Sql = Prisma.sql`COALESCE(
  (SELECT changed_at FROM deal_stage_history dsh
   WHERE dsh.deal_id = deals.id ORDER BY dsh.changed_at DESC LIMIT 1),
  deals.created_at
)`;

/**
 * Health CASE expression. Ported verbatim from the legacy Go backend, then
 * wired to the admin-editable per-stage thresholds (#305).
 *
 * Red    = any incomplete task with a past due_date.
 * Yellow = deal has been in current stage longer than the stage threshold AND has
 *          incomplete tasks.
 * Green  = otherwise.
 *
 * The per-stage day thresholds come from System Config
 * (system_config.stage_thresholds), falling back to DEFAULT_STAGE_THRESHOLDS.
 * They are bound as query PARAMETERS (never string-interpolated), so this stays
 * injection-safe. Read the thresholds ONCE per request via `getStageThresholds()`
 * and pass them in — the expression runs inside a correlated subquery per deal
 * row, so it must not re-read config itself.
 *
 * Use as a column expression inside SELECTs that include the `deals` table:
 *   const thresholds = await getStageThresholds();
 *   SELECT ${healthExpr(thresholds)} AS health, ... FROM deals ...
 *
 * Called with no argument it uses DEFAULT_STAGE_THRESHOLDS — i.e. exactly the
 * pre-#305 hard-coded behavior.
 */
export function healthExpr(
  thresholds: StageThresholds = DEFAULT_STAGE_THRESHOLDS
): Prisma.Sql {
  return Prisma.sql`
CASE
  WHEN EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.deal_id = deals.id
      AND t.status NOT IN ('completed','skipped')
      AND t.due_date IS NOT NULL
      AND t.due_date < CURRENT_DATE
  ) THEN 'red'
  WHEN FLOOR(EXTRACT(EPOCH FROM (NOW() - ${stageEnteredAtExpr})) / 86400)::INT >
    CASE deals.stage
      WHEN 'intake'          THEN ${thresholds.intake}::int
      WHEN 'active_search'   THEN ${thresholds.active_search}::int
      WHEN 'offer_active'    THEN ${thresholds.offer_active}::int
      WHEN 'under_contract'  THEN ${thresholds.under_contract}::int
      WHEN 'pre_close'       THEN ${thresholds.pre_close}::int
      WHEN 'closing'         THEN ${thresholds.closing}::int
      WHEN 'post_close'      THEN ${thresholds.post_close}::int
      ELSE 30
    END
  AND EXISTS (
    SELECT 1 FROM tasks t
    WHERE t.deal_id = deals.id AND t.status NOT IN ('completed','skipped')
  )
  THEN 'yellow'
  ELSE 'green'
END
`;
}

/**
 * A raw deal SELECT before `withFinancingType` runs over it: `financing_type`
 * is still the unnarrowed column value straight out of Postgres (#451).
 */
type RawDealRow = Omit<DealRow, "financing_type"> & { financing_type: unknown };

export type DealRow = {
  id: string;
  agent_id: string;
  type: string;
  stage: string;
  health: string;
  /** Lifecycle status (#254): active | archived | fallen_through. */
  status: string;
  title: string;
  address: string | null;
  price: string | null;
  arive_linked: boolean;
  arive_milestones: unknown;
  arive_key_dates: unknown;
  arive_loan_status: string | null;
  fee_status: string;
  fee_amount_cents: number;
  fee_paid_at: Date | null;
  fast_pass: unknown;
  smooth_exit: unknown;
  pre_approved: boolean;
  baa_signed: boolean;
  disclosures_complete: boolean;
  /** Agent-set "Buyer's Progress" step shown on the seller portal (#184). */
  buyer_status: string | null;
  /**
   * How the buyer is paying — `cash` | `loan`, or null when they haven't
   * answered, it's a sell deal, or the agent cleared it.
   *
   * A real column since #451 (`deals.financing_type`, migration 000066),
   * written from the onboarding answer by `applyIntakeToDeal` and correctable
   * by the deal's agent through PATCH /api/deals/[id]/flags. #409 derived it
   * from the `deals.intake` JSON on every read; nothing does that any more.
   */
  financing_type: "cash" | "loan" | null;
  /**
   * Agent-entered manual closing date (`deals.closing_date`), serialized as
   * `YYYY-MM-DD` text (`closing_date::text`). Fallback closing anchor for
   * non-ARIVE deals; ARIVE key dates still win in the adapter (#253).
   */
  closing_date: string | null;
  commission_pct: string | null;
  created_at: Date;
  updated_at: Date;
  /**
   * When the deal entered its current stage (latest stage-history change, else
   * created_at) — the stable "days in stage" anchor. See `stageEnteredAtExpr` (#257).
   */
  stage_entered_at: Date;
};

export type DealWithStats = DealRow & {
  agent_name: string;
  agent_email: string;
  agent_phone: string | null;
  open_task_count: number;
  overdue_task_count: number;
};

/**
 * List deals visible to the given user. Agents see their own deals; TCs see
 * only the deals of agents who have linked them (users.tc_user_id = tc.id) —
 * never platform-wide (#172); admins see all.
 *
 * By default only `active` deals are returned — archived / fallen_through deals
 * (#254) leave the pipeline, dashboards, and TC view. Pass `statusFilter` to
 * override: a specific status ('archived' | 'fallen_through' | 'active') shows
 * only that status; an ARRAY of statuses shows any of them (the dashboard's
 * Completed Deals section asks for both closed statuses at once — #417);
 * 'all' shows every status.
 *
 * The caller is responsible for validating the strings against DEAL_STATUSES —
 * they are interpolated as bound parameters, never concatenated, but an
 * unrecognized value would silently match nothing.
 */
export async function listDealsForUser(
  userId: string,
  opts: { isAdmin: boolean; isTC: boolean; statusFilter?: string | string[] }
): Promise<DealWithStats[]> {
  // Read the admin-editable stage thresholds ONCE per list call — never per row
  // (the health CASE runs as a correlated subquery for every deal).
  const thresholds = await getStageThresholds();

  // Visibility scope (agent owns / TC linked / admin sees all) AND lifecycle
  // status, combined into one WHERE so archived deals never leak into a list
  // scoped for someone else.
  const conds: Prisma.Sql[] = [];
  if (!opts.isAdmin) {
    conds.push(
      opts.isTC
        ? // Linked agents' deals, plus the caller's own (covers dual-role users).
          Prisma.sql`(deals.agent_id IN (SELECT id FROM users WHERE tc_user_id = ${userId}::uuid) OR deals.agent_id = ${userId}::uuid)`
        : Prisma.sql`deals.agent_id = ${userId}::uuid`
    );
  }
  if (opts.statusFilter !== "all") {
    // One status stays a plain equality (the pipeline hot path); several
    // become an IN list. An empty array would mean "no status is acceptable",
    // which is a caller bug, so fall back to the active-only default rather
    // than emitting `IN ()` — a syntax error.
    const statuses = Array.isArray(opts.statusFilter)
      ? opts.statusFilter
      : [opts.statusFilter ?? "active"];
    conds.push(
      statuses.length === 1
        ? Prisma.sql`deals.status = ${statuses[0]}`
        : statuses.length > 1
          ? Prisma.sql`deals.status IN (${Prisma.join(statuses)})`
          : Prisma.sql`deals.status = ${"active"}`
    );
  }
  const filter = conds.length
    ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
    : Prisma.sql``;

  const rows = await prisma.$queryRaw<(RawDealRow & {
    agent_name: string;
    agent_email: string;
    agent_phone: string | null;
    open_task_count: number;
    overdue_task_count: number;
  })[]>`
    SELECT deals.id, deals.agent_id, deals.type::text AS type, deals.stage::text AS stage,
           ${healthExpr(thresholds)} AS health, deals.status,
           deals.title, deals.address, deals.price::text AS price, deals.arive_linked,
           deals.arive_milestones, deals.arive_key_dates, deals.arive_loan_status,
           deals.fee_status, deals.fee_amount_cents, deals.fee_paid_at,
           deals.fast_pass, deals.smooth_exit,
           deals.pre_approved, deals.baa_signed, deals.disclosures_complete, deals.buyer_status,
           deals.financing_type, -- #451: a real column; never SELECT deals.intake here
           deals.closing_date::text AS closing_date,
           deals.commission_pct::text AS commission_pct,
           deals.created_at, deals.updated_at,
           ${stageEnteredAtExpr} AS stage_entered_at,
           u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone,
           (SELECT COUNT(*) FROM tasks t
            WHERE t.deal_id = deals.id AND t.status NOT IN ('completed','skipped'))::int AS open_task_count,
           (SELECT COUNT(*) FROM tasks t
            WHERE t.deal_id = deals.id AND t.status NOT IN ('completed','skipped')
              AND t.due_date IS NOT NULL AND t.due_date < CURRENT_DATE)::int AS overdue_task_count
    FROM deals
    JOIN users u ON u.id = deals.agent_id
    ${filter}
    ORDER BY deals.updated_at DESC
  `;
  return rows.map(withFinancingType);
}

/**
 * Get a single deal owned by the given agent.
 */
export async function getDealForAgent(
  dealId: string,
  agentId: string
): Promise<DealRow | null> {
  const thresholds = await getStageThresholds();
  const rows = await prisma.$queryRaw<RawDealRow[]>`
    SELECT id, agent_id, type::text AS type, stage::text AS stage,
           ${healthExpr(thresholds)} AS health, status,
           title, address, price::text AS price, arive_linked,
           arive_loan_id, arive_milestones, arive_key_dates, arive_loan_status, arive_synced_at,
           notes, fee_status, fee_amount_cents, fee_paid_at,
           fast_pass, smooth_exit, pre_approved, baa_signed, disclosures_complete,
           buyer_status, financing_type, closing_date::text AS closing_date,
           commission_pct::text AS commission_pct,
           created_at, updated_at,
           ${stageEnteredAtExpr} AS stage_entered_at
    FROM deals
    WHERE id = ${dealId}::uuid AND agent_id = ${agentId}::uuid
  `;
  return rows[0] ? withFinancingType(rows[0]) : null;
}

/**
 * Get a single deal by id with no caller scoping. Callers MUST check access
 * first (see `canReadDeal`) — this never filters by agent/participant.
 * Same SELECT as `getDealForAgent` so both paths return an identical shape.
 */
export async function getDealById(dealId: string): Promise<DealRow | null> {
  const thresholds = await getStageThresholds();
  const rows = await prisma.$queryRaw<RawDealRow[]>`
    SELECT id, agent_id, type::text AS type, stage::text AS stage,
           ${healthExpr(thresholds)} AS health, status,
           title, address, price::text AS price, arive_linked,
           arive_loan_id, arive_milestones, arive_key_dates, arive_loan_status, arive_synced_at,
           notes, fee_status, fee_amount_cents, fee_paid_at,
           fast_pass, smooth_exit, pre_approved, baa_signed, disclosures_complete,
           buyer_status, financing_type, closing_date::text AS closing_date,
           commission_pct::text AS commission_pct,
           created_at, updated_at,
           ${stageEnteredAtExpr} AS stage_entered_at
    FROM deals
    WHERE id = ${dealId}::uuid
  `;
  return rows[0] ? withFinancingType(rows[0]) : null;
}

/**
 * READ access to a deal (#167). Matches the visibility model of
 * `listDealsForUser`:
 *   - admin            → any deal
 *   - tc (role)        → deals of agents who linked them (users.tc_user_id)
 *   - anyone           → deals they own (agent) or participate in
 * Unlinked TCs and strangers get nothing — no cross-tenant reads.
 *
 * Read-only by design: TC stage changes and other writes remain agent-only
 * (decided in #167); do not reuse this helper to gate mutations.
 */
export async function canReadDeal(
  dealId: string,
  userId: string,
  roles: readonly string[]
): Promise<boolean> {
  if (hasRole(roles, ["admin"])) return true;
  if (hasRole(roles, ["tc"]) && (await isLinkedTCForDeal(dealId, userId))) {
    return true;
  }
  return hasDealAccess(dealId, userId);
}

/**
 * Everyone who can sign on a deal: the owning agent plus all participants,
 * with the user fields DocuSign recipient derivation needs
 * (lib/docusign-routing.ts consumes these rows).
 */
export async function loadDealPeople(dealId: string): Promise<
  { userId: string; name: string; email: string; role: string }[]
> {
  const rows = await prisma.$queryRaw<
    { user_id: string; name: string; email: string; role: string }[]
  >`
    SELECT u.id AS user_id, u.name, u.email, 'agent' AS role
    FROM deals JOIN users u ON u.id = deals.agent_id
    WHERE deals.id = ${dealId}::uuid
    UNION ALL
    SELECT u.id AS user_id, u.name, u.email, dp.role
    FROM deal_participants dp JOIN users u ON u.id = dp.user_id
    WHERE dp.deal_id = ${dealId}::uuid
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
  }));
}

/**
 * Whether the given user is the linked transaction coordinator for the
 * deal's agent (users.tc_user_id = tcUserId). Used to tenant-scope
 * TC-initiated mutations (e.g. fee waive) to the agents that actually
 * assigned them — a TC must never touch another agent's deals (#180).
 */
export async function isLinkedTCForDeal(
  dealId: string,
  tcUserId: string
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM deals
      JOIN users agent ON agent.id = deals.agent_id
      WHERE deals.id = ${dealId}::uuid
        AND agent.tc_user_id = ${tcUserId}::uuid
    ) AS ok
  `;
  return rows[0]?.ok ?? false;
}

/**
 * Resolve whether a user has access to a deal — agent owner or participant.
 */
export async function hasDealAccess(
  dealId: string,
  userId: string
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM deals
      WHERE id = ${dealId}::uuid AND (
        agent_id = ${userId}::uuid OR
        EXISTS (
          SELECT 1 FROM deal_participants
          WHERE deal_id = ${dealId}::uuid AND user_id = ${userId}::uuid
        )
      )
    ) AS ok
  `;
  return rows[0]?.ok ?? false;
}
