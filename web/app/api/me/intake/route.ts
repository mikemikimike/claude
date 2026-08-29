import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import {
  applyIntakeToDeal,
  isIntakeRole,
  parseIntakeAnswers,
  type IntakeRole,
} from "@/lib/intake";
import { emailIntakeUpdated } from "@/lib/notification-email";
import type { DealType } from "@/lib/stages";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the deal an /api/me/intake call is about, ALWAYS scoped to deals the
 * caller participates in — the participant join is the security boundary here,
 * not the JWT role claim (an invited client may have no role yet).
 *
 * An explicit `deal_id` must be one of theirs; without one it is their latest
 * deal of the type their role implies (buy for a buyer, sell for a seller).
 * Shared by GET and POST so a client reads back exactly the deal they write to.
 */
async function resolveIntakeDeal(
  userId: string,
  role: IntakeRole,
  dealIdParam: string | null
): Promise<{ id: string } | null> {
  if (dealIdParam !== null) {
    if (!UUID_RE.test(dealIdParam)) return null;
    return prisma.deals.findFirst({
      where: { id: dealIdParam, deal_participants: { some: { user_id: userId } } },
      select: { id: true },
    });
  }
  const dealType: DealType = role === "buyer" ? "buy" : "sell";
  return prisma.deals.findFirst({
    where: { type: dealType, deal_participants: { some: { user_id: userId } } },
    orderBy: { created_at: "desc" },
    select: { id: true },
  });
}

/** The caller's role for intake purposes: explicit, else their account's. */
async function resolveIntakeRole(
  userId: string,
  explicit: string | undefined
): Promise<IntakeRole | null> {
  if (explicit !== undefined) return isIntakeRole(explicit) ? explicit : null;
  const me = await prisma.users.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  return me && isIntakeRole(me.role) ? me.role : null;
}

// GET /api/me/intake — the caller's OWN submitted questionnaire (#427).
//
// Until now the only read was GET /api/deals/[id]/intake, which is
// participant-scoped and would have worked — but a client does not know their
// deal id, so reaching it meant a round trip through /api/me/deals first. This
// is the client's own door to the same data: same participant scoping, no deal
// id required.
//
// `?role=buyer|seller` and `?deal_id=<uuid>` are optional and mirror POST's
// resolution exactly, so the review screen reads back the deal it will write.
// Returns `{ deal_id, intake }` with `intake: null` when nothing was submitted
// yet — an empty questionnaire is not an error.
export async function GET(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 401);

    const url = new URL(req.url);
    const roleParam = url.searchParams.get("role");
    const role = await resolveIntakeRole(userId, roleParam ?? undefined);
    if (!role) return error("role must be buyer or seller", 400);

    const dealIdParam = url.searchParams.get("deal_id");
    if (dealIdParam !== null && !UUID_RE.test(dealIdParam)) {
      return error("invalid deal_id", 400);
    }
    const deal = await resolveIntakeDeal(userId, role, dealIdParam);
    // A deal that is not theirs is indistinguishable from one that does not
    // exist — the 404 deliberately leaks nothing about other people's deals.
    if (!deal) return error("deal not found", 404);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { intake: true },
    });
    return json({ deal_id: deal.id, intake: row?.intake ?? null });
  })) as Response;
}

type PostBody = {
  // Explicit target deal (e.g. threaded from the invite). Optional — without
  // it the intake lands on the caller's latest participant deal of matching
  // type (buy for buyer intakes, sell for seller intakes).
  deal_id?: string;
  role?: string;
  answers?: unknown;
};

// POST /api/me/intake — persist the caller's onboarding questionnaire onto a
// deal they participate in (#175). No role claim required: brand-new clients
// created via the invite claim may not have JWT roles yet — the deal
// participant lookup is the security boundary.
export async function POST(req: Request): Promise<Response> {
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 401);

    let body: PostBody;
    try {
      body = (await req.json()) as PostBody;
    } catch {
      return error("invalid request body", 400);
    }

    const answers = parseIntakeAnswers(body.answers);
    if (!answers) return error("answers must be a JSON object", 400);

    // Role: explicit (must be buyer|seller) or inferred from the caller's account.
    if (body.role !== undefined && !isIntakeRole(body.role)) {
      return error("role must be buyer or seller", 400);
    }
    const role = await resolveIntakeRole(userId, body.role);
    if (!role) return error("role must be buyer or seller", 400);

    // Resolve the target deal — always scoped to deals the caller participates in.
    if (body.deal_id !== undefined && typeof body.deal_id !== "string") {
      return error("invalid deal_id", 400);
    }
    if (body.deal_id !== undefined && !UUID_RE.test(body.deal_id)) {
      return error("invalid deal_id", 400);
    }
    const target = await resolveIntakeDeal(userId, role, body.deal_id ?? null);
    if (!target) {
      return error(body.deal_id !== undefined ? "deal not found" : "no deal found for intake", 404);
    }
    const dealId = target.id;

    // Whether this is a first submission or an EDIT (#427) — read before the
    // write, because the write is what makes `deals.intake` non-null. It only
    // decides whether to email the agent; the write itself is identical either
    // way (`applyIntakeToDeal` is safely re-entrant — see below).
    const before = await prisma.deals.findUnique({
      where: { id: dealId },
      select: { intake: true },
    });
    const isUpdate = before?.intake != null;

    // #407 — the write also advances a deal still sitting in `intake`, with the
    // matching deal_stage_history row attributed to this client. Without it the
    // portal kept asking them to redo the onboarding they had just finished.
    //
    // #427 — this same call is what an EDIT goes through, and it is safe to
    // re-enter: the advance is gated on the deal still being in `intake` (an
    // already-onboarded deal moves nothing and writes no history row), and the
    // pre-approval task seeder is keyed on `tasks.source`, so an edit can
    // neither re-advance the deal nor mint a second task.
    const advancedTo = await applyIntakeToDeal({
      dealId,
      role,
      answers,
      submittedBy: userId,
    });

    // An edit is news the agent needs — a changed budget or must-have is
    // exactly what they act on. Best-effort: a failed send must never fail the
    // client's save. First submissions are already announced by the invite
    // claim, so only updates are emailed here.
    if (isUpdate) {
      try {
        await emailIntakeUpdated({ req, dealId, role, answers, updatedBy: userId });
      } catch (err) {
        console.error("intake-updated email failed", err);
      }
    }

    return json({ ok: true, deal_id: dealId, stage: advancedTo, updated: isUpdate });
  })) as Response;
}
