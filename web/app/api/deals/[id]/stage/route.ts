import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { resolveUserId } from "@/lib/users";
import { getDealForAgent } from "@/lib/deals";
import {
  STAGE_LABELS,
  isForwardAdvance,
} from "@/lib/stages";
import { dealStagePatchBodySchema } from "@/lib/schemas/deal";
import { parseBody } from "@/lib/schemas/parse";
import { logAudit } from "@/lib/audit";
import { createNotification } from "@/lib/notifications";
import { recipientUrl } from "@/lib/notification-email";
import { enqueuePushDealClosingEvent } from "@/lib/jobs";
import { seedStandardContingencies } from "@/lib/contingency-seed";
import { seedStageAutoTasks } from "@/lib/stage-task-seed";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    // Schema-validated (#88): an unknown stage 400s here — it used to reach
    // Prisma's enum validation and 500.
    const parsed = await parseBody(req, dealStagePatchBodySchema);
    if (!parsed.ok) return parsed.response;
    const newStage = parsed.data.stage;
    if (!newStage) return error("stage is required", 400);

    // Look up current stage + ownership.
    const current = await prisma.deals.findFirst({
      where: { id: dealId, agent_id: userId },
      select: { stage: true, type: true, title: true },
    });
    if (!current) return error("deal not found", 404);

    // Same-stage PATCH is a no-op (#263). A double-clicked confirm or a retry
    // targeting the stage the deal is ALREADY in must not run the transaction —
    // otherwise it writes a from===to deal_stage_history row, an audit row, a
    // "moved forward" notification to every participant, and a calendar push,
    // spamming clients and polluting history. Return the fresh deal so the
    // caller still gets current state (retry-safe). No seed needed: a deal
    // already in this stage was seeded when it advanced in.
    if (current.stage === newStage) {
      const fresh = await getDealForAgent(dealId, userId);
      return json(fresh);
    }

    // Blocking-task gate (skipped on force).
    if (!force && isForwardAdvance(current.stage, newStage)) {
      // …but only on the deal's FIRST departure from this stage (#419).
      //
      // Entering a stage seeds its high-priority auto-tasks, and nothing ever
      // completes them, so the gate fired on every forward advance out of the
      // stage — forever. A retreat and re-advance hit the identical still-open
      // task and 422'd again, on a transition that had visibly succeeded a
      // minute earlier. A `deal_stage_history` row with from_stage = the
      // current stage means the agent has already left it once, having either
      // satisfied the gate or consciously overridden it with Force Advance;
      // re-asking is noise. A first departure gates exactly as before.
      const leftBefore = await prisma.deal_stage_history.findFirst({
        where: { deal_id: dealId, from_stage: current.stage },
        select: { id: true },
      });
      if (!leftBefore) {
        const blocking = await prisma.tasks.findMany({
          where: {
            deal_id: dealId,
            priority: "high",
            // 'skipped' is closed, not open (#263) — mirrors deals.ts open-count
            // + healthExpr, the iCal feed, and calendar push, all of which treat
            // NOT IN ('completed','skipped') as the open set. A task the agent
            // explicitly skipped must not 422 the advance.
            status: { notIn: ["completed", "skipped"] },
            OR: [{ stage_context: current.stage }, { stage_context: null }],
          },
          // source + stage_context ride along so the modal can say plainly that
          // a blocker was auto-generated, and name the stage that generated it
          // (#419) — "N required tasks still open" read as the agent's own
          // backlog for work they never created.
          select: { id: true, title: true, source: true, stage_context: true },
        });
        if (blocking.length > 0) {
          return json(
            { gate: true, blocking_tasks: blocking },
            422
          );
        }
      }
    }

    // Transaction: update stage + insert history row.
    await prisma.$transaction([
      prisma.deals.update({
        where: { id: dealId },
        data: { stage: newStage, updated_at: new Date() },
      }),
      prisma.deal_stage_history.create({
        data: {
          deal_id: dealId,
          from_stage: current.stage,
          to_stage: newStage,
          changed_by: userId,
        },
      }),
    ]);

    // Auto-seed the standard inspection/financing/appraisal contingencies the
    // first time a deal goes under contract (#186). Best-effort: idempotent in
    // the lib (only when the deal has zero contingencies), and a failure here
    // must never fail the stage change.
    if (newStage === "under_contract") {
      try {
        await seedStandardContingencies(dealId);
      } catch (err) {
        console.error("contingency auto-seed failed", err);
      }
    }

    // Auto-seed the stage's AI tasks (#87). Moved off the browser, which used
    // to loop POST /tasks after the advance — a tab closed mid-loop left an
    // advanced deal with no tasks, and non-UI callers skipped seeding entirely.
    // Idempotent + best-effort, mirroring the contingency seed above: a failure
    // here must never fail the stage change. clientName mirrors the client
    // mapping (Deal.clientName = deals.title, see hooks/useDeals.ts).
    try {
      await seedStageAutoTasks(dealId, newStage, {
        type: current.type,
        clientName: current.title,
      });
    } catch (err) {
      console.error("stage auto-task seed failed", err);
    }

    // Side-effect fan-out (audit + notifications + calendar push) is AWAITED,
    // not detached: on Vercel the function can freeze once the response is
    // sent, so a stray promise may never run. Each piece is best-effort —
    // logAudit/createNotification swallow internally; the participant lookup
    // is wrapped here — so nothing below can fail the stage change.
    await logAudit({
      actorId: userId,
      eventType: "stage_change",
      dealId,
      metadata: { from_stage: current.stage, to_stage: newStage },
    });

    try {
      const participants = await prisma.deal_participants.findMany({
        where: { deal_id: dealId },
        select: { user_id: true, role: true },
      });
      const label = STAGE_LABELS[newStage] ?? newStage;
      // Direction-aware copy (#267): a retreat — e.g. a busted contract moving
      // under_contract → active_search — must not push clients a celebratory
      // "moved forward" about bad news. Advance copy is kept byte-identical
      // (other tests assert it); retreats get neutral wording.
      const advanced = isForwardAdvance(current.stage, newStage);
      const title = advanced
        ? "Your deal has moved forward"
        : "Your deal's stage was updated";
      const body = advanced ? `New stage: ${label}` : `Stage: ${label}`;
      for (const p of participants) {
        await createNotification({
          userId: p.user_id,
          title,
          body,
          kind: "stage_change",
          dealId,
          // Role-appropriate deep link so the bell navigates, not '#' (#291).
          href: recipientUrl("", p.role, p.user_id, dealId),
        });
      }
    } catch (err) {
      console.error("stage notification fan-out failed", err);
    }

    // Calendar push is best-effort but must be AWAITED, not detached: on Vercel
    // the function can freeze after the response is sent, killing a stray
    // promise. Swallow errors so a calendar hiccup never fails the advance.
    try {
      await enqueuePushDealClosingEvent(dealId);
    } catch (err) {
      console.error("calendar push (closing event) failed", err);
    }

    // Re-fetch with computed health.
    const fresh = await getDealForAgent(dealId, userId);
    return json(fresh);
  })) as Response;
}
