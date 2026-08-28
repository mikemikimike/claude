import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  GET as listPropsRoute,
  POST as createPropRoute,
} from "@/app/api/deals/[id]/properties/route";
import {
  PATCH as patchPropRoute,
  DELETE as deletePropRoute,
} from "@/app/api/deals/[id]/properties/[propId]/route";
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

afterEach(() => {
  // Reset the seam so a stub from one test never leaks into the next.
  setEmailForTesting(undefined);
});

function dealCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}
function propCtx(id: string, propId: string) {
  return { params: Promise.resolve({ id, propId }) };
}

async function seedProperty(dealId: string, auth0: string): Promise<{ id: string }> {
  const req = new Request(`http://localhost/api/deals/${dealId}/properties`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(auth0, ["agent"]),
    },
    body: JSON.stringify({ address: "123 Test St" }),
  });
  const res = await createPropRoute(req, dealCtx(dealId));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function patchProp(
  dealId: string,
  propId: string,
  auth0: string,
  body: object
): Promise<Response> {
  const req = new Request(
    `http://localhost/api/deals/${dealId}/properties/${propId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0, ["agent"]),
      },
      body: JSON.stringify(body),
    }
  );
  return patchPropRoute(req, propCtx(dealId, propId));
}

describe("GET /api/deals/[id]/properties — agent_private_note privacy", () => {
  const PRIVATE_NOTE = "seller is desperate, lowball them";

  async function seedDealWithPrivateNote() {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const prop = await seedProperty(deal.id, "auth0|agent");
    await prisma.tracked_properties.update({
      where: { id: prop.id },
      data: {
        agent_private_note: PRIVATE_NOTE,
        agent_note: "shared agent note",
        buyer_note: "buyer's own note",
        status: "toured",
      },
    });
    return { agent, buyer, deal, prop };
  }

  async function listProps(
    dealId: string,
    auth0: string,
    roles: string[]
  ): Promise<Response> {
    const req = new Request(`http://localhost/api/deals/${dealId}/properties`, {
      headers: { authorization: await authHeader(auth0, roles) },
    });
    return listPropsRoute(req, dealCtx(dealId));
  }

  it("never sends agent_private_note to a buyer participant", async () => {
    const { deal } = await seedDealWithPrivateNote();

    const res = await listProps(deal.id, "auth0|buyer", ["buyer"]);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    // The key must be absent from the wire payload entirely, not just null.
    expect("agent_private_note" in rows[0]).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(PRIVATE_NOTE);
  });

  it("still returns agent_private_note to the owning agent", async () => {
    const { deal } = await seedDealWithPrivateNote();

    const res = await listProps(deal.id, "auth0|agent", ["agent"]);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_private_note).toBe(PRIVATE_NOTE);
  });

  it("leaves all buyer-visible fields intact for the buyer", async () => {
    const { deal, prop } = await seedDealWithPrivateNote();

    const res = await listProps(deal.id, "auth0|buyer", ["buyer"]);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    const row = rows[0];

    expect(row.id).toBe(prop.id);
    expect(row.deal_id).toBe(deal.id);
    expect(row.address).toBe("123 Test St");
    expect(row.status).toBe("toured");
    expect(row.agent_note).toBe("shared agent note");
    expect(row.buyer_note).toBe("buyer's own note");
    expect(row.offer_requested).toBe(false);
    for (const key of [
      "city",
      "state",
      "price",
      "beds",
      "baths",
      "sqft",
      "thumbnail_url",
      "source_url",
      "added_by",
      "created_at",
      "updated_at",
    ]) {
      expect(row).toHaveProperty(key);
    }
  });
});

