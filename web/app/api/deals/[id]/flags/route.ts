import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { hasRole } from "@/lib/roles";
import { normalizeFinancingType, type FinancingType } from "@/lib/intake";
import { closePreApprovalTask } from "@/lib/stage-task-seed";

type Ctx = { params: Promise<{ id: string }> };

type FlagsBody = {
  pre_approved?: boolean;
  baa_signed?: boolean;
  /**
   * The agent's financing-type correction (#451): `'cash' | 'loan'`, or an
   * explicit `null` to clear it back to "unknown". Omit the key to leave the
   * column alone — `null` and "absent" mean different things here.
   */
  financing_type?: unknown;
};

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;

  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    let body: FlagsBody;
    try {
      body = (await req.json()) as FlagsBody;
    } catch {
      return error("invalid request body", 400);
    }
    // `null` and `[1,2]` are valid JSON but not a flags object — reading a
    // property off them would be a 500 where a 400 is the honest answer.
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return error("invalid request body", 400);
    }

    const data: {
      pre_approved?: boolean;
      baa_signed?: boolean;
      financing_type?: FinancingType | null;
      updated_at: Date;
    } = { updated_at: new Date() };
    if (typeof body.pre_approved === "boolean") data.pre_approved = body.pre_approved;
    if (typeof body.baa_signed === "boolean") data.baa_signed = body.baa_signed;

    // #451 — the agent's undo for a buyer who mis-clicked "cash" in onboarding.
    // Validated strictly rather than normalized-to-null: a typo must be a 400
    // the agent can see, not a silent clear that quietly re-gates the buyer.
    if ("financing_type" in body) {
      if (body.financing_type === null) {
        data.financing_type = null;
      } else {
        const financing = normalizeFinancingType(body.financing_type);
        if (!financing) return error("financing_type must be 'cash', 'loan', or null", 400);
        data.financing_type = financing;
      }
    }

    // Scoping (CLAUDE.md: server-side is the boundary). An agent may correct
    // their OWN deals; an admin any deal. Everyone else — the buyer whose
    // answer this is, a TC, another agent — matches no row and gets a 404,
    // which is also what keeps a buyer from unlocking their own offer CTA.
    const where = hasRole(claims.roles, ["admin"])
      ? { id: dealId }
      : { id: dealId, agent_id: userId };

    const result = await prisma.deals.updateMany({ where, data });
    if (result.count === 0) return error("deal not found", 404);

    // #437 — confirming pre-approval also closes the buyer's pre-approval task
    // (#434/#460). Without this the deal would be pre-approved and still
    // carrying an open high-priority task that gates every forward advance out
    // of Property Search, which the agent would then have to close by hand.
    // Only on the way UP: un-setting the flag is a correction, not a reason to
    // reopen work the buyer may genuinely have finished.
    if (data.pre_approved === true) {
      await closePreApprovalTask(dealId);
    }

    return json({ ok: true });
  })) as Response;
}
