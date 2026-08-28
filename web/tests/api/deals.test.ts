import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { GET as listDeals, POST as createDealRoute } from "@/app/api/deals/route";
import { GET as getDealRoute, PATCH as patchDealRoute } from "@/app/api/deals/[id]/route";
import { PATCH as advanceStageRoute } from "@/app/api/deals/[id]/stage/route";
import { PATCH as notesRoute } from "@/app/api/deals/[id]/notes/route";
import { PATCH as commissionRoute } from "@/app/api/deals/[id]/commission/route";
import { PATCH as flagsRoute } from "@/app/api/deals/[id]/flags/route";
import { PATCH as buyerStatusRoute } from "@/app/api/deals/[id]/buyer-status/route";
import { GET as myDealsRoute } from "@/app/api/me/deals/route";
import { PUT as putConfig } from "@/app/api/admin/config/route";
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

describe("GET /api/deals", () => {
  it("returns 401 without auth", async () => {
    const res = await listDeals(new Request("http://localhost/api/deals"));
    expect(res.status).toBe(401);
  });

  it("returns the agent's own deals", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent-1" });
    const other = await createUser({ role: "agent" });
    await createDeal({ agent_id: agent.id, title: "Mine" });
    await createDeal({ agent_id: other.id, title: "Not mine" });

    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|agent-1", ["agent"]) },
    });
    const res = await listDeals(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("Mine");
  });

  it("returns ALL deals for admin role", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin-1" });
    const agent = await createUser({ role: "agent" });
    await createDeal({ agent_id: agent.id, title: "Deal A" });
    await createDeal({ agent_id: agent.id, title: "Deal B" });

    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|admin-1", ["admin"]) },
    });
    const res = await listDeals(req);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(2);
  });

  it("returns only linked agents' deals for tc role (#172)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-1" });
    const linkedAgent = await createUser({ role: "agent" });
    const otherAgent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: linkedAgent.id },
      data: { tc_user_id: tc.id },
    });
    await createDeal({ agent_id: linkedAgent.id, title: "Linked deal" });
    await createDeal({ agent_id: otherAgent.id, title: "Foreign deal" });

    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|tc-1", ["tc"]) },
    });
    const res = await listDeals(req);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title)).toEqual(["Linked deal"]);
  });

  it("returns 404 if user has not been synced yet", async () => {
    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|never-synced", ["agent"]) },
    });
    const res = await listDeals(req);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals", () => {
  it("creates a buy deal and returns it with green health", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "123 Elm", type: "buy", price: 500000 }),
    });
    const res = await createDealRoute(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; stage: string; type: string; health: string };
    expect(body.title).toBe("123 Elm");
    expect(body.type).toBe("buy");
    expect(body.stage).toBe("intake");
    expect(body.health).toBe("green");
  });

  it("400 when type is invalid", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "x", type: "lease" }),
    });
    const res = await createDealRoute(req);
    expect(res.status).toBe(400);
  });

  it("400 when title is missing", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ type: "buy" }),
    });
    const res = await createDealRoute(req);
    expect(res.status).toBe(400);
  });

  it("403 when a buyer tries to create a deal — nothing written (#274)", async () => {
    await createUser({ role: "buyer", auth0_id: "auth0|buyer-274" });
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|buyer-274", ["buyer"]),
      },
      body: JSON.stringify({ title: "Sneaky buyer deal", type: "buy" }),
    });
    const res = await createDealRoute(req);
    expect(res.status).toBe(403);
    // No agent-owned deal was created for the non-agent caller.
    expect(await prisma.deals.count()).toBe(0);
  });

  it("agent still creates a deal — happy path unchanged (#274)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent-274" });
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|agent-274", ["agent"]),
      },
      body: JSON.stringify({ title: "456 Oak", type: "sell" }),
    });
    const res = await createDealRoute(req);
    expect(res.status).toBe(201);
    expect(await prisma.deals.count()).toBe(1);
  });

  it("admin may create a deal; tc and lending_partner are rejected 403 (#274)", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin-274" });
    const adminReq = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|admin-274", ["admin"]),
      },
      body: JSON.stringify({ title: "Admin-created deal", type: "buy" }),
    });
    expect((await createDealRoute(adminReq)).status).toBe(201);

    await createUser({ role: "tc", auth0_id: "auth0|tc-274" });
    const tcReq = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|tc-274", ["tc"]),
      },
      body: JSON.stringify({ title: "TC deal", type: "buy" }),
    });
    expect((await createDealRoute(tcReq)).status).toBe(403);

    await createUser({ role: "lending_partner", auth0_id: "auth0|lp-274" });
    const lpReq = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|lp-274", ["lending_partner"]),
      },
      body: JSON.stringify({ title: "Lending partner deal", type: "buy" }),
    });
    expect((await createDealRoute(lpReq)).status).toBe(403);

    // Only the admin's deal made it into the table.
    expect(await prisma.deals.count()).toBe(1);
  });
});

describe("POST /api/deals — closing_date (#253)", () => {
  async function post(body: Record<string, unknown>) {
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|cd", ["agent"]),
      },
      body: JSON.stringify(body),
    });
    return createDealRoute(req);
  }

  it("persists closing_date and round-trips it on a fresh GET (Case 1)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "123 Elm", type: "buy", closing_date: "2026-09-30" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; closing_date: string | null };
    // The create response carries the date straight back.
    expect(created.closing_date).toBe("2026-09-30");

    // Stored server-side as a real date column.
    const row = await prisma.deals.findUnique({ where: { id: created.id } });
    expect(row?.closing_date?.toISOString().slice(0, 10)).toBe("2026-09-30");

    // A brand-new request (reload) still sees it on the deal payload.
    const getReq = new Request(`http://localhost/api/deals/${created.id}`, {
      headers: { authorization: await authHeader("auth0|cd", ["agent"]) },
    });
    const getRes = await getDealRoute(getReq, ctx(created.id));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { closing_date: string | null };
    expect(body.closing_date).toBe("2026-09-30");
  });

  it("shows the manual closing_date on the pipeline list payload too", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "77 List", type: "sell", closing_date: "2026-10-15" });
    expect(res.status).toBe(201);

    const listReq = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|cd", ["agent"]) },
    });
    const listRes = await listDeals(listReq);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { title: string; closing_date: string | null }[];
    expect(body.find((d) => d.title === "77 List")?.closing_date).toBe("2026-10-15");
  });

  it("201 with closing_date null when the field is omitted (Case 2)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "No date", type: "buy" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { closing_date: string | null };
    expect(body.closing_date).toBeNull();
  });

  it("400 (not silently dropped) for a garbage closing_date string (Case 2)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "Bad", type: "buy", closing_date: "banana" });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("closing_date");
    expect(await prisma.deals.count()).toBe(0);
  });

  it("400 for an out-of-range calendar date (Case 2)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "Bad", type: "buy", closing_date: "2026-13-99" });
    expect(res.status).toBe(400);
    expect(await prisma.deals.count()).toBe(0);
  });

  it("400 when closing_date is a non-string type", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|cd" });
    const res = await post({ title: "Bad", type: "buy", closing_date: 20260930 });
    expect(res.status).toBe(400);
    expect(await prisma.deals.count()).toBe(0);
  });
});

