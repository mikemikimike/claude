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
import { GET as getTcInviteRoute } from "@/app/api/tc-invites/[token]/route";
import { POST as claimTcInviteRoute } from "@/app/api/tc-invites/[token]/claim/route";
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

  it("does NOT link an existing role='tc' account — it invites them (#446)", async () => {
    // #444 linked here, on the email alone. That made typing an address the
    // whole handshake: one typo'd domain that happened to belong to a real
    // account handed a stranger the agent's pipeline. The link now needs the
    // invitee to accept a token.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "linked@tc.test",
      name: "Linked TC",
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await putTcRoute(
      await req("PUT", { name: "Linked TC", email: "Linked@TC.test", phone: "555-0200" })()
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ user_id: null, invited: true });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
    expect(sent).toHaveLength(1);
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

// ── #446 tokened-invite helpers ──────────────────────────────────────────────

/** The token of the agent's one open (unclaimed) invite. */
async function openTokenFor(agentId: string): Promise<string> {
  const row = await prisma.tc_invites.findFirstOrThrow({
    where: { agent_id: agentId, claimed_at: null },
    orderBy: { created_at: "desc" },
  });
  return row.token;
}

/** POST /api/tc-invites/:token/claim as `sub`, with the default agent claim. */
async function claimTcInvite(
  token: string,
  sub: string,
  body: { email: string; name?: string },
  roles: string[] = ["agent"]
): Promise<Response> {
  return claimTcInviteRoute(
    new Request(`http://localhost/api/tc-invites/${token}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) }
  );
}

/** GET /api/tc-invites/:token — public, no auth. */
async function getTcInvite(token: string): Promise<Response> {
  return getTcInviteRoute(
    new Request(`http://localhost/api/tc-invites/${token}`),
    { params: Promise.resolve({ token }) }
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
    // The link has to carry the token — it is the whole grant (#446).
    const invite = await prisma.tc_invites.findFirstOrThrow({
      where: { email: "tina@tc.test" },
    });
    expect(sent[0].html).toContain(`http://localhost/tc-invite/${invite.token}`);
    // …and it has to die. deal_invites' 7 days, same shape.
    expect(invite.expires_at.getTime()).toBeGreaterThan(Date.now());
    expect(invite.expires_at.getTime()).toBeLessThan(Date.now() + 8 * 864e5);
    expect(invite.claimed_at).toBeNull();
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

  it("invites — never silently links — an EXISTING account (#446)", async () => {
    // #444 linked an existing account straight from the PUT. Same hole as the
    // signup case, just faster: the agent's typo is the only step.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    await createUser({
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
    expect(await res.json()).toMatchObject({ user_id: null, invited: true });
    expect(sent).toHaveLength(1);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
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

describe("TC invite → signup → claim → link, end to end (#415, tokened by #446)", () => {
  it("makes the invitee a tc, links tc_user_id, and lists the agent", async () => {
    // THE #415 happy path, and the required regression guard: the only thing
    // #446 changes is that the token — not the email — is what carries it.
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "agent@x.test",
      name: "Agent Able",
    });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    // 1. The agent adds a TC who has no account. She is NOT linked yet.
    expect(
      (await putTcRoute(await req("PUT", { name: "Tina Coord", email: "tina@tc.test" })()))
        .status
    ).toBe(200);
    const token = await openTokenFor(agent.id);

    // 2. Tina signs up from the link. The tenant hands her the DEFAULT agent
    //    claim; the claim runs FIRST (AuthSetup), which is what makes her a tc.
    const claim = await claimTcInvite(token, "auth0|tina", {
      email: "tina@tc.test",
      name: "Tina Coord",
    });
    expect(claim.status).toBe(200);
    const tina = (await claim.json()) as { id: string; role: string };
    expect(tina.role).toBe("tc");

    // 3. The agent's row is linked.
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

    // 6. …and she can actually see the agent's deals, which is the point.
    await createDeal({ agent_id: agent.id, title: "Tina's Deal" });
    const deals = await listDealsRoute(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|tina", ["tc"]) },
      })
    );
    expect((await deals.json()) as { title: string }[]).toMatchObject([
      { title: "Tina's Deal" },
    ]);
  });

  it("matches the invited email case-insensitively", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "TINA@TC.test" })());
    const token = await openTokenFor(agent.id);

    // The address is stored lowercased; the claim presents whatever the page
    // read back. Neither side may be case-sensitive.
    const claim = await claimTcInvite(token, "auth0|tina", {
      email: "Tina@Tc.TEST",
      name: "Tina",
    });
    const tina = (await claim.json()) as { id: string; role: string };
    expect(tina.role).toBe("tc");

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tina.id);
  });

  it("leaves a PRE-#446 untokenized tc_contact unclaimable — it grants nothing", async () => {
    // What happens to the invites already sitting in prod: the contact text
    // survives (the agent still sees "Invite pending"), but it is no longer a
    // key. Re-saving in Settings issues a real, tokened one.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_contact: { name: "Old TC", email: "old@tc.test", phone: "" } },
    });

    const sync = await syncUser("auth0|old", "old@tc.test", "Old TC");
    expect(sync.status).toBe(200);
    expect((await sync.json()) as { role: string }).toMatchObject({ role: "agent" });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true, tc_contact: true },
    });
    expect(row?.tc_user_id).toBeNull();
    expect(row?.tc_contact).toMatchObject({ email: "old@tc.test" });
  });

  it("does NOT demote an established agent who accepts a TC invite", async () => {
    // An agent who also coordinates for someone keeps their agent account —
    // the link is made, the role is left alone.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const busy = await createUser({
      role: "agent",
      auth0_id: "auth0|busy",
      email: "busy@agent.test",
      name: "Busy Agent",
    });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Busy Agent", email: "busy@agent.test" })());
    const token = await openTokenFor(agent.id);

    const claim = await claimTcInvite(token, "auth0|busy", {
      email: "busy@agent.test",
      name: "Busy Agent",
    });
    expect(claim.status).toBe(200);
    expect((await claim.json()) as { role: string }).toMatchObject({ role: "agent" });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(busy.id);
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

  it("invites a KNOWN TC too — no deal_participants row, no link until they accept (#446)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const tc = await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "tc@tc.test",
      name: "Tina Coord",
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await addParticipant(deal.id, { email: "TC@tc.test", role: "tc" });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);

    // #444 wrote a deal_participants row here AND set tc_user_id. Neither is
    // right: a per-deal TC row is a third notion of "TC" that never reaches the
    // TC dashboard, and the link is not the agent's to make unilaterally.
    const rows = await prisma.deal_participants.findMany({ where: { deal_id: deal.id } });
    expect(rows).toHaveLength(0);
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true, tc_contact: true },
    });
    expect(row?.tc_user_id).toBeNull();
    expect(row?.tc_contact).toMatchObject({ name: "Tina Coord", email: "tc@tc.test" });

    // After the claim, the assignment is live and the agent is listed.
    const token = await openTokenFor(agent.id);
    expect((await claimTcInvite(token, tc.auth0_id, { email: "tc@tc.test" })).status).toBe(200);
    const listed = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tc", ["tc"]) },
      })
    );
    expect((await listed.json()) as { id: string }[]).toMatchObject([{ id: agent.id }]);
  });

  it("is a no-op 200 when the person is ALREADY the linked TC", async () => {
    // Re-adding the TC you already have must not retire the working link and
    // demand they accept all over again.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const tc = await createUser({
      role: "tc",
      auth0_id: "auth0|tc",
      email: "tc@tc.test",
      name: "Tina Coord",
    });
    await prisma.users.update({
      where: { id: agent.id },
      data: {
        tc_user_id: tc.id,
        tc_contact: { name: "Tina Coord", email: "tc@tc.test", phone: "" },
      },
    });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await addParticipant(deal.id, { email: "TC@tc.test", role: "tc" });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tc.id);
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

