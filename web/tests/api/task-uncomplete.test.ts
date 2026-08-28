/**
 * Un-completing a task, server-side (#408).
 *
 * The UI half of #408 (agent Tasks tab + buyer/seller portals) hid completed
 * tasks so hard that completion became a one-way door. Undo is a plain
 * PATCH /api/tasks/[id]/status back to 'pending' — the route already allowed
 * it, but nothing pinned the *consequences* of using it, and those consequences
 * are the whole point of the fix:
 *
 *  1. the deal's open-task count recovers (it is derived from
 *     `status NOT IN ('completed','skipped')` — lib/deals.ts);
 *  2. a client (buyer/seller participant), not just the agent, may re-open
 *     their own task — that is what the portal undo does;
 *  3. a re-opened high-priority task RE-ARMS the forward-advance gate
 *     (#419/#445). That is correct: the agent said the work is not done, so
 *     the deal should stop advancing past it. It is pinned here so nobody
 *     "fixes" it later by mistaking it for a regression.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PATCH as updateStatusRoute } from "@/app/api/tasks/[id]/status/route";
import { PATCH as advanceStageRoute } from "@/app/api/deals/[id]/stage/route";
import { GET as getDealRoute } from "@/app/api/deals/[id]/route";
import { GET as listDealsRoute } from "@/app/api/deals/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { prisma } from "@/lib/db";
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

async function patchStatus(taskId: string, token: string, status: string) {
  const req = new Request(`http://localhost/api/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ status }),
  });
  return updateStatusRoute(req, ctx(taskId));
}

async function patchStage(dealId: string, token: string, stage: string) {
  const req = new Request(`http://localhost/api/deals/${dealId}/stage`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({ stage }),
  });
  return advanceStageRoute(req, ctx(dealId));
}

/** open_task_count lives on the LIST payload (lib/deals.ts `listDealsForUser`). */
async function openTaskCount(dealId: string, token: string): Promise<number> {
  const res = await listDealsRoute(
    new Request("http://localhost/api/deals", { headers: { authorization: token } })
  );
  const body = (await res.json()) as { id: string; open_task_count: number }[];
  return body.find((d) => d.id === dealId)?.open_task_count ?? -1;
}

/** health is derived per-request by `healthExpr` and rides on the detail payload. */
async function dealHealth(dealId: string, token: string): Promise<string> {
  const req = new Request(`http://localhost/api/deals/${dealId}`, {
    headers: { authorization: token },
  });
  const res = await getDealRoute(req, ctx(dealId));
  return ((await res.json()) as { health: string }).health;
}

describe("PATCH /api/tasks/[id]/status — un-completing (#408)", () => {
  it("moves a completed task back to 'pending' and recovers the open-task count + health", async () => {
    const token = await authHeader("auth0|a", ["agent"]);
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    // A past due date so `healthExpr`'s red branch is observable: completed it
    // is invisible to health, re-opened it is an overdue task again.
    const task = await createTask({
      deal_id: deal.id,
      status: "completed",
      due_date: new Date("2020-01-01"),
      title: "Send the disclosure packet",
    });

    expect(await openTaskCount(deal.id, token)).toBe(0);
    expect(await dealHealth(deal.id, token)).not.toBe("red");

    const res = await patchStatus(task.id, token, "pending");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("pending");

    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("pending");
    expect(await openTaskCount(deal.id, token)).toBe(1);
    expect(await dealHealth(deal.id, token)).toBe("red");
  });

  it("lets a buyer participant re-open their own completed task", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id, stage: "active_search" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const task = await createTask({ deal_id: deal.id, status: "completed" });

    const res = await patchStatus(
      task.id,
      await authHeader("auth0|b", ["buyer"]),
      "pending"
    );

    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("pending");
  });

  it("404s for someone with no access to the deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "agent", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id, status: "completed" });

    const res = await patchStatus(
      task.id,
      await authHeader("auth0|stranger", ["agent"]),
      "pending"
    );

    expect(res.status).toBe(404);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("completed");
  });
});

describe("un-completing re-arms the forward-advance gate (#408 × #419/#445)", () => {
  it("re-gates a stage the deal previously advanced past", async () => {
    const token = await authHeader("auth0|a", ["agent"]);
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    // Agent-created (source 'manual'), so #445's AI-leftover exemption never
    // applies to it — it gates on every forward advance while it is open.
    const task = await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "completed",
      stage_context: "intake",
      title: "Get the buyer agency agreement signed",
    });

    // Done → the gate lets the deal out of intake…
    expect((await patchStage(deal.id, token, "active_search")).status).toBe(200);
    // …and back (a retreat is never gated), leaving a departure-from-intake row
    // in deal_stage_history — the thing #445 measures the exemption against.
    expect((await patchStage(deal.id, token, "intake")).status).toBe(200);

    // The agent realises it was ticked by mistake and re-opens it.
    expect((await patchStatus(task.id, token, "pending")).status).toBe(200);

    // The same advance is now blocked again, naming that task.
    const res = await patchStage(deal.id, token, "active_search");
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      gate: boolean;
      blocking_tasks: { id: string; title: string }[];
    };
    expect(body.gate).toBe(true);
    expect(body.blocking_tasks.map((t) => t.id)).toContain(task.id);

    // The blocked advance changed nothing.
    const after = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(after?.stage).toBe("intake");
  });

  it("stops re-gating once the task is completed again", async () => {
    const token = await authHeader("auth0|a", ["agent"]);
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const task = await createTask({
      deal_id: deal.id,
      priority: "high",
      status: "pending",
      stage_context: "intake",
      title: "Get the buyer agency agreement signed",
    });

    expect((await patchStage(deal.id, token, "active_search")).status).toBe(422);
    expect((await patchStatus(task.id, token, "completed")).status).toBe(200);
    expect((await patchStage(deal.id, token, "active_search")).status).toBe(200);
  });
});
