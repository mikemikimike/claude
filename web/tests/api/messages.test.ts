import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  GET as listRoute,
  POST as createRoute,
} from "@/app/api/deals/[id]/messages/route";
import { GET as unreadCountRoute } from "@/app/api/messages/unread-count/route";
import { POST as markReadRoute } from "@/app/api/deals/[id]/messages/read/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
import { prisma } from "@/lib/db";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

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

type UnreadCountBody = { total: number; by_deal: Record<string, number> };

describe("GET /api/deals/[id]/messages", () => {
  it("returns 401 without auth", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`);
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(401);
  });

  it("returns 404 when user is not the agent or a participant", async () => {
    const agent = await createUser({ role: "agent" });
    const stranger = await createUser({
      role: "buyer",
      auth0_id: "auth0|stranger",
    });
    const deal = await createDeal({ agent_id: agent.id });
    void stranger;
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      headers: { authorization: await authHeader("auth0|stranger", ["buyer"]) },
    });
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("returns client_thread messages for the agent", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: agent.id,
        channel: "client_thread",
        body: "hello",
      },
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string; sender_role: string }[];
    expect(body.length).toBe(1);
    expect(body[0].body).toBe("hello");
    expect(body[0].sender_role).toBe("agent");
  });

  it("403 when participant requests internal channel", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/messages?channel=internal`,
      { headers: { authorization: await authHeader("auth0|buyer", ["buyer"]) } }
    );
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(403);
  });

  it("200 for a TC linked to the deal's owning agent — client thread (#167)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: agent.id,
        channel: "client_thread",
        body: "hello client",
      },
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      headers: { authorization: await authHeader("auth0|tc-linked", ["tc"]) },
    });
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string }[];
    expect(body.map((m) => m.body)).toEqual(["hello client"]);
  });

  it("linked TC can read the internal channel — Agent + TC only (#177, #167)", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc-linked" });
    const agent = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: agent.id,
        channel: "internal",
        body: "internal note",
      },
    });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/messages?channel=internal`,
      { headers: { authorization: await authHeader("auth0|tc-linked", ["tc"]) } }
    );
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { body: string }[];
    expect(body.map((m) => m.body)).toEqual(["internal note"]);
  });

  it("200 for admin (#167)", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
    });
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
  });

  it("404 for a TC NOT linked to the deal's agent (#167)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      headers: { authorization: await authHeader("auth0|tc-unlinked", ["tc"]) },
    });
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });

  it("404 for an unlinked TC requesting the internal channel (#178)", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/messages?channel=internal`,
      {
        headers: {
          authorization: await authHeader("auth0|tc-unlinked", ["tc"]),
        },
      }
    );
    const res = await listRoute(req, ctx(deal.id));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals/[id]/messages", () => {
  it("creates a client_thread message with sender info", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ body: "hello world" }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      body: string;
      channel: string;
      sender_name: string;
      sender_role: string;
    };
    expect(body.body).toBe("hello world");
    expect(body.channel).toBe("client_thread");
    expect(body.sender_role).toBe("agent");
  });

  it("400 when body is empty", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ body: "" }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });

  it("internal post creates NO notifications for buyer/seller participants (#177)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const seller = await createUser({
      role: "seller",
      auth0_id: "auth0|seller",
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.createMany({
      data: [
        { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
        { deal_id: deal.id, user_id: seller.id, role: "seller" },
      ],
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        channel: "internal",
        body: "agent-only note: seller will take 20k under ask",
      }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);

    const clientNotifications = await prisma.notifications.findMany({
      where: { user_id: { in: [buyer.id, seller.id] } },
    });
    expect(clientNotifications).toEqual([]);
  });

  it("client_thread post still notifies participants with the snippet", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ channel: "client_thread", body: "hello buyer" }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);

    const notifications = await prisma.notifications.findMany({
      where: { user_id: buyer.id },
    });
    expect(notifications.length).toBe(1);
    expect(notifications[0].type).toBe("new_message");
    expect(notifications[0].body).toBe("hello buyer");
    expect(notifications[0].deal_id).toBe(deal.id);
  });

  it("internal post still notifies a TC participant, but never clients (#177)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.createMany({
      data: [
        { deal_id: deal.id, user_id: tc.id, role: "tc" },
        { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
      ],
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ channel: "internal", body: "TC: order the title" }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);

    const tcNotifications = await prisma.notifications.findMany({
      where: { user_id: tc.id },
    });
    expect(tcNotifications.length).toBe(1);
    expect(tcNotifications[0].type).toBe("new_message");

    const buyerNotifications = await prisma.notifications.findMany({
      where: { user_id: buyer.id },
    });
    expect(buyerNotifications).toEqual([]);
  });

  it("participant trying to post to internal is silently demoted to client_thread", async () => {
    const agent = await createUser({ role: "agent" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|buyer", ["buyer"]),
      },
      body: JSON.stringify({ channel: "internal", body: "trying internal" }),
    });
    const res = await createRoute(req, ctx(deal.id));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("client_thread");
  });
});

