import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  currentTcContact,
  findAccountByEmail,
  inviteTc,
  saveTcAssignment,
} from "@/lib/tc";

type Ctx = { params: Promise<{ id: string }> };

// Valid participant roles — mirrors the user_role enum on deal_participants.role
// (see migrations/000001_init.up.sql + 000006_add_tc_role.up.sql).
const PARTICIPANT_ROLES = [
  "agent",
  "buyer",
  "seller",
  "admin",
  "tc",
  "lending_partner",
] as const;

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const access = await prisma.deals.findFirst({
      where: {
        id: dealId,
        OR: [
          { agent_id: userId },
          { deal_participants: { some: { user_id: userId } } },
        ],
      },
      select: { id: true },
    });
    if (!access) return error("deal not found", 404);

    const rows = await prisma.$queryRaw<
      {
        id: string;
        name: string;
        email: string;
        phone: string | null;
        role: string;
      }[]
    >`
      SELECT u.id, u.name, u.email, u.phone, dp.role
      FROM deal_participants dp
      JOIN users u ON u.id = dp.user_id
      WHERE dp.deal_id = ${dealId}::uuid
      ORDER BY u.name
    `;
    return json(rows);
  })) as Response;
}

// Accepts either { user_id, role } (back-compat) or { email, role }. When an
// email is supplied (and no user_id), we resolve it to an EXISTING RealTourFlow
// user case-insensitively.
//
// No match → 404 so the UI can steer the agent toward the invite flow, EXCEPT
// for role `tc`: an unknown TC email is invited here exactly as it would be
// from Settings → Transaction Coordinator, and the response is a 202 naming
// the invite (#415). Before, the two paths disagreed — one stored text and
// promised an email it never sent, the other dead-ended on a bare 404.
type AddBody = { user_id?: string; role?: string; email?: string };

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const deal = await prisma.deals.findFirst({
      where: { id: dealId, agent_id: userId },
      select: { id: true },
    });
    if (!deal) return error("deal not found", 404);

    let body: AddBody;
    try {
      body = (await req.json()) as AddBody;
    } catch {
      return error("user_id or email, plus role, are required", 400);
    }

    const role = body.role;
    if (!role || !(PARTICIPANT_ROLES as readonly string[]).includes(role)) {
      return error(
        `role is required and must be one of: ${PARTICIPANT_ROLES.join(", ")}`,
        400
      );
    }

    // Resolve the target user id from either user_id or email.
    let targetUserId = body.user_id;
    if (!targetUserId) {
      if (!body.email) {
        return error("user_id or email is required", 400);
      }
      const email = body.email.trim().toLowerCase();
      const account = await findAccountByEmail(email);

      if (role === "tc") {
        // Both TC branches — known account or not — write the agent-level
        // assignment, because that is what actually makes the deal visible to
        // a TC (listDealsForUser scopes a TC by users.tc_user_id, NOT by
        // deal_participants). A participant row alone would leave the deal
        // reachable only by direct URL and invisible in their dashboard.
        const outcome = await assignTcParticipant({
          agentId: userId,
          email,
          account,
          origin: new URL(req.url).origin,
        });
        if (outcome instanceof Response) return outcome;
        targetUserId = outcome;
      } else {
        if (!account) {
          return error(
            "No RealTourFlow account with that email — invite them first.",
            404
          );
        }
        targetUserId = account.id;
      }
    }

    await prisma.$executeRaw`
      INSERT INTO deal_participants (deal_id, user_id, role)
      VALUES (${dealId}::uuid, ${targetUserId}::uuid, ${role})
      ON CONFLICT (deal_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    return json({ status: "ok" });
  })) as Response;
}

/**
 * Points the calling agent's TC assignment at `email`, from the deal's Add
 * Participant flow, and invites them when they have no account yet.
 *
 * It writes the agent's own TC assignment rather than only a per-deal
 * participant row on purpose: a TC in this product is assigned once and covers
 * every deal that agent works — `users.tc_user_id` is what `listDealsForUser`
 * and `canReadDeal` read for a TC. A deal-scoped TC would be a third,
 * inconsistent notion of "TC", and one whose deals never show up in the TC
 * dashboard.
 *
 * Because it IS an assignment, it must not silently replace one: an agent who
 * already has a different TC gets a 409 pointing at Settings.
 *
 * Returns the account id to add as a participant, or a Response to return
 * as-is (400 self-assignment, 409 conflict, 202 invited).
 */
async function assignTcParticipant(input: {
  agentId: string;
  email: string;
  account: { id: string; name: string } | null;
  origin: string;
}): Promise<Response | string> {
  const { agentId, email, account, origin } = input;

  if (account?.id === agentId) {
    return error("you can't be your own transaction coordinator", 400);
  }

  const existing = await currentTcContact(agentId);
  if (existing && existing.email && existing.email.toLowerCase() !== email) {
    return error(
      `You already have a transaction coordinator (${existing.email}). ` +
        "Change it in Settings → Transaction Coordinator first.",
      409
    );
  }

  // No name is collected here — fall back to the account's own name, then to
  // whatever the agent typed in Settings, then to the address's local part, so
  // the TC card and the email greeting have something human to show.
  const name = account?.name || existing?.name || email.split("@")[0];
  await saveTcAssignment({
    agentId,
    contact: { name, email, phone: existing?.phone ?? "" },
    tcUserId: account?.id ?? null,
  });

  // Known account: the caller adds the deal_participants row as usual.
  if (account) return account.id;

  const agent = await prisma.users.findUnique({
    where: { id: agentId },
    select: { name: true },
  });
  const invited = await inviteTc({
    email,
    name,
    agentName: agent?.name ?? "",
    origin,
  });

  // 202: accepted, but they are not a participant yet — they become one
  // implicitly (via tc_user_id) once they accept and sign up.
  return json({ status: "invited", role: "tc", email, invited }, 202);
}
