import { error, json } from "@/lib/http";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ token: string }> };

type InviteRow = {
  token: string;
  email: string;
  name: string;
  agent_name: string;
  expires_at: Date;
  claimed_at: Date | null;
};

/**
 * Public — invite details for the /tc-invite/[token] landing page (#446).
 *
 * Mirrors GET /api/invites/[token]: an expired-and-unclaimed invite answers 410
 * so the page can say "ask your agent to resend" BEFORE walking someone into
 * creating an Auth0 account they then can't use (#278). A claimed invite still
 * returns its claimed state — a successful claim wins over expiry.
 *
 * Deliberately returns no ids: the token is a bearer credential handed out by
 * email, so the response is only what the page must render — who invited them,
 * which address it is for, and when it dies.
 */
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;

  // Guard the cast: a non-UUID path segment would make `::uuid` throw 22P02
  // out of withAuth-less code as an unhandled 500 rather than a clean 404.
  if (!/^[0-9a-fA-F-]{36}$/.test(token)) return error("invite not found", 404);

  const rows = await prisma.$queryRaw<InviteRow[]>`
    SELECT ti.token::text AS token, ti.email, ti.name,
           u.name AS agent_name,
           ti.expires_at, ti.claimed_at
      FROM tc_invites ti
      JOIN users u ON u.id = ti.agent_id
     WHERE ti.token = ${token}::uuid
  `;
  const row = rows[0];
  if (!row) return error("invite not found", 404);

  const claimed = row.claimed_at !== null;
  if (row.expires_at < new Date() && !claimed) {
    return error("invite expired", 410);
  }

  return json({
    token: row.token,
    email: row.email,
    name: row.name,
    agent_name: row.agent_name,
    expires_at: row.expires_at.toISOString(),
    claimed,
  });
}
