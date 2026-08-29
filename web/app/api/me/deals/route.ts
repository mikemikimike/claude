import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db";
import { error, json, withAuth } from "@/lib/http";
import { resolveUserId } from "@/lib/users";
import { healthExpr, stageEnteredAtExpr } from "@/lib/deals";
import { getStageThresholds } from "@/lib/system-config";
import { withFinancingType } from "@/lib/intake";

// GET /api/me/deals — deals where the caller is a participant.
export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);
    void Prisma; // ensure import remains for $queryRaw types

    // Admin-editable stage thresholds (#305), read once for this request so the
    // client portal's health matches the agent-facing lists.
    const thresholds = await getStageThresholds();

    // Full portal payload (#171): the buyer/seller portals read pre-approval,
    // BAA, Fast Pass / Smooth Exit, and ARIVE loan state from this endpoint.
    // Deal-state columns mirror listDealsForUser (lib/deals.ts), deliberately
    // MINUS the agent-facing ones (fee_*, commission_pct, notes) — this
    // endpoint serves clients, so don't add those here.
    const rows = await prisma.$queryRaw<
      {
        id: string;
        agent_id: string;
        type: string;
        stage: string;
        health: string;
        title: string;
        address: string | null;
        price: string | null;
        arive_linked: boolean;
        arive_milestones: unknown;
        arive_key_dates: unknown;
        arive_loan_status: string | null;
        fast_pass: unknown;
        smooth_exit: unknown;
        pre_approved: boolean;
        baa_signed: boolean;
        disclosures_complete: boolean;
        buyer_status: string | null;
        intake_submitted: boolean;
        /** `deals.financing_type` straight off the column, narrowed below (#451). */
        financing_type: unknown;
        created_at: Date;
        updated_at: Date;
        stage_entered_at: Date;
        agent_name: string;
        agent_email: string;
        agent_phone: string | null;
        agent_mls_connected: boolean;
      }[]
    >`
      SELECT deals.id, deals.agent_id, deals.type::text AS type, deals.stage::text AS stage,
             ${healthExpr(thresholds)} AS health,
             deals.title, deals.address, deals.price::text AS price,
             deals.arive_linked,
             deals.arive_milestones, deals.arive_key_dates, deals.arive_loan_status,
             deals.fast_pass, deals.smooth_exit,
             deals.pre_approved, deals.baa_signed, deals.disclosures_complete,
             deals.buyer_status,
             -- #407: the portal must stop prompting for onboarding once the
             -- client submitted it. Boolean only — the answers themselves are
             -- read through GET /api/deals/[id]/intake, and this endpoint
             -- deliberately carries no agent-facing columns.
             (deals.intake IS NOT NULL) AS intake_submitted,
             -- #451: the buyer's cash/loan answer, promoted to a real column.
             -- #409 SELECTed the whole intake JSON here just to read this one
             -- string; do not put it back — the answers are served by
             -- GET /api/deals/[id]/intake and nothing else.
             deals.financing_type,
             deals.created_at, deals.updated_at,
             ${stageEnteredAtExpr} AS stage_entered_at,
             u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone,
             -- #428: whether the deal's agent has MLS wired up, so the portal
             -- can explain itself BEFORE offering a search that cannot work.
             -- A BOOLEAN and nothing else. The credentials are AES-256-GCM at
             -- rest (#273) and stay agent-side: never select u.mls_key /
             -- u.mls_secret here, not even truncated. Scoping comes free from
             -- the participant join below — a client can only ever learn this
             -- about the agent on their own deal.
             (u.mls_key IS NOT NULL) AS agent_mls_connected
      FROM deals
      JOIN deal_participants dp ON dp.deal_id = deals.id AND dp.user_id = ${userId}::uuid
      JOIN users u ON u.id = deals.agent_id
      ORDER BY deals.updated_at DESC
    `;
    return json(rows.map(withFinancingType));
  })) as Response;
}
