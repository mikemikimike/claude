import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { GET as listAllRoute } from "@/app/api/tasks/route";
import { GET as listDealsRoute } from "@/app/api/deals/route";
import {
  GET as listByDealRoute,
  POST as createTaskRoute,
} from "@/app/api/deals/[id]/tasks/route";
import { PATCH as updateStatusRoute } from "@/app/api/tasks/[id]/status/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
import { prisma } from "@/lib/db";
import { apiTaskToFrontend } from "@/hooks/useTasks";
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

describe("GET /api/tasks", () => {
  it("returns 401 without auth", async () => {
    const res = await listAllRoute(new Request("http://localhost/api/tasks"));
    expect(res.status).toBe(401);
  });

  it("returns only the agent's own tasks", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent" });
    const mineDeal = await createDeal({ agent_id: agent.id });
    const theirDeal = await createDeal({ agent_id: other.id });
    await createTask({ deal_id: mineDeal.id, title: "Mine" });
    await createTask({ deal_id: theirDeal.id, title: "Theirs" });

    const req = new Request("http://localhost/api/tasks", {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listAllRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("Mine");
  });

  it("returns ALL tasks for admin role", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await createTask({ deal_id: deal.id, title: "T1" });
    await createTask({ deal_id: deal.id, title: "T2" });

    const req = new Request("http://localhost/api/tasks", {
      headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
    });
    const res = await listAllRoute(req);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(2);
  });

  it("returns only linked agents' tasks for tc role (#172)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc" });
    const linkedAgent = await createUser({ role: "agent" });
    const otherAgent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: linkedAgent.id },
      data: { tc_user_id: tc.id },
    });
    const linkedDeal = await createDeal({ agent_id: linkedAgent.id });
    const foreignDeal = await createDeal({ agent_id: otherAgent.id });
    await createTask({ deal_id: linkedDeal.id, title: "Linked task" });
    await createTask({ deal_id: foreignDeal.id, title: "Foreign task" });

    const req = new Request("http://localhost/api/tasks", {
      headers: { authorization: await authHeader("auth0|tc", ["tc"]) },
    });
    const res = await listAllRoute(req);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((t) => t.title)).toEqual(["Linked task"]);
  });
});

