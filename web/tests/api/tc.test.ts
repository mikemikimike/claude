import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  GET as getTcRoute,
  PUT as putTcRoute,
  DELETE as deleteTcRoute,
} from "@/app/api/me/tc/route";
import { GET as getAgentsRoute } from "@/app/api/me/agents/route";
import { GET as listDealsRoute } from "@/app/api/deals/route";
import { GET as listTasksRoute } from "@/app/api/tasks/route";
import { GET as getChecklistRoute } from "@/app/api/deals/[id]/checklist/route";
import { GET as getContingenciesRoute } from "@/app/api/deals/[id]/contingencies/route";
import { POST as syncRoute } from "@/app/api/users/sync/route";
import { POST as addParticipantRoute } from "@/app/api/deals/[id]/participants/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
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

afterEach(() => {
  // Reset the seam so a stub from one test never leaks into the next.
  setEmailForTesting(undefined);
});

type SentEmail = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
};

/** Minimal Resend-surface fake — mirrors fakeEmail in agent-invites.test.ts. */
function fakeEmail(opts: { throwOnSend?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const client = {
    emails: {
      send: async (payload: SentEmail) => {
        if (opts.throwOnSend) throw new Error("resend boom");
        sent.push(payload);
        return { data: { id: "email_test_1" }, error: null };
      },
    },
  };
  return { client, sent };
}

function req(method: string, body?: unknown, sub = "auth0|agent", roles = ["agent"]) {
  return async () =>
    new Request("http://localhost/api/me/tc", {
      method,
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

describe("GET /api/me/tc", () => {
  it("404 when no TC set, then returns ApiTCInfo after PUT", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    // The PUT below invites a TC with no account, so the email seam must be
    // injected — CI has no Resend credentials (#415).
    setEmailForTesting(fakeEmail().client);

    // Before: no tc_contact → 404 (Go's "no tc assigned").
    const before = await getTcRoute(await req("GET")());
    expect(before.status).toBe(404);

    // Save a TC.
    const put = await putTcRoute(
      await req("PUT", { name: "Tina Coord", email: "TINA@tc.test", phone: "555-0100" })()
    );
    expect(put.status).toBe(200);

    // After: ApiTCInfo shape with lowercased email, null user_id (no platform TC).
    const after = await getTcRoute(await req("GET")());
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({
      name: "Tina Coord",
      email: "tina@tc.test",
      phone: "555-0100",
      user_id: null,
    });
  });

  it("401 without a token", async () => {
    const res = await getTcRoute(new Request("http://localhost/api/me/tc"));
    expect(res.status).toBe(401);
  });

  it("404 when the JWT subject has no DB user", async () => {
    const res = await getTcRoute(
      new Request("http://localhost/api/me/tc", {
        headers: { authorization: await authHeader("auth0|ghost", ["agent"]) },
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/me/tc", () => {
  it("saves name/email/phone (read-back via prisma tc_contact) and returns ApiTCInfo", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);

    const res = await putTcRoute(
      await req("PUT", { name: "  Tina Coord  ", email: "  Tina@TC.test ", phone: "555-0100" })()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Tina Coord",
      email: "tina@tc.test",
      phone: "555-0100",
      user_id: null,
      invited: true,
    });

    // tc_contact JSONB persisted with trimmed name + lowercased email.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_contact: true, tc_user_id: true },
    });
    expect(row?.tc_contact).toEqual({
      name: "Tina Coord",
      email: "tina@tc.test",
      phone: "555-0100",
    });
    expect(row?.tc_user_id).toBeNull();
  });

  it("links tc_user_id when a role='tc' platform user matches the email", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const tcUser = await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "linked@tc.test",
      name: "Linked TC",
    });

    const res = await putTcRoute(
      await req("PUT", { name: "Linked TC", email: "Linked@TC.test", phone: "555-0200" })()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string | null };
    expect(body.user_id).toBe(tcUser.id);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tcUser.id);
  });

  it("400 when name or email missing", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });

    const noName = await putTcRoute(await req("PUT", { name: "", email: "x@tc.test" })());
    expect(noName.status).toBe(400);

    const noEmail = await putTcRoute(await req("PUT", { name: "Tina", email: "  " })());
    expect(noEmail.status).toBe(400);
  });

  it("401 without a token", async () => {
    const res = await putTcRoute(
      new Request("http://localhost/api/me/tc", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Tina", email: "x@tc.test" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/me/tc", () => {
  it("clears tc_contact and tc_user_id; returns 204; subsequent GET is 404", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const tcUser = await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "linked@tc.test",
    });

    // Seed an assigned + linked TC.
    await prisma.users.update({
      where: { id: agent.id },
      data: {
        tc_user_id: tcUser.id,
        tc_contact: { name: "Linked TC", email: "linked@tc.test", phone: "555-0200" },
      },
    });

    const del = await deleteTcRoute(await req("DELETE")());
    expect(del.status).toBe(204);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_contact: true, tc_user_id: true },
    });
    expect(row?.tc_contact).toBeNull();
    expect(row?.tc_user_id).toBeNull();

    const after = await getTcRoute(await req("GET")());
    expect(after.status).toBe(404);
  });

  it("401 without a token", async () => {
    const res = await deleteTcRoute(
      new Request("http://localhost/api/me/tc", { method: "DELETE" })
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me/agents", () => {
  it("returns agents who have the caller as their tc_user_id, with active_deal_count", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc", name: "Coordinator" });

    // Two agents assigned to this TC, plus an unrelated agent that is NOT.
    const agentA = await createUser({ role: "agent", auth0_id: "auth0|a", name: "Agent Able" });
    const agentB = await createUser({ role: "agent", auth0_id: "auth0|b", name: "Agent Baker" });
    const unrelated = await createUser({ role: "agent", auth0_id: "auth0|u", name: "Agent Zed" });

    await prisma.users.updateMany({
      where: { id: { in: [agentA.id, agentB.id] } },
      data: { tc_user_id: tc.id },
    });

    // agentA: 2 open deals + 1 closed (post_close) → active_deal_count = 2.
    await createDeal({ agent_id: agentA.id, stage: "intake" });
    await createDeal({ agent_id: agentA.id, stage: "under_contract" });
    await createDeal({ agent_id: agentA.id, stage: "post_close" });
    // agentB: no deals → 0. unrelated: a deal that must not leak in.
    await createDeal({ agent_id: unrelated.id, stage: "intake" });

    const res = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tc", ["tc"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      name: string;
      email: string;
      phone: string | null;
      active_deal_count: number;
    }[];

    // Only the two assigned agents, ordered by name; unrelated excluded.
    expect(body.map((a) => a.id)).toEqual([agentA.id, agentB.id]);
    const byId = Object.fromEntries(body.map((a) => [a.id, a]));
    expect(byId[agentA.id].active_deal_count).toBe(2);
    expect(byId[agentB.id].active_deal_count).toBe(0);
    expect(byId[agentA.id]).toMatchObject({ name: "Agent Able", email: agentA.email });
    expect(byId[agentA.id].phone).toBeNull();
  });

  it("returns [] when no agents are assigned to the caller", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc" });
    const res = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tc", ["tc"]) },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("401 without a token", async () => {
    const res = await getAgentsRoute(new Request("http://localhost/api/me/agents"));
    expect(res.status).toBe(401);
  });

  it("404 when the JWT subject has no DB user", async () => {
    const res = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|ghost", ["tc"]) },
      })
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// #172 — TC cross-tenant scoping. A TC must only see data for agents who have
// linked them (users.tc_user_id = tc.id). Admins remain global.
// ---------------------------------------------------------------------------

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/**
 * Seeds: TC-A linked to Agent-A (tc_user_id), Agent-B unlinked.
 * Each agent has one deal with one task.
 */