describe("GET /api/deals/[id]", () => {
  it("404 if not owner", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    void agent;
    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("returns the deal with computed health", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; health: string };
    expect(body.id).toBe(deal.id);
    expect(body.health).toBe("green");
  });

  it("returns red health when deal has overdue tasks", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    await createTask({
      deal_id: deal.id,
      status: "pending",
      due_date: yesterday,
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    const body = (await res.json()) as { health: string };
    expect(body.health).toBe("red");
  });
});

describe("GET /api/deals/[id] — TC/admin/participant read access (#167)", () => {
  it("200 for a TC linked to the deal's owning agent", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });

    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|tc-linked", ["tc"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; health: string };
    expect(body.id).toBe(deal.id);
    expect(body.health).toBe("green");
  });

  it("200 for admin on any deal", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin-1" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|admin-1", ["admin"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(deal.id);
  });

  it("404 for a TC NOT linked to the deal's agent (no cross-tenant read)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|tc-unlinked", ["tc"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("200 for a deal participant (buyer)", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-1" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const req = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|buyer-1", ["buyer"]) },
    });
    const res = await getDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(deal.id);
  });
});

describe("PATCH /api/deals/[id]/stage", () => {
  it("advances the stage and writes deal_stage_history", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const req = new Request(`http://localhost/api/deals/${deal.id}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ stage: "active_search" }),
    });
    const res = await advanceStageRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string };
    expect(body.stage).toBe("active_search");

    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
    });
    expect(history.length).toBe(1);
    expect(history[0].from_stage).toBe("intake");
    expect(history[0].to_stage).toBe("active_search");
  });

  it("blocks on high-priority incomplete task without force flag", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
      title: "Critical thing",
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ stage: "active_search" }),
    });
    const res = await advanceStageRoute(req, ctx(deal.id));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      gate: boolean;
      blocking_tasks: { title: string }[];
    };
    expect(body.gate).toBe(true);
    expect(body.blocking_tasks[0].title).toBe("Critical thing");
  });

  it("force=true bypasses the gate", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/stage?force=true`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ stage: "active_search" }),
    });
    const res = await advanceStageRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
  });

  it("404 when not owner", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    void agent;
    const req = new Request(`http://localhost/api/deals/${deal.id}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ stage: "active_search" }),
    });
    const res = await advanceStageRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("404 for a linked TC — stage changes stay agent-only (#167 policy)", async () => {
    // Decided in #167: read access for a linked TC does NOT extend to
    // advancing/retreating the stage. Only the owning agent moves a deal.
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const req = new Request(`http://localhost/api/deals/${deal.id}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|tc-linked", ["tc"]),
      },
      body: JSON.stringify({ stage: "active_search" }),
    });
    const res = await advanceStageRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.stage).toBe("intake");
  });
});

