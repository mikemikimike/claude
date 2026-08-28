/**
 * GET /api/deals/[id]/stage-history (#256).
 *
 * Real per-stage durations on the Timeline tab are derived from
 * `deal_stage_history`, but until this endpoint existed nothing exposed those
 * rows to the UI (only lib/deals.ts's health CASE read the table). This route
 * returns the ordered transition log, scoped with the same read access as
 * GET /api/deals/[id] (#167: agent owner, participant, linked TC, or admin).
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { GET as stageHistoryRoute } from "@/app/api/deals/[id]/stage-history/route";
import { PATCH as advanceStageRoute } from "@/app/api/deals/[id]/stage/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { DealStage } from "@/lib/stages";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal, createTask } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Insert a stage-history row directly, with an explicit changed_at. */
async function addHistory(
  dealId: string,
  changedBy: string,
  from: DealStage | null,
  to: DealStage,
  changedAt: Date
): Promise<void> {
  await prisma.deal_stage_history.create({
    data: {
      deal_id: dealId,
      from_stage: from as DealStage,
      to_stage: to as DealStage,
      changed_by: changedBy,
      changed_at: changedAt,
    },
  });
}

async function get(dealId: string, sub: string, roles: string[]) {
  const req = new Request(`http://localhost/api/deals/${dealId}/stage-history`, {
    headers: { authorization: await authHeader(sub, roles) },
  });
  return stageHistoryRoute(req, ctx(dealId));
}

type WireRow = {
  from_stage: string | null;
  to_stage: string;
  changed_at: string;
  changed_by: string;
};

describe("GET /api/deals/[id]/stage-history", () => {
  it("returns 401 without auth", async () => {
    const res = await stageHistoryRoute(
      new Request("http://localhost/api/deals/00000000-0000-0000-0000-000000000000/stage-history"),
      ctx("00000000-0000-0000-0000-000000000000")
    );
    expect(res.status).toBe(401);
  });

  // Case 1 (fails today: the route did not exist → 404).
  it("returns transition rows ordered by changed_at with from/to/changed_at", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "offer_active" });

    const t1 = new Date("2026-01-06T00:00:00.000Z"); // intake -> active_search
    const t2 = new Date("2026-01-26T00:00:00.000Z"); // active_search -> offer_active
    // Insert out of chronological order to prove the route sorts ascending.
    await addHistory(deal.id, agent.id, "active_search", "offer_active", t2);
    await addHistory(deal.id, agent.id, "intake", "active_search", t1);

    const res = await get(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireRow[];

    expect(body.length).toBe(2);
    expect(body[0].from_stage).toBe("intake");
    expect(body[0].to_stage).toBe("active_search");
    expect(new Date(body[0].changed_at).toISOString()).toBe(t1.toISOString());
    expect(body[1].from_stage).toBe("active_search");
    expect(body[1].to_stage).toBe("offer_active");
    expect(new Date(body[1].changed_at).toISOString()).toBe(t2.toISOString());
    // changed_by is exposed for attribution.
    expect(body[0].changed_by).toBe(agent.id);
  });

  it("returns an empty array for a deal with no transitions", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await get(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireRow[];
    expect(body).toEqual([]);
  });

  // Case 2: same read scoping as GET /api/deals/[id] (#167 / #235).
  it("404 for a stranger with no access", async () => {
    const owner = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    await createUser({ role: "agent", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: owner.id });
    await addHistory(deal.id, owner.id, "intake", "active_search", new Date());

    const res = await get(deal.id, "auth0|stranger", ["agent"]);
    expect(res.status).toBe(404);
  });

  it("200 for a deal participant (read access)", async () => {
    const owner = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: owner.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await addHistory(deal.id, owner.id, "intake", "active_search", new Date());

    const res = await get(deal.id, "auth0|buyer", ["buyer"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireRow[];
    expect(body.length).toBe(1);
  });

  it("200 for a TC linked to the deal's owning agent (#167)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    await addHistory(deal.id, agent.id, "intake", "active_search", new Date());

    const res = await get(deal.id, "auth0|tc-linked", ["tc"]);
    expect(res.status).toBe(200);
  });

  it("404 for a TC NOT linked to the deal's agent (#167)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await get(deal.id, "auth0|tc-unlinked", ["tc"]);
    expect(res.status).toBe(404);
  });

  it("200 for admin (#167)", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await addHistory(deal.id, agent.id, "intake", "active_search", new Date());

    const res = await get(deal.id, "auth0|admin", ["admin"]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireRow[];
    expect(body.length).toBe(1);
  });
});

/**
 * PATCH /api/deals/[id]/stage — the blocking-task gate must not re-fire on a
 * stage the deal has already left (#419).
 *
 * Entering `active_search` seeds one `high` auto-task on a buy deal ("Send
 * pre-approval checklist"). Nothing ever completes it, so the gate 422'd every
 * forward advance out of Property Search — forever. Worse, retreating from
 * `offer_active` and advancing again hit the *identical* still-open task, so a
 * transition that visibly succeeded a minute earlier demanded Force Advance a
 * second time.
 *
 * `deal_stage_history` already records that the agent left this stage before —
 * having either satisfied the gate or consciously overridden it — so it is the
 * natural signal: gate a FIRST departure from a stage, never a repeat one.
 */
