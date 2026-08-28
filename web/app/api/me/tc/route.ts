/**
 * /me/tc — the calling agent's own Transaction Coordinator (TC) contact.
 *
 * Mirrors GetMyTC / PutMyTC / DeleteMyTC in the legacy Go backend.
 *
 * The TC is stored two ways on the caller's own users row:
 *   - tc_contact  (Json?)   — the manual { name, email, phone } the agent typed.
 *                             While tc_user_id is null this doubles as the
 *                             PENDING TC INVITE (see lib/tc.ts).
 *   - tc_user_id  (uuid?)   — set when an account with a matching email exists,
 *                             linking to that real account.
 *
 * GET    → ApiTCInfo { name, email, phone, user_id } from tc_contact (404 when
 *                      no TC is set — matches the Go "no tc assigned" 404; the
 *                      frontend useTC() treats a thrown 404 as null).
 * PUT    → ApiTCInfo + `invited`. body { name, email, phone }. Trims name,
 *                      lowercases email, requires name+email. Links any account
 *                      with that email (any role); when there is none, emails
 *                      the TC an invite — best-effort, `invited` says whether it
 *                      went out (#415).
 * DELETE → 204. Clears tc_user_id AND tc_contact.
 */
import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { findAccountIdByEmail, inviteTc, saveTcAssignment } from "@/lib/tc";
import { Prisma } from "@/app/generated/prisma/client";

type ApiTCInfo = {
  name: string;
  email: string;
  phone: string;
  user_id: string | null;
  /**
   * PUT only — true when this save actually emailed an invite (i.e. the TC has
   * no account yet AND the send succeeded). GET omits it: nothing was sent.
   */
  invited?: boolean;
};

export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const row = await prisma.users.findUnique({
      where: { id: userId },
      select: { tc_user_id: true, tc_contact: true },
    });
    // No tc_contact = no TC assigned. Matches the Go handler's 404; useTC()'s
    // queryFn catches the thrown error and resolves to null.
    if (!row || row.tc_contact == null) {
      return error("no tc assigned", 404);
    }

    const contact = row.tc_contact as { name?: string; email?: string; phone?: string };
    const info: ApiTCInfo = {
      name: contact.name ?? "",
      email: contact.email ?? "",
      phone: contact.phone ?? "",
      user_id: row.tc_user_id ?? null,
    };
    return json(info);
  })) as Response;
}

type PutBody = { name?: string; email?: string; phone?: string };

export async function PUT(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    let body: PutBody;
    try {
      body = (await req.json()) as PutBody;
    } catch {
      return error("invalid body", 400);
    }

    const name = (body.name ?? "").trim();
    const email = (body.email ?? "").trim().toLowerCase();
    const phone = body.phone ?? "";
    if (name === "" || email === "") {
      return error("name and email required", 400);
    }

    // Link an existing account by EMAIL ALONE. The old lookup also required
    // role='tc', which a brand-new signup can never satisfy (the Auth0 tenant
    // hands everyone a default `agent` role) — so a TC who did not already have
    // a TC-roled account was never linked, and nothing ever backfilled it
    // (#415). Consent for the link is the agent typing this address here.
    const tcUserId = await findAccountIdByEmail(email);

    // Naming yourself is always a mistake, and linking it would give an agent a
    // self-referential tc_user_id that GET /api/me/agents happily lists.
    if (tcUserId === userId) {
      return error("you can't be your own transaction coordinator", 400);
    }

    await saveTcAssignment({
      agentId: userId,
      contact: { name, email, phone },
      tcUserId,
    });

    // No account yet → send the invite the Settings copy promises. Best-effort:
    // `invited` reports whether it actually went out, and the TC is saved
    // either way. When they sign up with this address, decideRole gives them
    // `tc` and linkTcContacts fills in tc_user_id.
    let invited = false;
    if (!tcUserId) {
      const agent = await prisma.users.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      invited = await inviteTc({
        email,
        name,
        agentName: agent?.name ?? "",
        origin: new URL(req.url).origin,
      });
    }

    const info: ApiTCInfo = { name, email, phone, user_id: tcUserId, invited };
    return json(info);
  })) as Response;
}

export async function DELETE(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    await prisma.users.update({
      where: { id: userId },
      data: { tc_user_id: null, tc_contact: Prisma.DbNull, updated_at: new Date() },
    });

    // 204 No Content — matches the Go DeleteMyTC. useTC().removeTC ignores the body.
    return new Response(null, { status: 204 });
  })) as Response;
}