describe("PATCH /api/deals/[id]/stage — direction-aware notifications (#267)", () => {
  async function patchStage(dealId: string, token: string, stage: string) {
    const req = new Request(`http://localhost/api/deals/${dealId}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: token,
      },
      body: JSON.stringify({ stage }),
    });
    return advanceStageRoute(req, ctx(dealId));
  }

  it("retreat notifies participants with neutral copy, NOT 'moved forward' (#267)", async () => {
    // A busted contract retreats under_contract → active_search. The buyer must
    // not get a cheerful "moved forward" push about the worst news.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const token = await authHeader("auth0|a", ["agent"]);
    const res = await patchStage(deal.id, token, "active_search");
    expect(res.status).toBe(200);

    const notes = await prisma.notifications.findMany({
      where: { deal_id: deal.id, user_id: buyer.id, type: "stage_change" },
    });
    expect(notes.length).toBe(1);
    expect(notes[0].title).not.toContain("moved forward");
    expect(notes[0].title).toBe("Your deal's stage was updated");
    // Neutral, non-celebratory body — client-facing STAGE_LABELS label.
    expect(notes[0].body).toBe("Stage: Property Search");
  });

  it("forward advance keeps the exact 'moved forward' copy (regression)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const token = await authHeader("auth0|a", ["agent"]);
    const res = await patchStage(deal.id, token, "active_search");
    expect(res.status).toBe(200);

    const notes = await prisma.notifications.findMany({
      where: { deal_id: deal.id, user_id: buyer.id, type: "stage_change" },
    });
    expect(notes.length).toBe(1);
    expect(notes[0].title).toBe("Your deal has moved forward");
    expect(notes[0].body).toBe("New stage: Property Search");
  });

  it("retreat with zero participants → 200, no notifications, no crash (#267)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });

    const token = await authHeader("auth0|a", ["agent"]);
    const res = await patchStage(deal.id, token, "active_search");
    expect(res.status).toBe(200);

    const notes = await prisma.notifications.findMany({
      where: { deal_id: deal.id },
    });
    expect(notes.length).toBe(0);

    // History is still written for the retreat (design principle).
    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
    });
    expect(history.length).toBe(1);
    expect(history[0].from_stage).toBe("under_contract");
    expect(history[0].to_stage).toBe("active_search");
  });
});

describe("PATCH /api/deals/[id]/stage — auto-task seeding (#87)", () => {
  async function advance(dealId: string, token: string, stage: string) {
    const req = new Request(`http://localhost/api/deals/${dealId}/stage`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ stage }),
    });
    return advanceStageRoute(req, ctx(dealId));
  }

  it("seeds the buy-side auto-tasks when advancing to active_search", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Jane Buyer",
    });

    const res = await advance(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "active_search"
    );
    expect(res.status).toBe(200);

    const tasks = await prisma.tasks.findMany({
      where: { deal_id: deal.id },
      orderBy: { created_at: "asc" },
    });
    // Same set (and order) the old client-side loop produced for a buy deal.
    expect(tasks.map((t) => t.title)).toEqual([
      "Send pre-approval checklist — Jane Buyer",
      "Schedule initial buyer consultation",
      "Set up saved MLS search for client",
    ]);
    // Every seeded task is AI-sourced, scoped to the entered stage, unassigned,
    // and carries a default due date (so overdue/health/calendar have data).
    for (const t of tasks) {
      expect(t.source).toBe("ai");
      expect(t.stage_context).toBe("active_search");
      expect(t.assigned_to).toBeNull();
      expect(t.due_date).not.toBeNull();
    }
    const byTitle = Object.fromEntries(tasks.map((t) => [t.title, t]));
    expect(byTitle["Send pre-approval checklist — Jane Buyer"].priority).toBe("high");
    expect(byTitle["Send pre-approval checklist — Jane Buyer"].role).toBe("agent");
  });

  it("seeds the sell-side variant tasks (TC + agent roles)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "offer_active",
      type: "sell",
      title: "Sam Seller",
    });

    const res = await advance(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "under_contract"
    );
    expect(res.status).toBe(200);

    const tasks = await prisma.tasks.findMany({ where: { deal_id: deal.id } });
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain("Send executed contract to TC");
    expect(titles).toContain("Open title file with title company");
    const titleTask = tasks.find(
      (t) => t.title === "Open title file with title company"
    );
    expect(titleTask?.role).toBe("tc");
    expect(titleTask?.source).toBe("ai");
    expect(titleTask?.stage_context).toBe("under_contract");
  });

  it("is idempotent — a retried advance to the same stage does not double-seed", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Jane Buyer",
    });
    const token = await authHeader("auth0|a", ["agent"]);

    await advance(deal.id, token, "active_search");
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(3);

    // Retry / double-submit the same advance (race or reload).
    await advance(deal.id, token, "active_search");
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(3);
  });

  it("does not seed when an AI task already exists for the target stage", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Jane Buyer",
    });
    // A pre-existing AI task for active_search (e.g. from an earlier visit).
    await prisma.tasks.create({
      data: {
        deal_id: deal.id,
        title: "Existing ai task",
        source: "ai",
        stage_context: "active_search",
        role: "agent",
      },
    });

    await advance(deal.id, await authHeader("auth0|a", ["agent"]), "active_search");
    // The guard skipped seeding — still just the one pre-existing task.
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(1);
  });
});

describe("PATCH /api/deals/[id]/stage — same-stage no-op + skipped gate (#263)", () => {
  async function patchStage(
    dealId: string,
    token: string,
    stage: string,
    opts: { force?: boolean } = {}
  ) {
    const qs = opts.force ? "?force=true" : "";
    const req = new Request(`http://localhost/api/deals/${dealId}/stage${qs}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ stage }),
    });
    return advanceStageRoute(req, ctx(dealId));
  }

  it("same-stage PATCH is a no-op — no history, notification, or audit rows", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "active_search",
      type: "buy",
      title: "Jane Buyer",
    });
    // A participant so the stage fan-out WOULD write a notification if it ran.
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    // PATCH to the stage the deal is already in (double-clicked confirm / retry).
    const res = await patchStage(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "active_search"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string };
    expect(body.stage).toBe("active_search");

    // No junk written: the from===to history row, the audit row, and the
    // "moved forward" participant notification are all skipped.
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(0);
    expect(
      await prisma.notifications.count({
        where: { deal_id: deal.id, type: "stage_change" },
      })
    ).toBe(0);
    expect(
      await prisma.audit_log.count({
        where: { deal_id: deal.id, event_type: "stage_change" },
      })
    ).toBe(0);
  });

  it("a high-priority 'skipped' task does not block a forward advance", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "skipped",
      stage_context: "intake",
      title: "Explicitly skipped",
    });

    const res = await patchStage(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "active_search"
    );
    // skipped == closed (matches deals.ts open-count / health semantics), so
    // the blocking gate lets the advance through.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage: string };
    expect(body.stage).toBe("active_search");
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(1);
  });

  it("a high-priority 'pending' task still blocks (gate regression guard)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
      title: "Still open",
    });

    const res = await patchStage(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "active_search"
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      gate: boolean;
      blocking_tasks: { title: string }[];
    };
    expect(body.gate).toBe(true);
    expect(body.blocking_tasks[0].title).toBe("Still open");
    // A blocked advance wrote nothing.
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(0);
  });

  it("a real advance still writes one history row, seeds tasks, notifies participants", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Jane Buyer",
    });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await patchStage(
      deal.id,
      await authHeader("auth0|a", ["agent"]),
      "active_search"
    );
    expect(res.status).toBe(200);

    // Exactly one history row for the real transition.
    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
    });
    expect(history.length).toBe(1);
    expect(history[0].from_stage).toBe("intake");
    expect(history[0].to_stage).toBe("active_search");

    // Buy-side auto-tasks seeded.
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(3);

    // Participant notified of the move.
    expect(
      await prisma.notifications.count({
        where: { user_id: buyer.id, deal_id: deal.id, type: "stage_change" },
      })
    ).toBe(1);
  });
});

describe("PATCH /api/deals/[id]/notes", () => {
  it("updates notes for the owning agent", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/notes`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ notes: "internal note" }),
    });
    const res = await notesRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.notes).toBe("internal note");
  });

  it("403 when agent does not own the deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    void agent;
    const req = new Request(`http://localhost/api/deals/${deal.id}/notes`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ notes: "x" }),
    });
    const res = await notesRoute(req, ctx(deal.id));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/deals/[id]/commission", () => {
  it("sets commission_pct in [0, 20]", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/commission`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ commission_pct: 2.5 }),
    });
    const res = await commissionRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
  });

  it("rejects values outside [0, 20]", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/commission`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ commission_pct: 25 }),
    });
    const res = await commissionRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/me/deals — full portal payload (#171)", () => {
  const trackers = [
    {
      name: "APPRAISAL",
      currentTrackerStatus: { status: "COMPLETED" },
    },
  ];
  const keyDates = { closingDate: "2026-08-15" };

  it("includes pre_approved, baa_signed, disclosures_complete and arive_* fields", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-1" });
    const deal = await createDeal({ agent_id: agent.id, title: "Portal Deal" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        pre_approved: true,
        baa_signed: true,
        disclosures_complete: true,
        arive_linked: true,
        arive_milestones: trackers,
        arive_key_dates: keyDates,
        arive_loan_status: "Approved with Conditions",
      },
    });

    const req = new Request("http://localhost/api/me/deals", {
      headers: { authorization: await authHeader("auth0|buyer-1", ["buyer"]) },
    });
    const res = await myDealsRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0].pre_approved).toBe(true);
    expect(body[0].baa_signed).toBe(true);
    expect(body[0].disclosures_complete).toBe(true);
    expect(body[0].arive_linked).toBe(true);
    expect(body[0].arive_milestones).toEqual(trackers);
    expect(body[0].arive_key_dates).toEqual(keyDates);
    expect(body[0].arive_loan_status).toBe("Approved with Conditions");
  });

  it("includes fast_pass and smooth_exit JSON when set", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-2" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const fastPass = {
      status: "active",
      payment_option: "now",
      total_cents: 178700,
      enrolled_at: "2026-07-01T00:00:00.000Z",
    };
    const smoothExit = {
      status: "active",
      payment_option: "from_proceeds",
      estimated_sale_price: 400000,
      fee_cents: 4000,
    };
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fast_pass: fastPass, smooth_exit: smoothExit },
    });

    const req = new Request("http://localhost/api/me/deals", {
      headers: { authorization: await authHeader("auth0|buyer-2", ["buyer"]) },
    });
    const res = await myDealsRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.length).toBe(1);
    expect(body[0].fast_pass).toEqual(fastPass);
    expect(body[0].smooth_exit).toEqual(smoothExit);
  });

  it("does not leak deals (or their data) the caller does not participate in", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-3" });
    const mine = await createDeal({ agent_id: agent.id, title: "My Deal" });
    await prisma.deal_participants.create({
      data: { deal_id: mine.id, user_id: buyer.id, role: "buyer" },
    });
    // A stranger's deal loaded with sensitive data that must never surface.
    const foreign = await createDeal({
      agent_id: agent.id,
      title: "SECRET-FOREIGN-DEAL",
    });
    await prisma.deals.update({
      where: { id: foreign.id },
      data: {
        pre_approved: true,
        arive_loan_status: "SECRET-LOAN-STATUS",
        fast_pass: { status: "active", payment_option: "now", marker: "SECRET-FP" },
      },
    });

    const req = new Request("http://localhost/api/me/deals", {
      headers: { authorization: await authHeader("auth0|buyer-3", ["buyer"]) },
    });
    const res = await myDealsRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string }[];
    expect(body.length).toBe(1);
    expect(body[0].id).toBe(mine.id);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SECRET-FOREIGN-DEAL");
    expect(raw).not.toContain("SECRET-LOAN-STATUS");
    expect(raw).not.toContain("SECRET-FP");
  });
});

