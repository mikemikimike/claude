/**
 * Server-side access gate for a deal's inspection items (#429).
 *
 * Kept out of `lib/inspection-items.ts` so that module stays free of prisma and
 * can be imported by the agent's client-side InspectionTab — a client component
 * importing anything that reaches @prisma/client breaks the Turbopack build.
 */
import { prisma } from "./db";
import { isLinkedTCForDeal } from "./deals";
import { hasRole } from "./roles";

export type InspectionAccess = { canRead: boolean; canWrite: boolean };

const NO_ACCESS: InspectionAccess = { canRead: false, canWrite: false };

/**
 * Who may see and who may edit a deal's inspection items.
 *
 * - admin — read + write
 * - TC linked to the deal's owning agent (#172) — read + write
 * - the deal's owning agent — read + write
 * - any other deal participant (the buyer, a seller, a co-agent) — read only
 * - everyone else — nothing
 */
export async function inspectionItemAccess(
  dealId: string,
  userId: string,
  roles: readonly string[]
): Promise<InspectionAccess> {
  if (hasRole(roles, ["admin"])) return { canRead: true, canWrite: true };
  if (hasRole(roles, ["tc"]) && (await isLinkedTCForDeal(dealId, userId))) {
    return { canRead: true, canWrite: true };
  }

  const deal = await prisma.deals.findFirst({
    where: {
      id: dealId,
      OR: [
        { agent_id: userId },
        { deal_participants: { some: { user_id: userId } } },
      ],
    },
    select: { agent_id: true },
  });
  if (!deal) return NO_ACCESS;
  return { canRead: true, canWrite: deal.agent_id === userId };
}
