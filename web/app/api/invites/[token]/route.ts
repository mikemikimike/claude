import { error, json } from "@/lib/http";
import { prisma } from "@/lib/db";

type Ctx = { params: Promise<{ token: string }> };

// Public — returns invite details for the /join/[token] landing page.
export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  const rows = await prisma.$queryRaw<
    {
      token: string;
      deal_id: string;
      email: string;
      name: string;
      role: string;
      agent_name: string;
      deal_title: string;
      expires_at: Date;
      claimed_at: Date | null;
    }[]
  >`
    SELECT di.token::text AS token, di.deal_id, di.email, di.name, di.role,
           u.name AS agent_name,
           d.title AS deal_title,
           di.expires_at, di.claimed_at
    FROM deal_invites di
    JOIN deals d ON d.id = di.deal_id
    JOIN users u ON u.id = di.invited_by
    WHERE di.token = ${token}::uuid
  `;
  const row = rows[0];
  if (!row) return error("invite not found", 404);

  // #278 — mirror the agent-invite GET: an expired-and-unclaimed invite signals
  // expiry (410) so the /invite/[token] page can render an "ask your agent to
  // resend" state BEFORE the user is walked into creating an Auth0 account. A
  // claimed invite still returns its claimed state — a successful claim wins
  // over expiry so a client who already accepted isn't shown a dead end.
  const claimed = row.claimed_at !== null;
  if (row.expires_at < new Date() && !claimed) {
    return error("invite expired", 410);
  }

  // #425 — does the invited email already have a RealTourFlow account? The
  // landing page uses this to skip its "create account / log in" chooser for a
  // brand-new client (no account → straight to Auth0 signup) and keep the card
  // for the ambiguous case. Only reachable with the unguessable token for this
  // exact address, so it discloses nothing the holder doesn't already know.
  //
  // Raw SQL, and `lower(email) = lower($1)` deliberately: it matches the
  // functional index from migration 000062 (Prisma's `mode: "insensitive"`
  // emits ILIKE, which no btree can serve — see lib/invite-role.ts). Case
  // matters here because the agent hand-types the invite address while Auth0
  // normalizes it, and a false negative would walk an existing account into
  // the signup form.
  const accountRows = await prisma.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM users WHERE lower(email) = lower(${row.email})
    ) AS exists
  `;
  const hasAccount = accountRows[0]?.exists === true;

  return json({
    token: row.token,
    deal_id: row.deal_id,
    email: row.email,
    name: row.name,
    role: row.role,
    agent_name: row.agent_name,
    deal_title: row.deal_title,
    expires_at: row.expires_at.toISOString(),
    claimed,
    has_account: hasAccount,
  });
}