// ─── #446 — the TC invite needs a TOKEN ──────────────────────────────────────
//
// #415 bound the invite to the EMAIL alone, with no token and no expiry, so
// whoever controlled an invited address could sign up at any point in the
// future and inherit the agent's whole pipeline (listDealsForUser scopes a TC
// by users.tc_user_id). These lock the door.

describe("TC invite hardening (#446)", () => {
  it("does NOT make a tc, or link, when the invited email signs up WITHOUT the token", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    expect(
      (await putTcRoute(await req("PUT", { name: "Tina Coord", email: "tina@tc.test" })()))
        .status
    ).toBe(200);

    // Someone who merely controls tina@tc.test signs up. No token anywhere.
    const sync = await syncUser("auth0|impostor", "tina@tc.test", "Not Tina");
    expect(sync.status).toBe(200);
    expect((await sync.json()) as { role: string }).toMatchObject({ role: "agent" });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
  });

  it("does not link on an EXPIRED token", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const token = await openTokenFor(agent.id);
    await prisma.tc_invites.update({
      where: { token },
      data: { expires_at: new Date(Date.now() - 1000) },
    });

    const res = await claimTcInvite(token, "auth0|tina", { email: "tina@tc.test" });
    expect(res.status).toBe(410);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
    // The landing page must say so BEFORE anyone creates an Auth0 account.
    expect((await getTcInvite(token)).status).toBe(410);
  });

  it("is single-use — a second account can't replay a claimed token", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const token = await openTokenFor(agent.id);

    const first = await claimTcInvite(token, "auth0|tina", { email: "tina@tc.test" });
    expect(first.status).toBe(200);
    const tina = (await first.json()) as { id: string };

    // Someone else who got hold of the forwarded link.
    const second = await claimTcInvite(token, "auth0|second", { email: "tina@tc.test" });
    expect(second.status).toBe(409);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBe(tina.id);
  });

  it("links only the agent named on the token — A's invite can't reach B", async () => {
    const agentA = await createUser({
      role: "agent",
      auth0_id: "auth0|a",
      email: "a@agent.test",
    });
    const agentB = await createUser({
      role: "agent",
      auth0_id: "auth0|b",
      email: "b@agent.test",
    });
    setEmailForTesting(fakeEmail().client);
    // Both agents invite the same person; only A's token is used.
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" }, "auth0|a")());
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" }, "auth0|b")());
    const tokenA = await openTokenFor(agentA.id);

    const res = await claimTcInvite(tokenA, "auth0|tina", { email: "tina@tc.test" });
    expect(res.status).toBe(200);
    const tina = (await res.json()) as { id: string };

    const rows = await prisma.users.findMany({
      where: { id: { in: [agentA.id, agentB.id] } },
      select: { id: true, tc_user_id: true },
      orderBy: { email: "asc" },
    });
    expect(rows).toMatchObject([
      { id: agentA.id, tc_user_id: tina.id },
      { id: agentB.id, tc_user_id: null },
    ]);
  });

  it("binds the claim to the invited email — a token holder can't self-provision", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const token = await openTokenFor(agent.id);

    const res = await claimTcInvite(token, "auth0|thief", { email: "thief@x.test" });
    expect(res.status).toBe(404);
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
  });

  it("retires the outstanding invite when the agent re-points or clears the TC", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);

    // Re-pointed: the first inbox's link stops working.
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const firstToken = await openTokenFor(agent.id);
    await putTcRoute(await req("PUT", { name: "Terry", email: "terry@tc.test" })());
    expect(
      (await claimTcInvite(firstToken, "auth0|tina", { email: "tina@tc.test" })).status
    ).toBe(409);

    // Cleared: so does the second's.
    const secondToken = await openTokenFor(agent.id);
    expect((await deleteTcRoute(await req("DELETE")())).status).toBe(204);
    expect(
      (await claimTcInvite(secondToken, "auth0|terry", { email: "terry@tc.test" })).status
    ).toBe(409);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
  });

  it("refuses a self-claim and a claim from a portal client", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "agent@x.test",
    });
    await createUser({ role: "buyer", auth0_id: "auth0|buyer", email: "tina@tc.test" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const token = await openTokenFor(agent.id);

    // The inviting agent opening their own link.
    expect(
      (await claimTcInvite(token, "auth0|agent", { email: "tina@tc.test" })).status
    ).toBe(400);
    // A buyer whose address the agent typed by mistake.
    expect(
      (await claimTcInvite(token, "auth0|buyer", { email: "tina@tc.test" })).status
    ).toBe(409);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { tc_user_id: true },
    });
    expect(row?.tc_user_id).toBeNull();
  });
});

