import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  currentTcAssignment,
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
        // The TC branch never returns a participant id: it writes the
        // AGENT-LEVEL assignment instead, because that is what actually makes
        // deals visible to a TC (listDealsForUser scopes a TC by
        // users.tc_user_id, NOT by deal_participants). A participant row alone
        // would leave the deal reachable only by direct URL and invisible in
        // their dashboard — a third, inconsistent notion of "TC".
        return assignTcParticipant({
          agentId: userId,
          email,
          account,
          origin: new URL(req.url).origin,
        });
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
 * Participant flow, and invites that person to accept.
 *
 * It writes the agent's own TC assignment rather than a per-deal participant
 * row on purpose: a TC in this product is assigned once and covers every deal
 * that agent works — `users.tc_user_id` is what `listDealsForUser` and
 * `canReadDeal` read for a TC.
 *
 * Because it IS an assignment, it must not silently replace one: an agent who
 * already has a different TC gets a 409 pointing at Settings.
 *
 * #446 — the account is never LINKED here, whether or not it already exists.
 * Typing an address is the agent's half of the handshake; the other half is the
 * invitee accepting a tokened, 7-day, single-use link. Until then `tc_user_id`
 * stays null and this deal (and every other) stays invisible to them.
 *
 * Always a Response: 400 self-assignment, 409 conflict, 200 no-op when they are
 * already the linked TC, 202 invited.
 */
async function assignTcParticipant(input: {
  agentId: string;
  email: string;
  account: { id: string; name: string } | null;
  origin: string;
}): Promise<Response> {
  const { agentId, email, account, origin } = input;

  if (account?.id === agentId) {
    return error("you can't be your own transaction coordinator", 400);
  }

  const { contact: existing, tcUserId } = await currentTcAssignment(agentId);
  if (existing && existing.email && existing.email.toLowerCase() !== email) {
    return error(
      `You already have a transaction coordinator (${existing.email}). ` +
        "Change it in Settings → Transaction Coordinator first.",
      409
    );
  }

  // Already accepted, same person — nothing to do, and re-inviting would only
  // retire the link that is currently working.
  if (tcUserId && account && tcUserId === account.id) {
    return json({ status: "ok" });
  }

  // No name is collected here — fall back to the account's own name, then to
  // whatever the agent typed in Settings, then to the address's local part, so
  // the TC card and the email greeting have something human to show.
  const name = account?.name || existing?.name || email.split("@")[0];
  await saveTcAssignment({
    agentId,
    contact: { name, email, phone: existing?.phone ?? "" },
    tcUserId: null,
  });

  const agent = await prisma.users.findUnique({
    where: { id: agentId },
    select: { name: true },
  });
  const { sent } = await inviteTc({
    agentId,
    email,
    name,
    agentName: agent?.name ?? "",
    origin,
  });

  // 202: accepted, but they are not the TC yet — they become one when they
  // claim the token.
  return json({ status: "invited", role: "tc", email, invited: sent }, 202);
}