describe("PATCH /api/deals/[id]/buyer-status (#184)", () => {
  async function patchStatus(dealId: string, token: string, value: unknown) {
    const req = new Request(`http://localhost/api/deals/${dealId}/buyer-status`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: token },
      body: JSON.stringify({ buyer_status: value }),
    });
    return buyerStatusRoute(req, ctx(dealId));
  }

  it("agent sets the status and a seller participant reads it via /api/me/deals", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const seller = await createUser({ role: "seller", auth0_id: "auth0|seller-1" });
    const deal = await createDeal({ agent_id: agent.id, type: "sell", stage: "under_contract" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: seller.id, role: "seller" },
    });

    const res = await patchStatus(deal.id, await authHeader("auth0|a", ["agent"]), "Inspection complete");
    expect(res.status).toBe(200);

    const sellerReq = new Request("http://localhost/api/me/deals", {
      headers: { authorization: await authHeader("auth0|seller-1", ["seller"]) },
    });
    const sellerRes = await myDealsRoute(sellerReq);
    expect(sellerRes.status).toBe(200);
    const body = (await sellerRes.json()) as { id: string; buyer_status: string | null }[];
    expect(body.length).toBe(1);
    expect(body[0].buyer_status).toBe("Inspection complete");
  });

  it("persists in the DB and comes back on a fresh GET /api/deals/[id] (survives reload)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, type: "sell", stage: "under_contract" });

    const res = await patchStatus(deal.id, await authHeader("auth0|a", ["agent"]), "Appraisal ordered");
    expect(res.status).toBe(200);

    // Persisted server-side — not in anyone's browser store.
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBe("Appraisal ordered");

    // A brand-new request (fresh session/reload) still sees it.
    const getReq = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const getRes = await getDealRoute(getReq, ctx(deal.id));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { buyer_status: string | null };
    expect(body.buyer_status).toBe("Appraisal ordered");
  });

  it("404 when a seller participant tries to set it — writes are agent-only", async () => {
    const agent = await createUser({ role: "agent" });
    const seller = await createUser({ role: "seller", auth0_id: "auth0|seller-2" });
    const deal = await createDeal({ agent_id: agent.id, type: "sell", stage: "under_contract" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: seller.id, role: "seller" },
    });

    const res = await patchStatus(deal.id, await authHeader("auth0|seller-2", ["seller"]), "Clear to close");
    expect(res.status).toBe(404);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBeNull();
  });

  it("404 when another agent (non-owner) tries to set it", async () => {
    const owner = await createUser({ role: "agent" });
    await createUser({ role: "agent", auth0_id: "auth0|intruder" });
    const deal = await createDeal({ agent_id: owner.id });

    const res = await patchStatus(deal.id, await authHeader("auth0|intruder", ["agent"]), "Clear to close");
    expect(res.status).toBe(404);
  });

  it("404 for a linked TC — buyer-status writes stay agent-only (matches #167 stage policy)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({ where: { id: agent.id }, data: { tc_user_id: tc.id } });
    const deal = await createDeal({ agent_id: agent.id, type: "sell", stage: "under_contract" });

    const res = await patchStatus(deal.id, await authHeader("auth0|tc-linked", ["tc"]), "Inspection scheduled");
    expect(res.status).toBe(404);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBeNull();
  });

  it("400 for a status outside the canonical step list", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await patchStatus(deal.id, await authHeader("auth0|a", ["agent"]), "Aliens landed");
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBeNull();
  });

  it("clearing with null empties the status", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { buyer_status: "Financing approved" },
    });

    const res = await patchStatus(deal.id, await authHeader("auth0|a", ["agent"]), null);
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBeNull();
  });
});

