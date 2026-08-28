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
        /** Raw questionnaire JSON — derived from, then stripped, below (#409). */
        intake: unknown;
        created_at: Date;
        updated_at: Date;
        stage_entered_at: Date;
        agent_name: string;
        agent_email: string;
        agent_phone: string | null;
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
             -- #409: the buyer's cash/loan answer lives in this JSON. It is
             -- read through lib/intake's typed helper and stripped from the
             -- response by withFinancingType — the answers themselves are
             -- still only served by GET /api/deals/[id]/intake.
             deals.intake,
             deals.created_at, deals.updated_at,
             ${stageEnteredAtExpr} AS stage_entered_at,
             u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone
      FROM deals
      JOIN deal_participants dp ON dp.deal_id = deals.id AND dp.user_id = ${userId}::uuid
      JOIN users u ON u.id = deals.agent_id
      ORDER BY deals.updated_at DESC
    `;
    return json(rows.map(withFinancingType));
  })) as Response;
}