// ─── #446 scope item 3 — TC role revocation actually works ───────────────────
//
// #444 protected a persisted `tc` unconditionally, so dropping someone's Auth0
// `tc` role no longer demoted them: it took a hand-written
// `UPDATE users SET role='agent'`. The protection is now tied to the link that
// made them a TC, which puts revocation in the agent's hands.

describe("TC role revocation (#446)", () => {
  it("demotes an unlinked ex-TC on their next login, with no manual SQL", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" })());
    const token = await openTokenFor(agent.id);
    expect(
      (await claimTcInvite(token, "auth0|tina", { email: "tina@tc.test" })).status
    ).toBe(200);

    // Still linked → still a tc, even on a bare default `agent` claim.
    expect(
      (await (await syncUser("auth0|tina", "tina@tc.test", "Tina")).json()) as { role: string }
    ).toMatchObject({ role: "tc" });

    // The agent removes them in Settings.
    expect((await deleteTcRoute(await req("DELETE")())).status).toBe(204);

    // Next login: back to agent, and they see nobody's pipeline.
    expect(
      (await (await syncUser("auth0|tina", "tina@tc.test", "Tina")).json()) as { role: string }
    ).toMatchObject({ role: "agent" });
    const agents = await getAgentsRoute(
      new Request("http://localhost/api/me/agents", {
        headers: { authorization: await authHeader("auth0|tina", ["agent"]) },
      })
    );
    expect((await agents.json()) as unknown[]).toHaveLength(0);
  });

  it("keeps an Auth0-granted tc a tc even with no link (rule 1)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|rbac", email: "rbac@tc.test" });
    const sync = await syncUser("auth0|rbac", "rbac@tc.test", "RBAC TC", ["tc"]);
    expect((await sync.json()) as { role: string }).toMatchObject({ role: "tc" });
  });

  it("keeps a TC who still serves ANOTHER agent", async () => {
    const agentA = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const agentB = await createUser({ role: "agent", auth0_id: "auth0|b" });
    setEmailForTesting(fakeEmail().client);
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" }, "auth0|a")());
    const tokenA = await openTokenFor(agentA.id);
    await claimTcInvite(tokenA, "auth0|tina", { email: "tina@tc.test" });
    await putTcRoute(await req("PUT", { name: "Tina", email: "tina@tc.test" }, "auth0|b")());
    const tokenB = await openTokenFor(agentB.id);
    await claimTcInvite(tokenB, "auth0|tina", { email: "tina@tc.test" });

    // A drops her; B has not.
    expect((await deleteTcRoute(await req("DELETE", undefined, "auth0|a")())).status).toBe(204);
    expect(
      (await (await syncUser("auth0|tina", "tina@tc.test", "Tina")).json()) as { role: string }
    ).toMatchObject({ role: "tc" });
  });
});