async function seedTwoTenants() {
  const tcA = await createUser({ role: "tc", auth0_id: "auth0|tc-a", name: "TC Able" });
  const agentA = await createUser({ role: "agent", auth0_id: "auth0|agent-a" });
  const agentB = await createUser({ role: "agent", auth0_id: "auth0|agent-b" });
  await prisma.users.update({
    where: { id: agentA.id },
    data: { tc_user_id: tcA.id },
  });
  const dealA = await createDeal({ agent_id: agentA.id, title: "Agent A Deal" });
  const dealB = await createDeal({ agent_id: agentB.id, title: "Agent B Deal" });
  await createTask({ deal_id: dealA.id, title: "Task A" });
  await createTask({ deal_id: dealB.id, title: "Task B" });
  return { tcA, agentA, agentB, dealA, dealB };
}

describe("TC cross-tenant scoping (#172) — GET /api/deals", () => {
  it("TC sees only linked agents' deals; unlinked agent's deal is ABSENT", async () => {
    const { dealA, dealB } = await seedTwoTenants();

    const res = await listDealsRoute(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string }[];
    const ids = body.map((d) => d.id);
    expect(ids).toContain(dealA.id);
    expect(ids).not.toContain(dealB.id);
    expect(body.length).toBe(1);
  });

  it("a TC linked by no agents sees zero deals", async () => {
    await seedTwoTenants();
    await createUser({ role: "tc", auth0_id: "auth0|tc-lonely" });

    const res = await listDealsRoute(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|tc-lonely", ["tc"]) },
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("admin still sees all deals", async () => {
    const { dealA, dealB } = await seedTwoTenants();
    await createUser({ role: "admin", auth0_id: "auth0|admin" });

    const res = await listDealsRoute(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
      })
    );
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as { id: string }[]).map((d) => d.id);
    expect(ids).toContain(dealA.id);
    expect(ids).toContain(dealB.id);
  });
});

