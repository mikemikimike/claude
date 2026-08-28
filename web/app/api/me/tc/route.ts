/**
 * /me/tc — the calling agent's own Transaction Coordinator (TC) contact.
 *
 * Mirrors GetMyTC / PutMyTC / DeleteMyTC in the legacy Go backend.
 *
 * The TC is stored two ways on the caller's own users row:
 *   - tc_contact  (Json?)   — the manual { name, email, phone } the agent typed.
 *                             DISPLAY ONLY. It is not a grant and never was
 *                             meant to be one (#446).
 *   - tc_user_id  (uuid?)   — the linked account. Written by exactly one thing:
 *                             POST /api/tc-invites/:token/claim, i.e. the TC
 *                             accepting a tokened invite. Cleared here.
 *
 * GET    → ApiTCInfo { name, email, phone, user_id } from tc_contact (404 when
 *                      no TC is set — matches the Go "no tc assigned" 404; the
 *                      frontend useTC() treats a thrown 404 as null).
 * PUT    → ApiTCInfo + `invited`. body { name, email, phone }. Trims name,
 *                      lowercases email, requires name+email. Issues a tokened
 *                      7-day invite and emails it — best-effort, `invited` says
 *                      whether it went out. `user_id` stays null until they
 *                      accept: an agent cannot link a TC by typing an address
 *                      (#446), which is what stops one typo'd domain from
 *                      handing a stranger the whole pipeline.
 * DELETE → 204. Clears tc_user_id AND tc_contact, and kills any open invite —
 *                      so an emailed link stops working the moment the agent
 *                      changes their mind.
 */
import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  currentTcAssignment,
  expireOpenTcInvites,
  findAccountIdByEmail,
  inviteTc,
  saveTcAssignment,
} from "@/lib/tc";
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

    // Naming yourself is always a mistake, and linking it would give an agent a
    // self-referential tc_user_id that GET /api/me/agents happily lists.
    // Looked up by email, not linked by it — see below.
    if ((await findAccountIdByEmail(email)) === userId) {
      return error("you can't be your own transaction coordinator", 400);
    }

    // Re-saving the SAME address (a phone-number fix, say) must not tear down a
    // link the TC already accepted and make them accept again. Anything else —
    // a different address — unlinks whoever was there, because the agent has
    // just said this is somebody else.
    const current = await currentTcAssignment(userId);
    const unchanged =
      current.tcUserId !== null &&
      (current.contact?.email ?? "").toLowerCase() === email;
    const tcUserId = unchanged ? current.tcUserId : null;

    await saveTcAssignment({
      agentId: userId,
      contact: { name, email, phone },
      tcUserId,
    });

    // Not linked → issue a tokened invite and email it. `user_id` stays null
    // until they accept: THE agent typing an address is not consent from the
    // person who owns it, and a link is read access to every deal, client, and
    // document in the agent's pipeline (#446).
    //
    // Best-effort on the SEND only. `invited` reports whether the mail went
    // out; the invite row exists either way, and re-saving re-sends (issuing a
    // new token and retiring the old one).
    let invited = false;
    if (!tcUserId) {
      const agent = await prisma.users.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const result = await inviteTc({
        agentId: userId,
        email,
        name,
        agentName: agent?.name ?? "",
        origin: new URL(req.url).origin,
      });
      invited = result.sent;
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
    // Removing the TC must also kill any invite still sitting in an inbox —
    // otherwise "I removed them" leaves a live key to the pipeline (#446).
    await expireOpenTcInvites(userId);

    // 204 No Content — matches the Go DeleteMyTC. useTC().removeTC ignores the body.
    return new Response(null, { status: 204 });
  })) as Response;
}
