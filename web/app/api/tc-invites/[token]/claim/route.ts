import { error, json, upsertUserOrConflict, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";

type Ctx = { params: Promise<{ token: string }> };

type ClaimBody = { email?: string; name?: string };

type InviteRow = {
  id: string;
  agent_id: string;
  email: string;
  name: string;
  claimed_at: Date | null;
  expires_at: Date;
};

/**
 * Accept a Transaction Coordinator invite (#446).
 *
 * THE choke point: this is the only code that writes `users.tc_user_id`, and it
 * only does so for a token that is valid, unexpired, and unclaimed. Before
 * this, the link was made by `linkTcContacts()` on every /users/sync, matching
 * on the invited EMAIL alone — so whoever controlled `tina@gmial.com` could
 * sign up a year later and read the agent's whole pipeline. A linked TC sees
 * every deal that agent works, their clients' contact details, and their
 * documents (`listDealsForUser`), which is why this needs a real claim.
 *
 * Modelled on POST /api/invites/[token]/claim — same statuses, and AuthSetup
 * depends on them: only 404/409/410 are terminal, so anything else keeps the
 * pending token in localStorage and retries on the next page load.
 */
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  // JWT required but no role claim required — the invitee may not have one yet.
  return (await withAuth(req, async (claims): Promise<Response> => {
    if (!/^[0-9a-fA-F-]{36}$/.test(token)) return error("invite not found", 404);

    let body: ClaimBody;
    try {
      body = (await req.json()) as ClaimBody;
    } catch {
      return error("invalid request body", 400);
    }
    // Bound to the INVITED email, like the client and agent claims (#272): a
    // token holder must not be able to self-provision under an arbitrary
    // address. Required up front so an omitted email can never fall back to
    // the invited one.
    if (!body.email) return error("email is required", 400);

    const rows = await prisma.$queryRaw<InviteRow[]>`
      SELECT id, agent_id, email, name, claimed_at, expires_at
        FROM tc_invites
       WHERE token = ${token}::uuid
         AND lower(email) = lower(${body.email})
    `;
    const invite = rows[0];
    if (!invite) return error("invite not found", 404);
    if (invite.claimed_at !== null) return error("invite already claimed", 409);
    if (invite.expires_at.getTime() < Date.now()) return error("invite expired", 410);

    // A claim must never rewrite an existing account (#174/#224). Look the
    // caller up BEFORE any write.
    const caller = await prisma.users.findUnique({
      where: { auth0_id: claims.sub },
      select: {
        id: true,
        auth0_id: true,
        email: true,
        name: true,
        role: true,
        phone: true,
        onboarding_complete: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (caller?.id === invite.agent_id) {
      return error("you can't be your own transaction coordinator", 400);
    }
    // A portal client accepting a TC invite would either be demoted into an
    // agent-side role or silently handed a pipeline; neither is a thing an
    // agent meant to do by typing an address. Their own invite already governs
    // their account.
    if (caller && (caller.role === "buyer" || caller.role === "seller")) {
      return error(
        "this invite is for a transaction coordinator — it can't be accepted from a client account",
        409
      );
    }

    // Brand-new caller → the account is created AS a `tc`, which is what drops
    // them into /tc. An EXISTING account keeps its role untouched (an agent who
    // also coordinates for someone stays an agent) and is simply linked; giving
    // them the TC shell too is an Auth0 RBAC decision, i.e. decideRole rule 1.
    //
    // keepExistingRole makes the insert race-safe: a row created by a
    // concurrent /users/sync can't have its role rewritten here. #396 — a
    // second Auth0 identity on an existing email must surface as the readable
    // 409, not an unhandled 500 that AuthSetup would replay forever.
    const user =
      caller ??
      (await upsertUserOrConflict({
        auth0Id: claims.sub,
        email: invite.email,
        name: body.name || invite.name || invite.email,
        role: "tc",
        keepExistingRole: true,
      }));
    if (user instanceof Response) return user;

    // Single-claim, enforced in the WHERE rather than by the read above: two
    // simultaneous claims would both pass that check, and only one may win.
    const claimed = await prisma.$executeRaw`
      UPDATE tc_invites
         SET claimed_at = NOW(), claimed_by = ${user.id}::uuid
       WHERE id = ${invite.id}::uuid
         AND claimed_at IS NULL
    `;
    if (claimed === 0) return error("invite already claimed", 409);

    // THE grant. Scoped to the agent named on the invite, so a token for agent
    // A can never link its holder to agent B.
    await prisma.$executeRaw`
      UPDATE users
         SET tc_user_id = ${user.id}::uuid,
             updated_at = NOW()
       WHERE id = ${invite.agent_id}::uuid
    `;

    // Best-effort: tell the agent their TC accepted. Never fail the claim.
    try {
      const agentRows = await prisma.$queryRaw<{ email: string; name: string }[]>`
        SELECT email, name FROM users WHERE id = ${invite.agent_id}::uuid
      `;
      const agent = agentRows[0];
      if (agent?.email) {
        const origin = new URL(req.url).origin;
        await sendNotificationEmail({
          to: agent.email,
          subject: `${user.name} accepted your TC invite`,
          heading: `${user.name} is now your Transaction Coordinator`,
          body: `${user.name} (${user.email}) accepted your invite. They can now see your deals, tasks, checklists, and internal messages. Remove them any time in Settings → Transaction Coordinator.`,
          dealUrl: `${origin}/agent/settings`,
        });
      }
    } catch (err) {
      console.error("failed to notify agent of TC invite claim", err);
    }

    return json(user);
  })) as Response;
}
