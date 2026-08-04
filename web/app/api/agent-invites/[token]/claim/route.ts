import { error, json, upsertUserOrConflict, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";

const ADMIN_NOTIFY_EMAIL = "paul@mountain.mortgage";

type Ctx = { params: Promise<{ token: string }> };

type ClaimBody = {
  email?: string;
  name?: string;
};

type InviteRow = {
  id: string;
  email: string;
  claimed_at: Date | null;
  expires_at: Date;
};

// POST — JWT required (any role); creates the agent user and marks the invite
// claimed. Mirrors ClaimAgentInvite in the legacy Go backend.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    let body: ClaimBody;
    try {
      body = (await req.json()) as ClaimBody;
    } catch {
      return error("invalid request body", 400);
    }
    // #272 — the claim is bound to the INVITED email (mirror of the client
    // claim in invites/[token]/claim). The caller must present the email the
    // invite was issued to; a token holder can't self-provision `agent` under
    // an arbitrary email. Require it up front so an omitted email can never
    // fall back to the invited address.
    if (!body.email) return error("email is required", 400);

    const rows = await prisma.$queryRaw<InviteRow[]>`
      SELECT id, email, claimed_at, expires_at
      FROM agent_invites
      WHERE token = ${token}::uuid AND email = ${body.email}
    `;
    const invite = rows[0];
    if (!invite) return error("invite not found", 404);
    if (invite.claimed_at !== null) return error("invite already claimed", 409);
    if (invite.expires_at < new Date()) return error("invite expired", 410);

    // The lookup already guarantees body.email === invite.email; use the
    // invited email as canonical. Name stays optional (falls back to email).
    const claimEmail = invite.email;
    const claimName = body.name || invite.email;

    // #224 (mirror of #174) — a claim must never rewrite an existing account.
    // Look the caller up BEFORE any write: a buyer/seller must not be
    // promoted to agent, an admin/TC must not be demoted to agent, and a
    // non-agent opening the link must not burn the invite for the invitee.
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
    if (caller && caller.role !== "agent") {
      return error(
        "this invite creates an agent account — it can't be accepted from your account",
        409
      );
    }

    // Existing agent: keep the account exactly as-is (role, email, name
    // untouched) and just mark the invite claimed below. Brand-new caller:
    // create the agent account. keepExistingRole makes the insert race-safe —
    // a row created by a concurrent sync can't have its role rewritten.
    //
    // #396 — a second Auth0 identity for an email that already has an account
    // collides on users_email_key. That must surface as the readable 409, not
    // an unhandled 500: AuthSetup only treats 404/409/410 as terminal, so a 500
    // keeps the pending-invite keys and replays this claim on every page load.
    const user =
      caller ??
      (await upsertUserOrConflict({
        auth0Id: claims.sub,
        email: claimEmail,
        name: claimName,
        role: "agent",
        keepExistingRole: true,
      }));
    if (user instanceof Response) return user;

    await prisma.$executeRaw`
      UPDATE agent_invites
      SET claimed_at = NOW(), claimed_by = ${user.id}::uuid
      WHERE id = ${invite.id}::uuid
    `;

    // Best-effort: let the admin know a new agent has joined. Never block claim.
    try {
      const origin = new URL(req.url).origin;
      await sendNotificationEmail({
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New agent joined: ${user.name}`,
        heading: "A new agent joined RealTourFlow",
        body: `${user.name} (${user.email}) accepted their agent invite and set up their account.`,
        dealUrl: `${origin}/admin/users`,
      });
    } catch (err) {
      console.error("failed to send admin new-agent notification", err);
    }

    return json(user);
  })) as Response;
}