describe("PATCH /api/deals/[id]/properties/[propId]", () => {
  it("persists status, buyer_note, agent_private_note, and offer_requested", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const prop = await seedProperty(deal.id, "auth0|a");

    for (const body of [
      { status: "touring" },
      { buyer_note: "love the kitchen" },
      { agent_private_note: "overpriced by 20k" },
      { offer_requested: true },
    ]) {
      const res = await patchProp(deal.id, prop.id, "auth0|a", body);
      expect(res.status).toBe(200);
    }

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.status).toBe("touring");
    expect(row?.buyer_note).toBe("love the kitchen");
    expect(row?.agent_private_note).toBe("overpriced by 20k");
    expect(row?.offer_requested).toBe(true);
  });

  it("404s (and persists nothing) for an agent who doesn't own the deal", async () => {
    const owner = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    const deal = await createDeal({ agent_id: owner.id });
    const prop = await seedProperty(deal.id, "auth0|owner");
    await createUser({ role: "agent", auth0_id: "auth0|other" });

    const res = await patchProp(deal.id, prop.id, "auth0|other", {
      status: "touring",
    });
    expect(res.status).toBe(404);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.status).toBe("interested"); // default, unchanged
  });
});

// ─── #168 — buyer participant property writes ────────────────────────────────

type SentEmail = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
};

/** Minimal Resend-surface fake — records every send. Never hits the network. */
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

async function postProp(
  dealId: string,
  auth0: string,
  roles: string[],
  body: object
): Promise<Response> {
  const req = new Request(`http://localhost/api/deals/${dealId}/properties`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(auth0, roles),
    },
    body: JSON.stringify(body),
  });
  return createPropRoute(req, dealCtx(dealId));
}

async function patchPropAs(
  dealId: string,
  propId: string,
  auth0: string,
  roles: string[],
  body: object
): Promise<Response> {
  const req = new Request(
    `http://localhost/api/deals/${dealId}/properties/${propId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0, roles),
      },
      body: JSON.stringify(body),
    }
  );
  return patchPropRoute(req, propCtx(dealId, propId));
}

async function deletePropAs(
  dealId: string,
  propId: string,
  auth0: string,
  roles: string[]
): Promise<Response> {
  const req = new Request(
    `http://localhost/api/deals/${dealId}/properties/${propId}`,
    {
      method: "DELETE",
      headers: { authorization: await authHeader(auth0, roles) },
    }
  );
  return deletePropRoute(req, propCtx(dealId, propId));
}

async function seedBuyerDeal() {
  const agent = await createUser({
    role: "agent",
    auth0_id: "auth0|agent168",
    email: "agent168@example.com",
  });
  const buyer = await createUser({
    role: "buyer",
    auth0_id: "auth0|buyer168",
    email: "buyer168@example.com",
  });
  const stranger = await createUser({
    role: "buyer",
    auth0_id: "auth0|stranger168",
    email: "stranger168@example.com",
  });
  const deal = await createDeal({ agent_id: agent.id });
  await prisma.deal_participants.create({
    data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
  });
  return { agent, buyer, stranger, deal };
}