describe("TC cross-tenant scoping (#172) — GET /api/tasks", () => {
  it("TC sees only tasks on linked agents' deals", async () => {
    await seedTwoTenants();

    const res = await listTasksRoute(
      new Request("http://localhost/api/tasks", {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string }[];
    expect(body.map((t) => t.title)).toEqual(["Task A"]);
  });

  it("admin still sees all tasks", async () => {
    await seedTwoTenants();
    await createUser({ role: "admin", auth0_id: "auth0|admin" });

    const res = await listTasksRoute(
      new Request("http://localhost/api/tasks", {
        headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
      })
    );
    expect(res.status).toBe(200);
    const titles = ((await res.json()) as { title: string }[]).map((t) => t.title);
    expect(titles).toContain("Task A");
    expect(titles).toContain("Task B");
  });
});

describe("TC cross-tenant scoping (#172) — checklist access", () => {
  it("TC can read the checklist of a linked agent's deal", async () => {
    const { dealA } = await seedTwoTenants();

    const res = await getChecklistRoute(
      new Request(`http://localhost/api/deals/${dealA.id}/checklist`, {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      }),
      ctx(dealA.id)
    );
    expect(res.status).toBe(200);
  });

  it("TC gets 404 on an unlinked agent's checklist", async () => {
    const { dealB } = await seedTwoTenants();

    const res = await getChecklistRoute(
      new Request(`http://localhost/api/deals/${dealB.id}/checklist`, {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      }),
      ctx(dealB.id)
    );
    expect(res.status).toBe(404);
  });

  it("admin still has checklist access to any deal", async () => {
    const { dealB } = await seedTwoTenants();
    await createUser({ role: "admin", auth0_id: "auth0|admin" });

    const res = await getChecklistRoute(
      new Request(`http://localhost/api/deals/${dealB.id}/checklist`, {
        headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
      }),
      ctx(dealB.id)
    );
    expect(res.status).toBe(200);
  });
});

describe("TC cross-tenant scoping (#172) — contingency access", () => {
  it("TC can read contingencies of a linked agent's deal", async () => {
    const { dealA } = await seedTwoTenants();

    const res = await getContingenciesRoute(
      new Request(`http://localhost/api/deals/${dealA.id}/contingencies`, {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      }),
      ctx(dealA.id)
    );
    expect(res.status).toBe(200);
  });

  it("TC gets 403 on an unlinked agent's contingencies", async () => {
    const { dealB } = await seedTwoTenants();

    const res = await getContingenciesRoute(
      new Request(`http://localhost/api/deals/${dealB.id}/contingencies`, {
        headers: { authorization: await authHeader("auth0|tc-a", ["tc"]) },
      }),
      ctx(dealB.id)
    );
    expect(res.status).toBe(403);
  });

  it("admin still has contingency access to any deal", async () => {
    const { dealB } = await seedTwoTenants();
    await createUser({ role: "admin", auth0_id: "auth0|admin" });

    const res = await getContingenciesRoute(
      new Request(`http://localhost/api/deals/${dealB.id}/contingencies`, {
        headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
      }),
      ctx(dealB.id)
    );
    expect(res.status).toBe(200);
  });
});

// ─── #415 — TC invite → signup → link ────────────────────────────────────────
//
// Before this, adding a TC in Settings sent no email, resolved tc_user_id once
// against `role = 'tc'` (which a brand-new signup can never satisfy — the
// tenant hands everyone a default `agent` role), and never backfilled. The
// agent saw a TC card that meant nothing and the TC landed in the agent app.

async function syncUser(
  sub: string,
  email: string,
  name: string,
  roles: string[] = ["agent"]
): Promise<Response> {
  return syncRoute(
    new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      body: JSON.stringify({ email, name }),
    })
  );
}

