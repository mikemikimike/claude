import { error, json, upsertUserOrConflict, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { sendNotificationEmail } from "@/lib/email";
import { formatIntakeHighlights } from "@/lib/notification-email";
import { applyIntakeToDeal, isIntakeRole, parseIntakeAnswers } from "@/lib/intake";
import type { Role } from "@/lib/roles";

type Ctx = { params: Promise<{ token: string }> };

type ClaimBody = {
  email?: string;
  name?: string;
  // #175 — the onboarding questionnaire rides along with the claim so the
  // invite's deal gets the client's answers atomically.
  intake?: { role?: unknown; answers?: unknown };
};

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { token } = await ctx.params;
  // JWT required but no role claim required — invitee may not have one yet.
  return (await withAuth(req, async (claims): Promise<Response> => {
    let body: ClaimBody;
    try {
      body = (await req.json()) as ClaimBody;
    } catch {
      return error("invalid request body", 400);
    }
    if (!body.email || !body.name) {
      return error("email and name are required", 400);
    }
    // Validate the optional intake up front — before any write — so a
    // malformed payload can never leave a half-claimed invite behind.
    let intakeAnswers: Record<string, unknown> | null = null;
    if (body.intake !== undefined) {
      intakeAnswers = parseIntakeAnswers(body.intake?.answers);
      if (!intakeAnswers) return error("intake.answers must be a JSON object", 400);
    }

    const invites = await prisma.$queryRaw<
      {
        id: string;
        deal_id: string;
        role: Role;
        claimed_at: Date | null;
        expires_at: Date;
      }[]
    >`
      SELECT id, deal_id, role::text AS role, claimed_at, expires_at
      FROM deal_invites
      WHERE token = ${token}::uuid AND email = ${body.email}
    `;
    const inv = invites[0];
    if (!inv) return error("invite not found", 404);
    if (inv.claimed_at !== null) return error("invite already claimed", 409);
    if (inv.expires_at.getTime() < Date.now()) return error("invite expired", 410);

    // #174 — a claim must never rewrite an existing account. Look the caller
    // up BEFORE any write: an agent/admin/TC "previewing" the invite link
    // must neither demote themselves to buyer nor burn the invite for the
    // real client.
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
    if (caller && caller.role !== "buyer" && caller.role !== "seller") {
      return error(
        "this invite is for your client — it can't be accepted from your account",
        409
      );
    }

    // Existing buyer/seller: keep the account exactly as-is (role, email,
    // name untouched) and just link them to the deal below. Brand-new
    // caller: create the account with the invite's role. keepExistingRole
    // makes the insert race-safe — a concurrent sync can't be demoted.
    //
    // #396 — a second Auth0 identity for an email that already has an account
    // collides on users_email_key. Return the readable 409 rather than letting
    // it escape as an unhandled 500, which the client retries forever.
    const user =
      caller ??
      (await upsertUserOrConflict({
        auth0Id: claims.sub,
        email: body.email,
        name: body.name,
        role: inv.role,
        keepExistingRole: true,
      }));
    if (user instanceof Response) return user;

    await prisma.deal_invites.update({
      where: { id: inv.id },
      data: { claimed_at: new Date(), claimed_by: user.id },
    });

    // Link the user as a deal participant (idempotent).
    await prisma.$executeRaw`
      INSERT INTO deal_participants (deal_id, user_id, role)
      VALUES (${inv.deal_id}::uuid, ${user.id}::uuid, ${inv.role})
      ON CONFLICT DO NOTHING
    `;

    // #175 — persist the onboarding questionnaire on the invite's deal. The
    // invite's role is canonical (never trust the body's role for scoping);
    // seller intakes also fill the deal address when the agent left it empty.
    const bodyIntakeRole = body.intake?.role;
    const intakeRole = isIntakeRole(inv.role)
      ? inv.role
      : isIntakeRole(bodyIntakeRole)
        ? bodyIntakeRole
        : null;
    // #407 — a completed intake also advances the deal off `intake` (with the
    // history row attributed to the claiming client), so the portal doesn't
    // greet them with the onboarding they just finished.
    if (intakeAnswers && intakeRole) {
      await applyIntakeToDeal({
        dealId: inv.deal_id,
        role: intakeRole,
        answers: intakeAnswers,
        submittedBy: user.id,
      });
    }

    // Best-effort: notify the inviting agent that their client accepted and
    // created their account. Makes the onboarding "your agent has been
    // notified" promise real. A delivery failure must never fail the claim.
    try {
      const infoRows = await prisma.$queryRaw<
        { agent_email: string; agent_name: string; title: string }[]
      >`
        SELECT u.email AS agent_email, u.name AS agent_name, d.title
        FROM deals d
        JOIN users u ON u.id = d.agent_id
        WHERE d.id = ${inv.deal_id}::uuid
      `;
      const info = infoRows[0];
      if (info?.agent_email) {
        const origin = new URL(req.url).origin;
        // #175 — append intake highlights so the email isn't a bare "client
        // joined" notice.
        const highlights =
          intakeAnswers && intakeRole
            ? formatIntakeHighlights(intakeRole, intakeAnswers)
            : "";
        await sendNotificationEmail({
          to: info.agent_email,
          subject: `${body.name} accepted your invite`,
          heading: `${body.name} joined ${info.title}`,
          body: `${body.name} (${body.email}) accepted your invite and created their account. They're now on your "${info.title}" deal in RealTourFlow.${highlights}`,
          dealUrl: `${origin}/agent/deals/${inv.deal_id}`,
        });
      }
    } catch (err) {
      console.error("failed to notify agent of invite claim", err);
    }

    return json(user);
  })) as Response;
}