describe("POST /api/deals/[id]/properties — buyer participant (#168)", () => {
  it("lets a buyer participant add a property, persisted with added_by=buyer", async () => {
    const { deal } = await seedBuyerDeal();

    const res = await postProp(deal.id, "auth0|buyer168", ["buyer"], {
      address: "500 Pine Ave",
      city: "Hoover",
      price: 250000,
      source_url: "https://zillow.com/500-pine",
      status: "interested",
      added_by: "buyer",
      buyer_note: "love this one",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Record<string, unknown>;
    // agent_private_note must never reach a buyer, even on create.
    expect("agent_private_note" in created).toBe(false);

    const row = await prisma.tracked_properties.findFirst({
      where: { deal_id: deal.id },
    });
    expect(row?.address).toBe("500 Pine Ave");
    expect(row?.added_by).toBe("buyer");
    expect(row?.buyer_note).toBe("love this one");
  });

  it("derives added_by server-side — a buyer claiming added_by=agent is still stored as buyer", async () => {
    const { deal } = await seedBuyerDeal();

    const res = await postProp(deal.id, "auth0|buyer168", ["buyer"], {
      address: "1 Spoof St",
      added_by: "agent",
    });
    expect(res.status).toBe(201);

    const row = await prisma.tracked_properties.findFirst({
      where: { deal_id: deal.id },
    });
    expect(row?.added_by).toBe("buyer");
  });

  it("persists agent_note when the owning agent adds a property", async () => {
    const { deal } = await seedBuyerDeal();

    const res = await postProp(deal.id, "auth0|agent168", ["agent"], {
      address: "77 Agent Pick Ln",
      agent_note: "great school district",
    });
    expect(res.status).toBe(201);

    const row = await prisma.tracked_properties.findFirst({
      where: { deal_id: deal.id },
    });
    expect(row?.added_by).toBe("agent");
    expect(row?.agent_note).toBe("great school district");
  });

  it("rejects a buyer trying to write the agent-only agent_note field", async () => {
    const { deal } = await seedBuyerDeal();

    const res = await postProp(deal.id, "auth0|buyer168", ["buyer"], {
      address: "9 Nope St",
      agent_note: "not yours to write",
    });
    expect(res.status).toBe(403);
    expect(await prisma.tracked_properties.count()).toBe(0);
  });

  it("still 404s for a stranger with no deal access", async () => {
    const { deal } = await seedBuyerDeal();

    const res = await postProp(deal.id, "auth0|stranger168", ["buyer"], {
      address: "666 Intruder Way",
    });
    expect(res.status).toBe(404);
    expect(await prisma.tracked_properties.count()).toBe(0);
  });
});

describe("PATCH /api/deals/[id]/properties/[propId] — buyer participant (#168)", () => {
  it("lets a buyer set status, buyer_note, and offer_requested", async () => {
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    for (const body of [
      { status: "toured" },
      { buyer_note: "kitchen needs work" },
      { offer_requested: true },
    ]) {
      const res = await patchPropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"], body);
      expect(res.status).toBe(200);
    }

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.status).toBe("toured");
    expect(row?.buyer_note).toBe("kitchen needs work");
    expect(row?.offer_requested).toBe(true);
  });

  it("rejects a buyer writing agent_private_note (and persists nothing)", async () => {
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await patchPropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"], {
      agent_private_note: "sneaky write",
    });
    expect(res.status).toBe(403);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.agent_private_note).toBeNull();
  });

  it("still 404s for a stranger with no deal access", async () => {
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await patchPropAs(deal.id, prop.id, "auth0|stranger168", ["buyer"], {
      status: "toured",
    });
    expect(res.status).toBe(404);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.status).toBe("interested");
  });

  it("notifies the agent (in-app + email) when a buyer requests an offer", async () => {
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);
    const { agent, deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await patchPropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"], {
      offer_requested: true,
    });
    expect(res.status).toBe(200);

    // In-app notification for the agent.
    const notes = await prisma.notifications.findMany({
      where: { user_id: agent.id, type: "offer_requested" },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toContain("123 Test St");

    // Best-effort email to the agent.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("agent168@example.com");
    expect(sent[0].subject.toLowerCase()).toContain("offer");
    expect(sent[0].html).toContain("123 Test St");
  });

  it("does not re-notify when offer_requested is already true", async () => {
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);
    const { agent, deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    for (let i = 0; i < 2; i++) {
      const res = await patchPropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"], {
        offer_requested: true,
      });
      expect(res.status).toBe(200);
    }

    const notes = await prisma.notifications.findMany({
      where: { user_id: agent.id, type: "offer_requested" },
    });
    expect(notes).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("does not self-notify when the agent sets offer_requested", async () => {
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);
    const { agent, deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await patchPropAs(deal.id, prop.id, "auth0|agent168", ["agent"], {
      offer_requested: true,
    });
    expect(res.status).toBe(200);

    const notes = await prisma.notifications.findMany({
      where: { user_id: agent.id },
    });
    expect(notes).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("a failed notification email never blocks the mutation", async () => {
    setEmailForTesting({
      emails: {
        send: async () => {
          throw new Error("resend boom");
        },
      },
    });
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await patchPropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"], {
      offer_requested: true,
    });
    expect(res.status).toBe(200);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row?.offer_requested).toBe(true);
  });
});

describe("DELETE /api/deals/[id]/properties/[propId] — buyer participant (#168)", () => {
  it("lets a buyer remove a property they added", async () => {
    const { deal } = await seedBuyerDeal();
    const createRes = await postProp(deal.id, "auth0|buyer168", ["buyer"], {
      address: "500 Pine Ave",
    });
    expect(createRes.status).toBe(201);
    const prop = (await createRes.json()) as { id: string };

    const res = await deletePropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"]);
    expect(res.status).toBe(204);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row).toBeNull();
  });

  it("does not let a buyer remove an agent-added property", async () => {
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await deletePropAs(deal.id, prop.id, "auth0|buyer168", ["buyer"]);
    expect(res.status).toBe(403);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row).not.toBeNull();
  });

  it("still 404s for a stranger with no deal access", async () => {
    const { deal } = await seedBuyerDeal();
    const prop = await seedProperty(deal.id, "auth0|agent168");

    const res = await deletePropAs(deal.id, prop.id, "auth0|stranger168", ["buyer"]);
    expect(res.status).toBe(404);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row).not.toBeNull();
  });
});