describe("GET /api/deals/[id]/tasks", () => {
  it("lists tasks for an owned deal in creation order", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await createTask({ deal_id: deal.id, title: "first" });
    await createTask({ deal_id: deal.id, title: "second" });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listByDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((t) => t.title)).toEqual(["first", "second"]);
  });

  it("404 when the deal isn't owned by the caller", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    void agent;
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listByDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("200 for a TC linked to the deal's owning agent (#167)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    await createTask({ deal_id: deal.id, title: "TC-visible task" });

    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|tc-linked", ["tc"]) },
    });
    const res = await listByDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((t) => t.title)).toEqual(["TC-visible task"]);
  });

  it("200 for admin (#167)", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await createTask({ deal_id: deal.id, title: "Any task" });

    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
    });
    const res = await listByDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.length).toBe(1);
  });

  it("404 for a TC NOT linked to the deal's agent (#167)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|tc-unlinked", ["tc"]) },
    });
    const res = await listByDealRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals/[id]/tasks", () => {
  it("creates a task with defaults", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "Send pre-approval" }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      title: string;
      priority: string;
      source: string;
      role: string;
      status: string;
    };
    expect(body.title).toBe("Send pre-approval");
    expect(body.priority).toBe("medium");
    expect(body.source).toBe("manual");
    expect(body.role).toBe("agent");
    expect(body.status).toBe("pending");
  });

  it("rejects invalid task unions and server-owned preapproval source", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    for (const field of ["source", "priority", "role"] as const) {
      const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ title: "Invalid task", [field]: "nonsense" }),
      });
      const res = await createTaskRoute(req, ctx(deal.id));
      expect(res.status).toBe(400);
    }
    const preapproval = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "Shadow gate", source: "preapproval" }),
    });
    expect((await createTaskRoute(preapproval, ctx(deal.id))).status).toBe(400);
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(0);
  });

  it("400 when title is missing", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ priority: "high" }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });

  it("404 when the deal isn't owned by the caller", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    void agent;
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "x" }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("404 for a linked TC — task creation stays agent-only (#167 policy)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|tc-linked", ["tc"]),
      },
      body: JSON.stringify({ title: "TC-created task" }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals/[id]/tasks — due dates + assignees (#187)", () => {
  it("persists due_date and a deal-member assignee", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        title: "Order appraisal",
        due_date: "2026-08-01",
        assigned_to: agent.id,
      }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      due_date: string | null;
      assigned_to: string | null;
    };
    expect(body.due_date).toBe("2026-08-01");
    expect(body.assigned_to).toBe(agent.id);

    const row = await prisma.tasks.findUnique({ where: { id: body.id } });
    expect(row?.due_date?.toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(row?.assigned_to).toBe(agent.id);
  });

  it("400 on a malformed due_date", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ title: "x", due_date: "not-a-date" }),
    });
    const res = await createTaskRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/tasks/[id]/status — due_date + assignee edits (#187)", () => {
  it("agent can set a task's due_date", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ due_date: "2026-08-15" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { due_date: string | null; status: string };
    expect(body.due_date).toBe("2026-08-15");
    expect(body.status).toBe("pending"); // untouched

    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.due_date?.toISOString().slice(0, 10)).toBe("2026-08-15");
  });

  it("agent can clear a task's due_date with null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({
      deal_id: deal.id,
      due_date: new Date("2026-08-15"),
    });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ due_date: null }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.due_date).toBeNull();
  });

  it("agent can reassign a task to a deal participant", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ assigned_to: buyer.id }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.assigned_to).toBe(buyer.id);
  });

  it("400 when the assignee is not a member of the deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const stranger = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ assigned_to: stranger.id }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(400);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.assigned_to).toBeNull();
  });

  it("400 on a malformed due_date", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    for (const bad of ["not-a-date", "2026-13-40", 123]) {
      const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ due_date: bad }),
      });
      const res = await updateStatusRoute(req, ctx(task.id));
      expect(res.status).toBe(400);
    }
  });

  it("400 when the body has no recognized fields", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({}),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(400);
  });

  it("403 when a participant (not the deal agent) tries to edit due_date", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|b", ["buyer"]),
      },
      body: JSON.stringify({ due_date: "2026-08-15" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(403);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.due_date).toBeNull();
  });

  it("status and due_date can change together in one PATCH", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ status: "in_progress", due_date: "2026-09-01" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("in_progress");
    expect(row?.due_date?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("PATCH /api/tasks/[id]/status — role reassignment (#255)", () => {
  it("agent changes a task's role and the change persists (GET reflects it)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id }); // defaults role 'agent'

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ role: "tc" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("tc");

    // Survives reload: the deal's task list now reports the handed-off role,
    // proving the reassignment left browser memory and reached the DB.
    const listReq = new Request(`http://localhost/api/deals/${deal.id}/tasks`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const listRes = await listByDealRoute(listReq, ctx(deal.id));
    const tasks = (await listRes.json()) as { id: string; role: string }[];
    expect(tasks.find((t) => t.id === task.id)?.role).toBe("tc");
  });

  it("accepts every valid assignee role", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    for (const role of ["agent", "tc", "buyer", "seller", "third_party", "admin"]) {
      const task = await createTask({ deal_id: deal.id });
      const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ role }),
      });
      const res = await updateStatusRoute(req, ctx(task.id));
      expect(res.status).toBe(200);
      const row = await prisma.tasks.findUnique({ where: { id: task.id } });
      expect(row?.role).toBe(role);
    }
  });

  it("400 on an invalid role (leaves the row unchanged)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ role: "wizard" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(400);
    // Rejected specifically for the bad role — not the generic "no fields to
    // update" (which would 400 even if `role` were silently dropped).
    expect((await res.text()).toLowerCase()).toContain("role");
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.role).toBe("agent"); // unchanged
  });

  it("403 when a participant (not the deal agent) tries to reassign role", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|b", ["buyer"]),
      },
      body: JSON.stringify({ role: "tc" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(403);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.role).toBe("agent"); // unchanged
  });

  it("changes role and status together in one PATCH", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ role: "tc", status: "in_progress" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.role).toBe("tc");
    expect(row?.status).toBe("in_progress");
  });
});