describe("POST /api/deals — malformed body validation (#88)", () => {
  async function post(body: string) {
    const req = new Request("http://localhost/api/deals", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return createDealRoute(req);
  }

  it("400 (not 500) when price is a non-numeric string", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const res = await post(
      JSON.stringify({ title: "123 Elm", type: "buy", price: "not-a-number" })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("price");
    expect(await prisma.deals.count()).toBe(0);
  });

  it("still accepts a numeric-string price (current wire tolerance preserved)", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const res = await post(
      JSON.stringify({ title: "123 Elm", type: "buy", price: "500000" })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { price: string | null };
    // DECIMAL(12,2) — the wire value is the text cast with scale 2.
    expect(body.price).toBe("500000.00");
  });

  it("400 (not 500) when the body is JSON null", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const res = await post("null");
    expect(res.status).toBe(400);
  });

  it("400 (not 500) when arive_linked is a string", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const res = await post(
      JSON.stringify({ title: "123 Elm", type: "buy", arive_linked: "yes" })
    );
    expect(res.status).toBe(400);
    expect(await prisma.deals.count()).toBe(0);
  });

  it("400 (not 500) when address is a number", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const res = await post(
      JSON.stringify({ title: "123 Elm", type: "buy", address: 42 })
    );
    expect(res.status).toBe(400);
    expect(await prisma.deals.count()).toBe(0);
  });
});

describe("PATCH /api/deals/[id]/stage — malformed body validation (#88)", () => {
  async function patch(dealId: string, body: string) {
    const req = new Request(`http://localhost/api/deals/${dealId}/stage`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return advanceStageRoute(req, ctx(dealId));
  }

  it("400 (not 500) for a stage outside the canonical list — nothing written", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const res = await patch(deal.id, JSON.stringify({ stage: "warp_speed" }));
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.stage).toBe("intake");
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(0);
  });

  it("400 (not 500) when stage is a number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const res = await patch(deal.id, JSON.stringify({ stage: 5 }));
    expect(res.status).toBe(400);
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const res = await patch(deal.id, "null");
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/deals/[id]/buyer-status — malformed body validation (#88)", () => {
  it("400 when buyer_status is a number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/buyer-status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ buyer_status: 123 }),
    });
    const res = await buyerStatusRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.buyer_status).toBeNull();
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/buyer-status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: "null",
    });
    const res = await buyerStatusRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/deals/[id]/flags", () => {
  it("toggles pre_approved and baa_signed", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/flags`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ pre_approved: true, baa_signed: true }),
    });
    const res = await flagsRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.pre_approved).toBe(true);
    expect(row?.baa_signed).toBe(true);
  });
});

describe("PATCH /api/deals/[id] — edit + soft-archive (#254)", () => {
  async function patchDeal(dealId: string, token: string, body: unknown) {
    const req = new Request(`http://localhost/api/deals/${dealId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: token },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return patchDealRoute(req, ctx(dealId));
  }

  // ── Case 1 (fails today: the route has no PATCH → 405): the owning agent
  //    corrects title + price and a fresh GET reflects the new values.
  it("owning agent edits title + price → 200 and GET returns the new values", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "Wrong Name" });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { price: "400000", address: "1 Old St" },
    });
    const token = await authHeader("auth0|a", ["agent"]);

    const res = await patchDeal(deal.id, token, { title: "Correct Name", price: 525000 });
    expect(res.status).toBe(200);

    // Persisted server-side.
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.title).toBe("Correct Name");
    expect(row?.price?.toString()).toBe("525000");

    // A brand-new request (reload) sees the corrected values.
    const getReq = new Request(`http://localhost/api/deals/${deal.id}`, {
      headers: { authorization: token },
    });
    const getRes = await getDealRoute(getReq, ctx(deal.id));
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { title: string; price: string | null };
    expect(body.title).toBe("Correct Name");
    expect(body.price).toBe("525000.00");
  });

  it("owning agent can also correct the address and closing_date", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const token = await authHeader("auth0|a", ["agent"]);

    const res = await patchDeal(deal.id, token, {
      address: "742 Evergreen Terrace",
      closing_date: "2026-12-01",
    });
    expect(res.status).toBe(200);

    const getRes = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: token },
      }),
      ctx(deal.id)
    );
    const body = (await getRes.json()) as { address: string | null; closing_date: string | null };
    expect(body.address).toBe("742 Evergreen Terrace");
    expect(body.closing_date).toBe("2026-12-01");
  });

  // ── Case 2: archive removes the deal from the default pipeline (but it stays
  //    readable), writes an audit row, and a non-owner cannot touch it.
  it("archiving hides the deal from GET /api/deals by default, writes an audit row, stays readable", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "Fell Through" });
    const token = await authHeader("auth0|a", ["agent"]);

    const res = await patchDeal(deal.id, token, { status: "archived" });
    expect(res.status).toBe(200);

    // Gone from the default pipeline list…
    const listRes = await listDeals(
      new Request("http://localhost/api/deals", { headers: { authorization: token } })
    );
    const listBody = (await listRes.json()) as { id: string }[];
    expect(listBody.find((d) => d.id === deal.id)).toBeUndefined();

    // …but returned when explicitly filtered by status…
    const filteredRes = await listDeals(
      new Request("http://localhost/api/deals?status=archived", {
        headers: { authorization: token },
      })
    );
    const filteredBody = (await filteredRes.json()) as { id: string; status: string }[];
    expect(filteredBody.find((d) => d.id === deal.id)?.status).toBe("archived");

    // …and still readable by direct GET (no hard delete).
    const getRes = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: token },
      }),
      ctx(deal.id)
    );
    expect(getRes.status).toBe(200);
    expect(((await getRes.json()) as { status: string }).status).toBe("archived");

    // The row itself survives (soft archive) and an audit row was written.
    expect(await prisma.deals.count({ where: { id: deal.id } })).toBe(1);
    const audits = await prisma.audit_log.findMany({
      where: { deal_id: deal.id, event_type: "deal_status_change" },
    });
    expect(audits.length).toBe(1);
  });

  it("can also mark a deal fallen_through", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const token = await authHeader("auth0|a", ["agent"]);

    const res = await patchDeal(deal.id, token, { status: "fallen_through" });
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.status).toBe("fallen_through");
  });

  it("404 when a non-owner agent tries to edit — nothing written", async () => {
    const owner = await createUser({ role: "agent" });
    await createUser({ role: "agent", auth0_id: "auth0|intruder" });
    const deal = await createDeal({ agent_id: owner.id, title: "Owned" });

    const res = await patchDeal(deal.id, await authHeader("auth0|intruder", ["agent"]), {
      title: "Hijacked",
    });
    expect(res.status).toBe(404);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.title).toBe("Owned");
    expect(row?.status).toBe("active");
  });

  it("404 when a deal participant (buyer) tries to edit — writes are agent-only", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-254" });
    const deal = await createDeal({ agent_id: agent.id, title: "Owned" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await patchDeal(deal.id, await authHeader("auth0|buyer-254", ["buyer"]), {
      title: "Hijacked",
    });
    expect(res.status).toBe(404);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.title).toBe("Owned");
  });

  // ── Case 3: garbage is rejected with 400 and stage stays /stage-only.
  it("400 for a non-numeric price — nothing written", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "Keep" });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), {
      price: "banana",
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("price");
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.title).toBe("Keep");
  });

  it("400 for an unknown status value", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), {
      status: "exploded",
    });
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.status).toBe("active");
  });

  it("400 for an empty body (no editable fields)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), {});
    expect(res.status).toBe(400);
  });

  it("400 when a blank title is sent (title cannot be cleared)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "Keep" });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), {
      title: "   ",
    });
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.title).toBe("Keep");
  });

  it("400 (stage stays /stage-only) when stage is in the PATCH body — stage unchanged", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), {
      stage: "closing",
    });
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.stage).toBe("intake");
    // No stage-history row was written (the /stage route owns that invariant).
    expect(
      await prisma.deal_stage_history.count({ where: { deal_id: deal.id } })
    ).toBe(0);
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await patchDeal(deal.id, await authHeader("auth0|a", ["agent"]), "null");
    expect(res.status).toBe(400);
  });
});