async function addParticipant(
  dealId: string,
  body: unknown,
  sub = "auth0|agent"
): Promise<Response> {
  return addParticipantRoute(
    new Request(`http://localhost/api/deals/${dealId}/participants`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, ["agent"]),
      },
      body: JSON.stringify(body),
    }),
    ctx(dealId)
  );
}

describe("PUT /api/me/tc — invites a TC who has no account yet (#415)", () => {
  it("emails an invite and reports invited: true", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent", name: "Agent Able" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await putTcRoute(
      await req("PUT", { name: "Tina Coord", email: "Tina@TC.test", phone: "" })()
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_id: string | null; invited: boolean };
    expect(body.user_id).toBeNull();
    expect(body.invited).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("tina@tc.test");
    expect(sent[0].subject).toMatch(/transaction coordinator/i);
    // The link has to get them to the app so they can create the account.
    expect(sent[0].html).toContain("http://localhost");
  });

  it("does not blow up the save when the send fails", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const { client } = fakeEmail({ throwOnSend: true });
    setEmailForTesting(client);

    const res = await putTcRoute(
      await req("PUT", { name: "Tina Coord", email: "tina@tc.test" })()
    );
    // Best-effort send: the TC is still saved, invited just reports false.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "tina@tc.test", invited: false });
  });

  it("links an EXISTING account by email alone, whatever role it holds", async () => {
    // The old lookup required role='tc'. A TC invited through any other path
    // (or an existing agent doubling as a TC) could never be linked.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const other = await createUser({
      role: "agent",
      auth0_id: "auth0|other",
      email: "coordinator@tc.test",
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await putTcRoute(
      await req("PUT", { name: "Coordinator", email: "Coordinator@TC.test" })()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: other.id, invited: false });
    // Nothing to invite — they already have an account.
    expect(sent).toHaveLength(0);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(other.id);
  });

  it("refuses to make the agent their own TC", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "self@agent.test",
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await putTcRoute(
      await req("PUT", { name: "Me", email: "Self@Agent.test" })()
    );
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
  });
});

