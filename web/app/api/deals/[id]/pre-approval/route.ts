import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { hasRole } from "@/lib/roles";
import { hasDealAccess } from "@/lib/deals";
import { closePreApprovalTask } from "@/lib/stage-task-seed";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/deals/[id]/pre-approval — "I applied." (#437, FF14)
 *
 * The WEAK half of the two-state pre-approval model, and the only half a buyer
 * may write. It stamps `deals.pre_approval_applied_at` and closes the buyer's
 * pre-approval task (#434/#460) so they can clear their own to-do list.
 *
 * It changes NO gate. `deals.pre_approved` — which is what unlocks "Make an
 * Offer" — is untouched here and stays writable only through
 * `PATCH /api/deals/[id]/flags`, whose scope is the owning agent or an admin.
 * That separation is the entire point of the ticket: if the buyer could set
 * the gate, it would stop being a gate. This handler therefore does not read
 * its request body at all — there is no field a caller can supply, so there is
 * nothing to smuggle.
 *
 * Access is participant-scoped via `hasDealAccess` (the deal's agent OR anyone
 * on `deal_participants`), plus admin for any deal. Everyone else — another
 * agent, an unlinked TC, a stranger — gets a 404, the same "the deal does not
 * exist for you" answer the rest of the deal surface gives.
 *
 * Idempotent: `COALESCE` keeps the FIRST timestamp, so a double-tap (or a
 * retry after a dropped response) never rewrites when the buyer acted.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;

  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const allowed =
      hasRole(claims.roles, ["admin"]) || (await hasDealAccess(dealId, userId));
    if (!allowed) return error("deal not found", 404);

    // An admin passes the check above without the deal existing, so the write
    // itself is still the authority on whether there is a row.
    const updated = await prisma.$executeRaw`
      UPDATE deals
      SET pre_approval_applied_at = COALESCE(pre_approval_applied_at, NOW()),
          updated_at = NOW()
      WHERE id = ${dealId}::uuid
    `;
    if (updated === 0) return error("deal not found", 404);

    await closePreApprovalTask(dealId);

    const row = await prisma.deals.findUnique({
      where: { id: dealId },
      select: { pre_approval_applied_at: true, pre_approved: true },
    });
    return json({
      ok: true,
      pre_approval_applied_at: row?.pre_approval_applied_at ?? null,
      // Echoed so the portal can re-render the gate from the response without
      // a second round trip — and so it is obvious, at the call site, that
      // this endpoint did not move it.
      pre_approved: row?.pre_approved ?? false,
    });
  })) as Response;
}