describe("stage_entered_at anchor survives unrelated writes (#257)", () => {
  async function advance(dealId: string, token: string, stage: string) {
    return advanceStageRoute(
      new Request(`http://localhost/api/deals/${dealId}/stage`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify({ stage }),
      }),
      ctx(dealId)
    );
  }
  async function editNotes(dealId: string, token: string, notes: string) {
    return notesRoute(
      new Request(`http://localhost/api/deals/${dealId}/notes`, {
        method: "PATCH",
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify({ notes }),
      }),
      ctx(dealId)
    );
  }
  async function getDeal(dealId: string, token: string) {
    return getDealRoute(
      new Request(`http://localhost/api/deals/${dealId}`, {
        headers: { authorization: token },
      }),
      ctx(dealId)
    );
  }

  // Case 1: advance the stage, then touch the deal with an UNRELATED write
  // (a note edit, which bumps deals.updated_at). stage_entered_at must reflect
  // the stage change, not the later notes edit. FAILS pre-#257: the field did
  // not exist on the response.
  it("reports the stage-change time, not a later notes edit", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const token = await authHeader("auth0|a", ["agent"]);
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });

    expect((await advance(deal.id, token, "active_search")).status).toBe(200);

    // Pin the stage-entry moment to a fixed point in the past — deterministic,
    // and unmistakably distinct from the notes edit that follows.
    const enteredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    await prisma.deal_stage_history.updateMany({
      where: { deal_id: deal.id },
      data: { changed_at: enteredAt },
    });

    // Unrelated write: bumps deals.updated_at to ~now (the old bug's trigger).
    expect((await editNotes(deal.id, token, "touched later")).status).toBe(200);

    const res = await getDeal(deal.id, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage_entered_at?: string; updated_at: string };

    expect(body.stage_entered_at).toBeDefined();
    const enteredMs = new Date(body.stage_entered_at as string).getTime();
    const updatedMs = new Date(body.updated_at).getTime();
    // Equals the stage-change time (within a second of the pinned value)…
    expect(Math.abs(enteredMs - enteredAt.getTime())).toBeLessThan(1000);
    // …and did NOT follow the notes edit: updated_at jumped to ~now (~5 days later).
    expect(updatedMs - enteredMs).toBeGreaterThan(4 * 24 * 60 * 60 * 1000);
  });

  // Case 2: a never-advanced intake deal has no stage history, so the anchor
  // COALESCEs to created_at.
  it("equals created_at for a never-advanced intake deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const token = await authHeader("auth0|a", ["agent"]);
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });

    const res = await getDeal(deal.id, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stage_entered_at?: string; created_at: string };
    expect(body.stage_entered_at).toBeDefined();
    expect(body.stage_entered_at).toBe(body.created_at);
  });

  // The deals LIST hot-path (listDealsForUser) exposes the same anchor column.
  it("is present on every row of the deals list, defaulting to created_at", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const token = await authHeader("auth0|a", ["agent"]);
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });

    const res = await listDeals(
      new Request("http://localhost/api/deals", { headers: { authorization: token } })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      stage_entered_at?: string;
      created_at: string;
    }[];
    const row = body.find((d) => d.id === deal.id);
    expect(row?.stage_entered_at).toBeDefined();
    expect(row?.stage_entered_at).toBe(row?.created_at);
  });

  // The client portal (GET /api/me/deals) exposes it too.
  it("is present on the client portal payload (/api/me/deals)", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer-257" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await myDealsRoute(
      new Request("http://localhost/api/me/deals", {
        headers: { authorization: await authHeader("auth0|buyer-257", ["buyer"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; stage_entered_at?: string }[];
    expect(body.length).toBe(1);
    expect(body[0]?.stage_entered_at).toBeDefined();
  });
});

describe("deal health honors System Config stage_thresholds (#305)", () => {
  // system_config is NOT cleared by truncateAll (tests/helpers/db.ts preserves
  // it), and the suite shares one DB with fileParallelism:false. Isolate every
  // case explicitly: start AND end with an empty config row so neither these
  // tests nor any file that runs after this one see a stray override.
  beforeEach(async () => {
    await prisma.system_config.deleteMany({});
  });
  afterEach(async () => {
    await prisma.system_config.deleteMany({});
  });

  // Backdate a deal so the health CASE sees it as `daysAgo` days into its
  // current stage. Factory deals have no deal_stage_history rows, so the
  // expression falls back to created_at — which is what we set here. Ages are
  // always chosen 2+ days clear of a threshold so FLOOR(days) never straddles it.
  async function ageDeal(dealId: string, daysAgo: number) {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await prisma.deals.update({
      where: { id: dealId },
      data: { created_at: when },
    });
  }

  // The shipped defaults — must equal the pre-#305 hard-coded CASE values.
  const DEFAULT_THRESHOLDS = {
    intake: 5,
    active_search: 30,
    offer_active: 10,
    under_contract: 35,
    pre_close: 10,
    closing: 5,
    post_close: 21,
  };

  // Save a full SystemConfig via the real admin PUT endpoint (mirrors the UI).
  async function saveConfig(stageThresholds: Record<string, number>) {
    await createUser({ role: "admin", auth0_id: "auth0|admin-cfg-305" });
    const req = new Request("http://localhost/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|admin-cfg-305", ["admin"]),
      },
      body: JSON.stringify({
        config: {
          stage_thresholds: stageThresholds,
          closing_fee_amount: 500,
          fast_pass_base_price: 1500,
          smooth_exit_pct: 1.0,
        },
      }),
    });
    const res = await putConfig(req);
    expect(res.status).toBe(200);
  }

  // ── Case 1: a saved threshold actually changes health. FAILS on pre-#305
  //    code, which ignores system_config and hard-codes intake=5.
  it("lowering the intake threshold flips a 3-day-old intake deal to yellow", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake", title: "Wired" });
    await ageDeal(deal.id, 3);
    // One incomplete task (no due date ⇒ not overdue ⇒ not red) so the yellow
    // branch is reachable.
    await createTask({ deal_id: deal.id, status: "pending" });

    // Baseline with NO saved config: 3 days < default intake threshold (5) ⇒ green.
    const before = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(before.status).toBe(200);
    expect(((await before.json()) as { health: string }).health).toBe("green");

    // Admin lowers the intake threshold to 1 day via System Config.
    await saveConfig({ ...DEFAULT_THRESHOLDS, intake: 1 });

    // Same 3-day-old deal is now past its (1-day) intake threshold ⇒ yellow.
    const after = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(after.status).toBe(200);
    expect(((await after.json()) as { health: string }).health).toBe("yellow");
  });

  it("the lowered threshold also changes health in the deals LIST (hot path)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake", title: "ListWired" });
    await ageDeal(deal.id, 3);
    await createTask({ deal_id: deal.id, status: "pending" });
    await saveConfig({ ...DEFAULT_THRESHOLDS, intake: 1 });

    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; health: string }[];
    expect(body.find((d) => d.title === "ListWired")?.health).toBe("yellow");
  });

  // ── Case 2 (CRITICAL regression guard): with NO config row, health is
  //    byte-for-byte the shipped defaults across EVERY stage, both sides of
  //    each threshold. This must pass before AND after the change.
  it("with no saved config, every stage uses the shipped default thresholds", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });

    const cases: { title: string; stage: DealStage; age: number; want: string }[] = [
      { title: "intake-young", stage: "intake", age: 3, want: "green" }, // 3 < 5
      { title: "intake-old", stage: "intake", age: 10, want: "yellow" }, // 10 > 5
      { title: "search-young", stage: "active_search", age: 20, want: "green" }, // 20 < 30
      { title: "search-old", stage: "active_search", age: 40, want: "yellow" }, // 40 > 30
      { title: "offer-young", stage: "offer_active", age: 5, want: "green" }, // 5 < 10
      { title: "offer-old", stage: "offer_active", age: 15, want: "yellow" }, // 15 > 10
      { title: "uc-young", stage: "under_contract", age: 20, want: "green" }, // 20 < 35
      { title: "uc-old", stage: "under_contract", age: 45, want: "yellow" }, // 45 > 35
      { title: "pre-young", stage: "pre_close", age: 5, want: "green" }, // 5 < 10
      { title: "pre-old", stage: "pre_close", age: 15, want: "yellow" }, // 15 > 10
      { title: "closing-young", stage: "closing", age: 3, want: "green" }, // 3 < 5
      { title: "closing-old", stage: "closing", age: 10, want: "yellow" }, // 10 > 5
      { title: "post-young", stage: "post_close", age: 10, want: "green" }, // 10 < 21
      { title: "post-old", stage: "post_close", age: 25, want: "yellow" }, // 25 > 21
    ];

    for (const c of cases) {
      const d = await createDeal({ agent_id: agent.id, stage: c.stage, title: c.title });
      await ageDeal(d.id, c.age);
      await createTask({ deal_id: d.id, status: "pending" });
    }

    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; health: string }[];
    const byTitle = Object.fromEntries(body.map((d) => [d.title, d.health]));
    for (const c of cases) {
      expect(byTitle[c.title], `${c.title} (${c.stage} @ ${c.age}d)`).toBe(c.want);
    }
  });

  it("with no config, a past-threshold deal with NO incomplete tasks stays green", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake", title: "OldNoTasks" });
    await ageDeal(deal.id, 30); // far past intake's 5-day default…
    // …but no incomplete tasks, so the yellow branch cannot fire.

    const res = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(((await res.json()) as { health: string }).health).toBe("green");
  });

  it("with no config, an overdue task is red regardless of stage age (red precedence)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake", title: "Overdue" });
    await ageDeal(deal.id, 1); // 1 day: well UNDER intake's 5-day default
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await createTask({ deal_id: deal.id, status: "pending", due_date: yesterday });

    const res = await getDealRoute(
      new Request(`http://localhost/api/deals/${deal.id}`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(((await res.json()) as { health: string }).health).toBe("red");
  });

  // ── Robustness: a partial / absent stage_thresholds override must fall back
  //    to the shipped default PER STAGE, never leave a stage unthresholded.
  it("a partial stage_thresholds override falls back to defaults for unset stages", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // Only intake overridden (to 1). active_search must still use its 30 default.
    await saveConfig({ intake: 1 });

    const intakeDeal = await createDeal({ agent_id: agent.id, stage: "intake", title: "PartIntake" });
    await ageDeal(intakeDeal.id, 3);
    await createTask({ deal_id: intakeDeal.id, status: "pending" });

    const searchDeal = await createDeal({ agent_id: agent.id, stage: "active_search", title: "PartSearch" });
    await ageDeal(searchDeal.id, 20); // 20 < 30 default ⇒ still green
    await createTask({ deal_id: searchDeal.id, status: "pending" });

    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    const body = (await res.json()) as { title: string; health: string }[];
    const byTitle = Object.fromEntries(body.map((d) => [d.title, d.health]));
    expect(byTitle["PartIntake"]).toBe("yellow"); // 3 > 1 (override applied)
    expect(byTitle["PartSearch"]).toBe("green"); // 20 < 30 (default fallback)
  });

  it("a saved config with no stage_thresholds key at all uses every default", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // Admin saved only a fee setting; stage_thresholds is entirely absent.
    await createUser({ role: "admin", auth0_id: "auth0|admin-nofld" });
    const putReq = new Request("http://localhost/api/admin/config", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|admin-nofld", ["admin"]),
      },
      body: JSON.stringify({ config: { closing_fee_amount: 500 } }),
    });
    expect((await putConfig(putReq)).status).toBe(200);

    const young = await createDeal({ agent_id: agent.id, stage: "intake", title: "NoFldYoung" });
    await ageDeal(young.id, 3);
    await createTask({ deal_id: young.id, status: "pending" });
    const old = await createDeal({ agent_id: agent.id, stage: "intake", title: "NoFldOld" });
    await ageDeal(old.id, 10);
    await createTask({ deal_id: old.id, status: "pending" });

    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    const body = (await res.json()) as { title: string; health: string }[];
    const byTitle = Object.fromEntries(body.map((d) => [d.title, d.health]));
    expect(byTitle["NoFldYoung"]).toBe("green"); // 3 < 5 default
    expect(byTitle["NoFldOld"]).toBe("yellow"); // 10 > 5 default
  });
});