describe("TC invite → signup → link, end to end (#415)", () => {
  it("makes the invitee a tc, backfills tc_user_id, and lists the agent", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "agent@x.test",
      name: "Agent Able",
    });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    // 1. The agent adds a TC who has no account.
    expect(
      (await putTcRoute(await req("PUT", { name: "Tina Coord", email: "tina@tc.test" })()))
        .status
    ).toBe(200);

    // 2. Tina signs up. The tenant hands her the DEFAULT agent claim.
    const sync = await syncUser("auth0|tina", "tina@tc.test", "Tina Coord", ["agent"]);
    expect(sync.status).toBe(200);
    const tina = (await sync.json()) as { id: string; role: string };
    expect(tina.role).toBe("tc");

    // 3. The agent's row is backfilled.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tina.id);

    const tcInfo = await getTcRoute(await req("GET")());
    expect(tcInfo.status).toBe(200);
    expect(await tcInfo.json()).toMatchObject({ email: "tina@tc.test", user_id: tina.id });

    // 4. The agent now shows up under the TC's My Agents.
    const agents = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tina", ["agent"]) },
      })
    );
    expect(agents.status).toBe(200);
    expect((await agents.json()) as { id: string }[]).toMatchObject([{ id: agent.id }]);

    // 5. Her SECOND login (still a default agent claim) must not demote her.
    const resync = await syncUser("auth0|tina", "tina@tc.test", "Tina Coord", ["agent"]);
    expect(resync.status).toBe(200);
    expect((await resync.json()) as { role: string }).toMatchObject({ role: "tc" });
  });

  it("matches the TC contact case-insensitively", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "TINA@TC.test" })());

    const sync = await syncUser("auth0|tina", "Tina@Tc.TEST", "Tina");
    const tina = (await sync.json()) as { id: string; role: string };
    expect(tina.role).toBe("tc");

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tina.id);
  });

  it("backfills a TC who was added BEFORE this fix and already has an account", async () => {
    // The repair case: tc_contact written by the old code, tc_user_id null,
    // and the TC signed up on their own (so they exist as an agent).
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_contact: { name: "Old TC", email: "old@tc.test", phone: "" } },
    });
    const old = await createUser({
      role: "agent",
      auth0_id: "auth0|old",
      email: "old@tc.test",
      name: "Old TC",
    });

    // Their next login repairs the link (their role stays agent — decideRole
    // rule 3 is gated on there being no row yet).
    const sync = await syncUser("auth0|old", "old@tc.test", "Old TC");
    expect(sync.status).toBe(200);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(old.id);
  });

  it("does NOT demote an established agent who someone lists as their TC", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_contact: { name: "Busy Agent", email: "busy@agent.test", phone: "" } },
    });
    await createUser({
      role: "agent",
      auth0_id: "auth0|busy",
      email: "busy@agent.test",
      name: "Busy Agent",
    });

    const sync = await syncUser("auth0|busy", "busy@agent.test", "Busy Agent");
    expect((await sync.json()) as { role: string }).toMatchObject({ role: "agent" });
  });
});

describe("POST /api/deals/:id/participants — role tc (#415)", () => {
  it("invites an unknown TC instead of returning a bare 404", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await addParticipant(deal.id, { email: "New@TC.test", role: "tc" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "invited",
      role: "tc",
      email: "new@tc.test",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("new@tc.test");

    // Same destination as the Settings path — the agent's own TC assignment.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_contact: true },
    });
    expect(row?.tc_contact).toMatchObject({ email: "new@tc.test" });
  });

  it("409s rather than silently replacing an already-assigned TC", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_contact: { name: "Tina", email: "tina@tc.test", phone: "" } },
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await addParticipant(deal.id, { email: "other@tc.test", role: "tc" });
    expect(res.status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("adds a known TC AND links them, so the deal reaches their dashboard", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const tc = await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "tc@tc.test",
      name: "Tina Coord",
    });

    const res = await addParticipant(deal.id, { email: "TC@tc.test", role: "tc" });
    expect(res.status).toBe(200);
    const rows = await prisma.deal_participants.findMany({ where: { deal_id: deal.id } });
    expect(rows).toMatchObject([{ user_id: tc.id, role: "tc" }]);

    // A deal_participants row alone is NOT enough: listDealsForUser scopes a
    // TC by users.tc_user_id, so without this the deal would be invisible in
    // the TC dashboard.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true, tc_contact: true },
    });
    expect(row?.tc_user_id).toBe(tc.id);
    expect(row?.tc_contact).toMatchObject({ name: "Tina Coord", email: "tc@tc.test" });

    const listed = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tc", ["tc"]) },
      })
    );
    expect((await listed.json()) as { id: string }[]).toMatchObject([{ id: agent.id }]);
  });

  it("refuses to make the agent their own TC", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "self@agent.test",
    });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await addParticipant(deal.id, { email: "Self@Agent.test", role: "tc" });
    expect(res.status).toBe(400);
  });

  it("still 404s for a non-TC role with an unknown email", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await addParticipant(deal.id, { email: "nobody@x.test", role: "buyer" });
    expect(res.status).toBe(404);
  });
});