// ─── #459: nothing a client does may move the agent's Pipeline Value ─────────
//
// #411 backfilled `deals.price` from the tracked listing's list price the
// moment a buyer tapped "Make an Offer", to stop the dashboard reading "$0".
// Paul settled the rule differently (2026-08-28): Pipeline Value fills in at
// **under contract**, from the contract price, and nowhere else. An offer
// *request* is not an offer, a list price is not a contract price, and a
// client browsing listings must not be able to move a number on their agent's
// dashboard. So the backfill is gone — these tests are its headstone.
describe("PATCH offer_requested never writes deals.price (#459)", () => {
  async function seedPricedProperty(
    dealId: string,
    price: number
  ): Promise<{ id: string }> {
    const req = new Request(`http://localhost/api/deals/${dealId}/properties`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        address: "500 Offer Ln",
        city: "Birmingham",
        state: "AL",
        price,
      }),
    });
    const res = await createPropRoute(req, dealCtx(dealId));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  }

  async function dealPrice(dealId: string): Promise<number | null> {
    const row = await prisma.deals.findUnique({
      where: { id: dealId },
      select: { price: true },
    });
    return row?.price == null ? null : Number(row.price);
  }

  async function seedAgentDeal() {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    return createDeal({ agent_id: agent.id });
  }

  it("leaves the deal price alone when the listing has a list price", async () => {
    const deal = await seedAgentDeal();
    const prop = await seedPricedProperty(deal.id, 475000);
    expect(await dealPrice(deal.id)).toBeNull();

    const res = await patchProp(deal.id, prop.id, "auth0|a", {
      offer_requested: true,
    });
    expect(res.status).toBe(200);

    // The listing's list price is not the contract price (#459).
    expect(await dealPrice(deal.id)).toBeNull();
  });

  it("a BUYER's offer request cannot move the agent's number", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const prop = await seedPricedProperty(deal.id, 475000);

    const res = await patchPropAs(deal.id, prop.id, "auth0|buyer", ["buyer"], {
      offer_requested: true,
    });
    expect(res.status).toBe(200);
    // The flag itself is the buyer's to set — the money is not.
    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
      select: { offer_requested: true },
    });
    expect(row?.offer_requested).toBe(true);

    expect(await dealPrice(deal.id)).toBeNull();
  });

  it("never overwrites a price the agent typed by hand", async () => {
    const deal = await seedAgentDeal();
    await prisma.deals.update({
      where: { id: deal.id },
      data: { price: 512000 },
    });
    const prop = await seedPricedProperty(deal.id, 475000);

    const res = await patchProp(deal.id, prop.id, "auth0|a", {
      offer_requested: true,
    });
    expect(res.status).toBe(200);

    expect(await dealPrice(deal.id)).toBe(512000);
  });

  it("does not touch the price on an unrelated property PATCH", async () => {
    const deal = await seedAgentDeal();
    const prop = await seedPricedProperty(deal.id, 475000);

    const res = await patchProp(deal.id, prop.id, "auth0|a", { status: "toured" });
    expect(res.status).toBe(200);

    expect(await dealPrice(deal.id)).toBeNull();
  });
});

describe("DELETE /api/deals/[id]/properties/[propId]", () => {
  it("removes the property for the owning agent", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const prop = await seedProperty(deal.id, "auth0|a");

    const req = new Request(
      `http://localhost/api/deals/${deal.id}/properties/${prop.id}`,
      {
        method: "DELETE",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const res = await deletePropRoute(req, propCtx(deal.id, prop.id));
    expect(res.status).toBe(204);

    const row = await prisma.tracked_properties.findUnique({
      where: { id: prop.id },
    });
    expect(row).toBeNull();
  });
});