// ─── Lifecycle status filter (#417) ──────────────────────────────────────────
//
// `deals.status` (#254) has been archivable since migration 000056, but until
// #417 nothing in the app ever asked for a non-active list — so an archived
// deal simply vanished with no way back to it. The Completed Deals section on
// the agent dashboard asks for `?status=archived,fallen_through`, which is the
// contract these tests pin down. The load-bearing one is the no-param case:
// archiving must keep meaning "leaves the pipeline".

/** Archive / fall-through a deal the factory created as `active`. */
async function setDealStatus(dealId: string, status: string): Promise<void> {
  await prisma.deals.update({ where: { id: dealId }, data: { status } });
}

describe("GET /api/deals — ?status= lifecycle filter (#417)", () => {
  it("returns only the agent's archived deals for ?status=archived", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-1" });
    await createDeal({ agent_id: agent.id, title: "Still working it" });
    const done = await createDeal({ agent_id: agent.id, title: "Closed and filed" });
    await setDealStatus(done.id, "archived");

    const req = new Request("http://localhost/api/deals?status=archived", {
      headers: { authorization: await authHeader("auth0|status-agent-1", ["agent"]) },
    });
    const res = await listDeals(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; status: string }[];
    expect(body.map((d) => d.title)).toEqual(["Closed and filed"]);
    expect(body[0].status).toBe("archived");
  });

  it("returns both closed statuses for ?status=archived,fallen_through", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-2" });
    await createDeal({ agent_id: agent.id, title: "Active one" });
    const archived = await createDeal({ agent_id: agent.id, title: "Archived one" });
    const fell = await createDeal({ agent_id: agent.id, title: "Fell through one" });
    await setDealStatus(archived.id, "archived");
    await setDealStatus(fell.id, "fallen_through");

    const req = new Request("http://localhost/api/deals?status=archived,fallen_through", {
      headers: { authorization: await authHeader("auth0|status-agent-2", ["agent"]) },
    });
    const res = await listDeals(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title).sort()).toEqual(["Archived one", "Fell through one"]);
  });

  it("still returns ONLY active deals when no status param is given", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-3" });
    await createDeal({ agent_id: agent.id, title: "Active one" });
    const archived = await createDeal({ agent_id: agent.id, title: "Archived one" });
    const fell = await createDeal({ agent_id: agent.id, title: "Fell through one" });
    await setDealStatus(archived.id, "archived");
    await setDealStatus(fell.id, "fallen_through");

    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|status-agent-3", ["agent"]) },
    });
    const res = await listDeals(req);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title)).toEqual(["Active one"]);
  });

  it("scopes the status filter to the caller — another agent's archived deals never appear", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-4" });
    const other = await createUser({ role: "agent" });
    const mine = await createDeal({ agent_id: agent.id, title: "My archived deal" });
    const theirs = await createDeal({ agent_id: other.id, title: "Their archived deal" });
    await setDealStatus(mine.id, "archived");
    await setDealStatus(theirs.id, "archived");

    const req = new Request("http://localhost/api/deals?status=archived,fallen_through", {
      headers: { authorization: await authHeader("auth0|status-agent-4", ["agent"]) },
    });
    const res = await listDeals(req);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title)).toEqual(["My archived deal"]);
  });

  it("falls back to the active-only default when the status param is garbage", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-5" });
    await createDeal({ agent_id: agent.id, title: "Active one" });
    const archived = await createDeal({ agent_id: agent.id, title: "Archived one" });
    await setDealStatus(archived.id, "archived");

    const req = new Request("http://localhost/api/deals?status=banana,%20drop%20table", {
      headers: { authorization: await authHeader("auth0|status-agent-5", ["agent"]) },
    });
    const res = await listDeals(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title)).toEqual(["Active one"]);
  });

  it("ignores unknown entries mixed into an otherwise valid comma list", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|status-agent-6" });
    await createDeal({ agent_id: agent.id, title: "Active one" });
    const archived = await createDeal({ agent_id: agent.id, title: "Archived one" });
    await setDealStatus(archived.id, "archived");

    const req = new Request("http://localhost/api/deals?status=archived,banana", {
      headers: { authorization: await authHeader("auth0|status-agent-6", ["agent"]) },
    });
    const res = await listDeals(req);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((d) => d.title)).toEqual(["Archived one"]);
  });
});