// #178 — the agent's linked TC (users.tc_user_id) is internal-channel-eligible:
// they can post to the internal thread (never demoted to the client-visible
// thread) and are included in the internal notification fan-out + email.
describe("POST /api/deals/[id]/messages — linked TC internal thread (#178)", () => {
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

  /** Records every send — mirrors the fake in notification-email.test.ts. */
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

  /** An agent with a linked TC (users.tc_user_id) and one deal. */
  async function linkedTCSetup() {
    const tc = await createUser({
      role: "tc",
      auth0_id: "auth0|tc-linked",
      email: "tc@example.com",
    });
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      email: "agent@example.com",
    });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });
    return { tc, agent, deal };
  }

  async function postMessage(
    dealId: string,
    sub: string,
    roles: string[],
    body: unknown
  ) {
    const req = new Request(`http://localhost/api/deals/${dealId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      body: JSON.stringify(body),
    });
    return createRoute(req, ctx(dealId));
  }

  it("linked TC (no participant row) posts to internal → 201, stays internal", async () => {
    const { deal } = await linkedTCSetup();
    const res = await postMessage(deal.id, "auth0|tc-linked", ["tc"], {
      channel: "internal",
      body: "title ordered",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel: string; sender_role: string };
    expect(body.channel).toBe("internal");
    expect(body.sender_role).toBe("tc");

    // Persisted on the internal thread — never visible on the client thread.
    const rows = await prisma.messages.findMany({
      where: { deal_id: deal.id },
    });
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe("internal");
  });

  it("linked TC who IS a participant posting internal is NOT demoted to client_thread", async () => {
    const { tc, deal } = await linkedTCSetup();
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: tc.id, role: "tc" },
    });
    const res = await postMessage(deal.id, "auth0|tc-linked", ["tc"], {
      channel: "internal",
      body: "internal note from TC",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { channel: string };
    expect(body.channel).toBe("internal");
  });

  it("linked TC without a participant row cannot post to the client thread → 403", async () => {
    const { deal } = await linkedTCSetup();
    const res = await postMessage(deal.id, "auth0|tc-linked", ["tc"], {
      channel: "client_thread",
      body: "should not reach clients",
    });
    expect(res.status).toBe(403);
    const count = await prisma.messages.count({ where: { deal_id: deal.id } });
    expect(count).toBe(0);
  });

  it("unlinked TC posting to internal → 404, nothing persisted", async () => {
    await createUser({ role: "tc", auth0_id: "auth0|tc-unlinked" });
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await postMessage(deal.id, "auth0|tc-unlinked", ["tc"], {
      channel: "internal",
      body: "should be rejected",
    });
    expect(res.status).toBe(404);
    const count = await prisma.messages.count({ where: { deal_id: deal.id } });
    expect(count).toBe(0);
  });

  it("agent internal post notifies the linked TC (no participant row) — never clients", async () => {
    const { tc, deal } = await linkedTCSetup();
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const res = await postMessage(deal.id, "auth0|agent", ["agent"], {
      channel: "internal",
      body: "TC: order the title",
    });
    expect(res.status).toBe(201);

    const tcNotifications = await prisma.notifications.findMany({
      where: { user_id: tc.id },
    });
    expect(tcNotifications.length).toBe(1);
    expect(tcNotifications[0].type).toBe("new_message");

    const buyerNotifications = await prisma.notifications.findMany({
      where: { user_id: buyer.id },
    });
    expect(buyerNotifications).toEqual([]);
  });

  it("agent internal post notifies a linked TC who is ALSO a participant exactly once", async () => {
    const { tc, deal } = await linkedTCSetup();
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: tc.id, role: "tc" },
    });
    const res = await postMessage(deal.id, "auth0|agent", ["agent"], {
      channel: "internal",
      body: "no double notification",
    });
    expect(res.status).toBe(201);

    const tcNotifications = await prisma.notifications.findMany({
      where: { user_id: tc.id },
    });
    expect(tcNotifications.length).toBe(1);
  });

  it("linked TC internal post notifies the agent", async () => {
    const { agent, deal } = await linkedTCSetup();
    const res = await postMessage(deal.id, "auth0|tc-linked", ["tc"], {
      channel: "internal",
      body: "done — title ordered",
    });
    expect(res.status).toBe(201);

    const agentNotifications = await prisma.notifications.findMany({
      where: { user_id: agent.id },
    });
    expect(agentNotifications.length).toBe(1);
    expect(agentNotifications[0].type).toBe("new_message");
  });

  it("agent internal post emails the linked TC — never the buyer", async () => {
    const { deal } = await linkedTCSetup();
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
      email: "buyer@example.com",
    });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await postMessage(deal.id, "auth0|agent", ["agent"], {
      channel: "internal",
      body: "internal: inspection moved to Friday",
    });
    expect(res.status).toBe(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("tc@example.com");
    // TC recipients link to the TC deals dashboard, never a client portal.
    expect(sent[0].html).toContain("/tc/deals");
  });

  it("linked TC internal post emails the agent", async () => {
    const { deal } = await linkedTCSetup();
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const res = await postMessage(deal.id, "auth0|tc-linked", ["tc"], {
      channel: "internal",
      body: "heads up — appraisal is in",
    });
    expect(res.status).toBe(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("agent@example.com");
    expect(sent[0].html).toContain(`/agent/deals/${deal.id}`);
  });
});

// ─── Unread message counts (#424) ─────────────────────────────────────────────
//
// The agent nav's Messages badge is fed by GET /api/messages/unread-count and
// cleared by POST /api/deals/:id/messages/read. Both are scoped server-side —
// an agent's count can only ever include their own deals.

describe("unread message counts (#424)", () => {
  async function sendFromClient(dealId: string, senderId: string, body: string) {
    return prisma.messages.create({
      data: { deal_id: dealId, sender_id: senderId, channel: "client_thread", body },
    });
  }

  async function unreadFor(auth0Id: string, roles: string[] = ["agent"]) {
    const req = new Request("http://localhost/api/messages/unread-count", {
      headers: { authorization: await authHeader(auth0Id, roles) },
    });
    const res = await unreadCountRoute(req);
    return { res, body: (await res.json()) as UnreadCountBody };
  }

  async function markRead(
    dealId: string,
    auth0Id: string,
    roles: string[],
    channel: string
  ) {
    return markReadRoute(
      new Request(`http://localhost/api/deals/${dealId}/messages/read`, {
        method: "POST",
        headers: {
          authorization: await authHeader(auth0Id, roles),
          "content-type": "application/json",
        },
        body: JSON.stringify({ channel }),
      }),
      ctx(dealId)
    );
  }

  it("returns 401 without auth", async () => {
    const req = new Request("http://localhost/api/messages/unread-count");
    const res = await unreadCountRoute(req);
    expect(res.status).toBe(401);
  });

  it("Case 2: counts unread client messages across the agent's deals", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const dealA = await createDeal({ agent_id: agent.id });
    const dealB = await createDeal({ agent_id: agent.id });
    for (const d of [dealA, dealB]) {
      await prisma.deal_participants.create({
        data: { deal_id: d.id, user_id: buyer.id, role: "buyer" },
      });
    }
    await sendFromClient(dealA.id, buyer.id, "one");
    await sendFromClient(dealA.id, buyer.id, "two");
    await sendFromClient(dealB.id, buyer.id, "three");

    const { res, body } = await unreadFor("auth0|a");
    expect(res.status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.by_deal[dealA.id]).toBe(2);
    expect(body.by_deal[dealB.id]).toBe(1);
  });

  it("Case 3: zero unread when nothing has come in", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    // The agent's OWN messages are never unread to them.
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: agent.id,
        channel: "client_thread",
        body: "hi there",
      },
    });

    const { res, body } = await unreadFor("auth0|a");
    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.by_deal).toEqual({});
  });

  it("Case 4: marking a thread read drops the count to zero", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await sendFromClient(deal.id, buyer.id, "you around?");

    expect((await unreadFor("auth0|a")).body.total).toBe(1);

    const markRes = await markRead(deal.id, "auth0|a", ["agent"], "client_thread");
    expect(markRes.status).toBe(200);

    expect((await unreadFor("auth0|a")).body.total).toBe(0);

    // …and a message that arrives AFTER the read counts again.
    await sendFromClient(deal.id, buyer.id, "still there?");
    expect((await unreadFor("auth0|a")).body.total).toBe(1);
  });

  it("Case 5: an agent never sees another agent's message counts", async () => {
    const mine = await createUser({ role: "agent", auth0_id: "auth0|mine" });
    const theirs = await createUser({ role: "agent", auth0_id: "auth0|theirs" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });

    const myDeal = await createDeal({ agent_id: mine.id });
    const theirDeal = await createDeal({ agent_id: theirs.id });
    await sendFromClient(myDeal.id, buyer.id, "for me");
    await sendFromClient(theirDeal.id, buyer.id, "not for me");
    await sendFromClient(theirDeal.id, buyer.id, "also not for me");

    const { body } = await unreadFor("auth0|mine");
    expect(body.total).toBe(1);
    expect(Object.keys(body.by_deal)).toEqual([myDeal.id]);
    expect(body.by_deal[theirDeal.id]).toBeUndefined();

    const other = await unreadFor("auth0|theirs");
    expect(other.body.total).toBe(2);
    expect(Object.keys(other.body.by_deal)).toEqual([theirDeal.id]);
  });

  it("the internal thread is a separate conversation from the client thread", async () => {
    const tc = await createUser({ role: "tc", auth0_id: "auth0|tc" });
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: tc.id },
    });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await sendFromClient(deal.id, buyer.id, "client says hi");
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: tc.id,
        channel: "internal",
        body: "tc says hi",
      },
    });

    // Only the client thread feeds the nav badge.
    expect((await unreadFor("auth0|a")).body.total).toBe(1);

    // Reading the internal thread must NOT clear the client thread.
    const markRes = await markRead(deal.id, "auth0|a", ["agent"], "internal");
    expect(markRes.status).toBe(200);
    expect((await unreadFor("auth0|a")).body.total).toBe(1);
  });

  it("a client participant sees only their own deal's unread agent messages", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    await createUser({ role: "buyer", auth0_id: "auth0|s" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await prisma.messages.create({
      data: {
        deal_id: deal.id,
        sender_id: agent.id,
        channel: "client_thread",
        body: "call me",
      },
    });

    expect((await unreadFor("auth0|b", ["buyer"])).body.total).toBe(1);
    expect((await unreadFor("auth0|s", ["buyer"])).body.total).toBe(0);
  });

  it("marking read is rejected for someone with no access to the deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "agent", auth0_id: "auth0|other" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await markRead(deal.id, "auth0|other", ["agent"], "client_thread");
    expect(res.status).toBe(404);
  });
});