describe("PATCH /api/deals/[id]/stage — re-entry gate (#419)", () => {
  async function patchStage(
    dealId: string,
    sub: string,
    stage: DealStage,
    force = false
  ) {
    const req = new Request(
      `http://localhost/api/deals/${dealId}/stage${force ? "?force=true" : ""}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader(sub, ["agent"]),
        },
        body: JSON.stringify({ stage }),
      }
    );
    return advanceStageRoute(req, ctx(dealId));
  }

  type GateBody = {
    gate: boolean;
    blocking_tasks: {
      id: string;
      title: string;
      source: string;
      stage_context: string | null;
    }[];
  };

  async function buyDealAtIntake() {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Jane Buyer",
    });
    return { agent, deal };
  }

  // Case 1 + Case 3 + Case 4 — the full retreat/re-advance round trip.
  it("lets a re-advance out of a stage through without force after a retreat", async () => {
    const { deal } = await buyDealAtIntake();

    // intake -> active_search: seeds the auto-tasks, one of them `high`.
    expect((await patchStage(deal.id, "auth0|a", "active_search")).status).toBe(200);
    expect(
      await prisma.tasks.count({
        where: { deal_id: deal.id, source: "ai", stage_context: "active_search" },
      })
    ).toBe(3);

    // The FIRST departure from active_search gates on that seeded high task.
    expect((await patchStage(deal.id, "auth0|a", "offer_active")).status).toBe(422);

    // Force through it, as an agent has to today.
    expect(
      (await patchStage(deal.id, "auth0|a", "offer_active", true)).status
    ).toBe(200);

    // Offer rejected — retreat to active_search. Retreats are never gated.
    expect((await patchStage(deal.id, "auth0|a", "active_search")).status).toBe(200);

    // The seeded task is still open …
    expect(
      await prisma.tasks.count({
        where: {
          deal_id: deal.id,
          priority: "high",
          stage_context: "active_search",
          status: { notIn: ["completed", "skipped"] },
        },
      })
    ).toBe(1);

    // … but the deal has left this stage before, so the gate must not re-fire.
    const reAdvance = await patchStage(deal.id, "auth0|a", "offer_active");
    expect(reAdvance.status).toBe(200);
    expect(((await reAdvance.json()) as { stage: string }).stage).toBe("offer_active");

    // Case 3 — every transition wrote exactly one history row, in order, and
    // no from === to row was ever written.
    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
      orderBy: { changed_at: "asc" },
      select: { from_stage: true, to_stage: true },
    });
    expect(history).toEqual([
      { from_stage: "intake", to_stage: "active_search" },
      { from_stage: "active_search", to_stage: "offer_active" },
      { from_stage: "offer_active", to_stage: "active_search" },
      { from_stage: "active_search", to_stage: "offer_active" },
    ]);
    expect(history.filter((h) => h.from_stage === h.to_stage)).toEqual([]);

    // Case 4 — re-entering a stage does not re-seed its auto-tasks.
    expect(
      await prisma.tasks.count({
        where: { deal_id: deal.id, source: "ai", stage_context: "active_search" },
      })
    ).toBe(3);
    expect(
      await prisma.tasks.count({
        where: { deal_id: deal.id, source: "ai", stage_context: "offer_active" },
      })
    ).toBe(4);
  });

  // Case 2 — no regression: a FIRST departure still gates.
  it("still gates the first advance out of a stage with an open high task", async () => {
    const { deal } = await buyDealAtIntake();
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
      title: "Critical thing",
    });

    const res = await patchStage(deal.id, "auth0|a", "active_search");
    expect(res.status).toBe(422);
    const body = (await res.json()) as GateBody;
    expect(body.gate).toBe(true);
    expect(body.blocking_tasks.map((t) => t.title)).toEqual(["Critical thing"]);
    // A blocked advance wrote nothing.
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(0);
  });

  // A prior departure from a DIFFERENT stage must not open the gate here.
  it("does not skip the gate because some other stage was left before", async () => {
    const { agent, deal } = await buyDealAtIntake();
    await prisma.deals.update({
      where: { id: deal.id },
      data: { stage: "active_search" },
    });
    await addHistory(deal.id, agent.id, "intake", "active_search", new Date());
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "active_search",
      title: "Send pre-approval checklist",
    });

    // History holds from_stage='intake' only — leaving active_search is still a
    // first departure, so the gate fires.
    expect((await patchStage(deal.id, "auth0|a", "offer_active")).status).toBe(422);
  });

  // Case 5 (server half) — the 422 payload carries source + stage_context so
  // the modal can say these were auto-generated and name the stage.
  it("returns source and stage_context on each blocking task", async () => {
    const { deal } = await buyDealAtIntake();
    expect((await patchStage(deal.id, "auth0|a", "active_search")).status).toBe(200);

    const res = await patchStage(deal.id, "auth0|a", "offer_active");
    expect(res.status).toBe(422);
    const body = (await res.json()) as GateBody;
    expect(body.blocking_tasks.length).toBe(1);
    expect(body.blocking_tasks[0].source).toBe("ai");
    expect(body.blocking_tasks[0].stage_context).toBe("active_search");
    expect(body.blocking_tasks[0].title).toContain("pre-approval checklist");
  });

  // Case 6 — force still bypasses the gate entirely.
  it("force=true still bypasses the gate on a first departure", async () => {
    const { deal } = await buyDealAtIntake();
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
    });

    const res = await patchStage(deal.id, "auth0|a", "active_search", true);
    expect(res.status).toBe(200);
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(1);
  });
});
