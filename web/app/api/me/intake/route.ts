import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  applyIntakeToDeal,
  isIntakeRole,
  parseIntakeAnswers,
  type IntakeRole,
} from "@/lib/intake";
import type { DealType } from "@/lib/stages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PostBody = {
  // Explicit target deal (e.g. threaded from the invite). Optional — without
  // it the intake lands on the caller's latest participant deal of matching
  // type (buy for buyer intakes, sell for seller intakes).
  deal_id?: string;
  role?: string;
  answers?: unknown;
};

// POST /api/me/intake — persist the caller's onboarding questionnaire onto a
// deal they participate in (#175). No role claim required: brand-new clients
// created via the invite claim may not have JWT roles yet — the deal
// participant lookup is the security boundary.
export async function POST(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 401);

    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return error("invalid request body", 400);
    }

    const answers = parseIntakeAnswers(body.answers);
    if (!answers) return error("answers must be a JSON object", 400);

    // Role: explicit (must be buyer|seller) or inferred from the caller's account.
    let role: IntakeRole | null = null;
    if (body.role !== undefined) {
      if (!isIntakeRole(body.role)) return error("role must be buyer or seller", 400);
      role = body.role;
    } else {
      const me = await prisma.users.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      role = me && isIntakeRole(me.role) ? me.role : null;
      if (!role) return error("role must be buyer or seller", 400);
    }

    // Resolve the target deal — always scoped to deals the caller participates in.
    let dealId: string;
    if (body.deal_id !== undefined) {
      if (typeof body.deal_id !== "string" || !UUID_RE.test(body.deal_id)) {
        return error("invalid deal_id", 400);
      }
      const deal = await prisma.deals.findFirst({
        where: {
          id: body.deal_id,
          deal_participants: { some: { user_id: userId } },
        },
        select: { id: true },
      });
      if (!deal) return error("deal not found", 404);
      dealId = deal.id;
    } else {
      const dealType: DealType = role === "buyer" ? "buy" : "sell";
      const deal = await prisma.deals.findFirst({
        where: {
          type: dealType,
          deal_participants: { some: { user_id: userId } },
        },
        orderBy: { created_at: "desc" },
        select: { id: true },
      });
      if (!deal) return error("no deal found for intake", 404);
      dealId = deal.id;
    }

    // #407 — the write also advances a deal still sitting in `intake`, with the
    // matching deal_stage_history row attributed to this client. Without it the
    // portal kept asking them to redo the onboarding they had just finished.
    const advancedTo = await applyIntakeToDeal({
      dealId,
      role,
      answers,
      submittedBy: userId,
    });
    return json({ ok: true, deal_id: dealId, stage: advancedTo });
  })) as Response;
}