describe("PATCH /api/tasks/[id]/status", () => {
  it("updates status when the user owns the parent deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id, status: "pending" });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ status: "completed" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("completed");
  });

  it("lets a deal participant (buyer, not the agent) complete a task", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const task = await createTask({ deal_id: deal.id, status: "pending" });

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|b", ["buyer"]),
      },
      body: JSON.stringify({ status: "completed" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(200);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("completed");
  });

  it("404 for a stranger who is neither the agent nor a participant", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const stranger = await createUser({ role: "buyer", auth0_id: "auth0|s" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id, status: "pending" });
    void stranger;

    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|s", ["buyer"]),
      },
      body: JSON.stringify({ status: "completed" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(404);
    const row = await prisma.tasks.findUnique({ where: { id: task.id } });
    expect(row?.status).toBe("pending");
  });

  it("400 on invalid status string", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });
    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ status: "garbage" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(400);
  });

  it("404 when user doesn't own the parent deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: other.id });
    const task = await createTask({ deal_id: deal.id });
    void agent;
    const req = new Request(`http://localhost/api/tasks/${task.id}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ status: "completed" }),
    });
    const res = await updateStatusRoute(req, ctx(task.id));
    expect(res.status).toBe(404);
  });
});

describe("overdue + deal health from real due dates (#187)", () => {
  it("a pending task with a past due_date turns the deal red with an overdue count", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await createTask({
      deal_id: deal.id,
      title: "Was due yesterday",
      due_date: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    const req = new Request("http://localhost/api/deals", {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listDealsRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      health: string;
      overdue_task_count: number;
    }[];
    const row = body.find((d) => d.id === deal.id);
    expect(row?.health).toBe("red");
    expect(row?.overdue_task_count).toBe(1);
  });

  it("apiTaskToFrontend maps a past-due pending task to overdue (dashboard counts)", () => {
    const base = {
      id: "t1",
      deal_id: "d1",
      assigned_to: null,
      title: "x",
      description: null,
      priority: "medium",
      source: "manual",
      stage_context: null,
      role: "agent",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    } as const;

    const overdue = apiTaskToFrontend({
      ...base,
      status: "pending",
      due_date: "2020-01-01",
    });
    expect(overdue.status).toBe("overdue");

    // A future due date stays pending; completed tasks never flip to overdue.
    const future = apiTaskToFrontend({
      ...base,
      status: "pending",
      due_date: "2099-01-01",
    });
    expect(future.status).toBe("pending");
    const done = apiTaskToFrontend({
      ...base,
      status: "completed",
      due_date: "2020-01-01",
    });
    expect(done.status).toBe("completed");
  });
});

describe("POST /api/deals/[id]/tasks — malformed body validation (#88)", () => {
  async function post(dealId: string, body: string) {
    const req = new Request(`http://localhost/api/deals/${dealId}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return createTaskRoute(req, ctx(dealId));
  }

  it("400 (not 500) when priority is a number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await post(deal.id, JSON.stringify({ title: "Do it", priority: 123 }));
    expect(res.status).toBe(400);
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(0);
  });

  it("400 (not 500) when description is a number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await post(deal.id, JSON.stringify({ title: "Do it", description: 42 }));
    expect(res.status).toBe(400);
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(0);
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await post(deal.id, "null");
    expect(res.status).toBe(400);
  });

  it("400 when assigned_to is a number (was silently ignored)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await post(deal.id, JSON.stringify({ title: "Do it", assigned_to: 99 }));
    expect(res.status).toBe(400);
    expect(await prisma.tasks.count({ where: { deal_id: deal.id } })).toBe(0);
  });
});

describe("PATCH /api/tasks/[id]/status — malformed body validation (#88)", () => {
  async function patch(taskId: string, body: string) {
    const req = new Request(`http://localhost/api/tasks/${taskId}/status`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return updateStatusRoute(req, ctx(taskId));
  }

  it("400 when status is a number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const res = await patch(task.id, JSON.stringify({ status: 123 }));
    expect(res.status).toBe(400);
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const task = await createTask({ deal_id: deal.id });

    const res = await patch(task.id, "null");
    expect(res.status).toBe(400);
  });
});

// #290 — assigning a task must ALSO persist an in-app `notifications` row (not
// email-only) for the assignee, and never for the actor who assigned it.
describe("POST /api/deals/[id]/tasks — in-app notifications (#290)", () => {
  type SentEmail = {
    from: string;
    to: string | string[];
    subject: string;
    html: string;
  };

  /** Records every send so a real Resend call never happens in the test. */
  function fakeEmail() {
    const sent: SentEmail[] = [];
    const client = {
      emails: {
        send: async (payload: SentEmail) => {
          sent.push(payload);
          return { data: { id: "email_test_1" }, error: null };
        },
      },
    };
    return { client, sent };
  }

  afterEach(() => {
    setEmailForTesting(undefined);
  });

  async function createTaskAs(
    dealId: string,
    sub: string,
    roles: string[],
    body: unknown
  ) {
    const req = new Request(`http://localhost/api/deals/${dealId}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      body: JSON.stringify(body),
    });
    return createTaskRoute(req, ctx(dealId));
  }

  it("assigning a task to a buyer participant creates a task_assigned row for the buyer", async () => {
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|a",
      email: "agent@example.com",
    });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|b",
      email: "buyer@example.com",
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await createTaskAs(deal.id, "auth0|a", ["agent"], {
      title: "Upload your pre-approval",
      assigned_to: buyer.id,
    });
    expect(res.status).toBe(201);

    const notes = await prisma.notifications.findMany({
      where: { user_id: buyer.id },
    });
    expect(notes.length).toBe(1);
    expect(notes[0].type).toBe("task_assigned");
    expect(notes[0].deal_id).toBe(deal.id);
    // Email to the assignee unchanged.
    expect(sent.map((e) => e.to)).toContain("buyer@example.com");
  });

  it("does not notify the actor when they assign a task to themselves", async () => {
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await createTaskAs(deal.id, "auth0|a", ["agent"], {
      title: "My own follow-up",
      assigned_to: agent.id,
    });
    expect(res.status).toBe(201);

    const notes = await prisma.notifications.findMany({
      where: { user_id: agent.id },
    });
    expect(notes).toEqual([]);
    // No self-email either (emailTaskAssigned already skips actor === assignee).
    expect(sent).toEqual([]);
  });
});
