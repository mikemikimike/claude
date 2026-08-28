/**
 * Offers API — an offer must record WHICH property it is on (#410).
 *
 * `offers` carried `offer_price` but nothing linked a row to the
 * `tracked_properties` listing the offer was written against, so the UI
 * inferred the property from whichever listing the buyer happened to tap
 * "Make an Offer" on. POST now accepts `tracked_property_id`, refuses one
 * that belongs to a different deal, and pushes the chosen property's address
 * + the offer amount onto the deal so the pipeline has real numbers.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  GET as listOffersRoute,
  POST as createOfferRoute,
} from "@/app/api/deals/[id]/offers/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
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

function dealCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function postOffer(
  dealId: string,
  auth0: string,
  body: object
): Promise<Response> {
  const req = new Request(`http://localhost/api/deals/${dealId}/offers`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(auth0, ["agent"]),
    },
    body: JSON.stringify(body),
  });
  return createOfferRoute(req, dealCtx(dealId));
}

async function listOffers(dealId: string, auth0: string): Promise<Response> {
  const req = new Request(`http://localhost/api/deals/${dealId}/offers`, {
    headers: { authorization: await authHeader(auth0, ["agent"]) },
  });
  return listOffersRoute(req, dealCtx(dealId));
}

async function seedProperty(dealId: string, address = "42 Elm St") {
  return prisma.tracked_properties.create({
    data: {
      deal_id: dealId,
      address,
      city: "Birmingham",
      state: "AL",
      price: 400000,
    },
    select: { id: true, address: true },
  });
}

async function seedDeal() {
  const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
  const deal = await createDeal({ agent_id: agent.id, stage: "active_search" });
  return { agent, deal };
}

describe("POST /api/deals/[id]/offers — property link (#410)", () => {
  it("creates an offer linked to the chosen tracked property", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id);

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: prop.id,
      offer_price: 385000,
    });

    expect(res.status).toBe(201);
    const offer = (await res.json()) as {
      id: string;
      tracked_property_id: string | null;
      offer_price: number;
    };
    expect(offer.tracked_property_id).toBe(prop.id);
    expect(offer.offer_price).toBe(385000);

    const row = await prisma.offers.findUnique({ where: { id: offer.id } });
    expect(row?.tracked_property_id).toBe(prop.id);
  });

  it("serves the property link back on GET so the banner can name the house", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id, "9 Willow Ln");
    await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: prop.id,
      offer_price: 250000,
    });

    const res = await listOffers(deal.id, "auth0|agent");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { tracked_property_id: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].tracked_property_id).toBe(prop.id);
  });

  it("sets the deal's address and price from the property under offer", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id, "77 Cedar Ct");

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: prop.id,
      offer_price: 512500,
    });
    expect(res.status).toBe(201);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { address: true, price: true },
    });
    expect(row?.address).toContain("77 Cedar Ct");
    expect(Number(row?.price)).toBe(512500);
  });

  it("leaves the deal's address/price alone for an offer with no property link", async () => {
    const { deal } = await seedDeal();
    await prisma.deals.update({
      where: { id: deal.id },
      data: { address: "listing address", price: 100000 },
    });

    const res = await postOffer(deal.id, "auth0|agent", {
      buyer_name: "Someone Else",
      offer_price: 999,
    });
    expect(res.status).toBe(201);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { address: true, price: true },
    });
    expect(row?.address).toBe("listing address");
    expect(Number(row?.price)).toBe(100000);
  });

  it("400s on a tracked property that belongs to a different deal", async () => {
    const { agent, deal } = await seedDeal();
    const otherDeal = await createDeal({ agent_id: agent.id });
    const foreignProp = await seedProperty(otherDeal.id, "1 Somewhere Else");

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: foreignProp.id,
      offer_price: 1,
    });

    expect(res.status).toBe(400);
    expect(await prisma.offers.count()).toBe(0);
  });

  it("400s on a well-formed but nonexistent tracked property id", async () => {
    const { deal } = await seedDeal();

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: "0f6c6a2e-1b3d-4f5a-9c8b-2d1e3f4a5b6c",
      offer_price: 1,
    });

    expect(res.status).toBe(400);
  });

  it("400s on a garbage tracked_property_id instead of 500ing inside Postgres", async () => {
    const { deal } = await seedDeal();

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: "not-a-uuid",
      offer_price: 1,
    });

    expect(res.status).toBe(400);
  });

  it("404s for an agent who does not own the deal", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id);
    await createUser({ role: "agent", auth0_id: "auth0|intruder" });

    const res = await postOffer(deal.id, "auth0|intruder", {
      tracked_property_id: prop.id,
      offer_price: 385000,
    });

    expect(res.status).toBe(404);
    expect(await prisma.offers.count()).toBe(0);
  });

  it("keeps the pre-existing offer fields working", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id);

    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: prop.id,
      buyer_name: "Jane Buyer",
      offer_price: 385000,
      close_date: "2026-10-01",
      contingencies: ["financing", "inspection"],
      agent_notes: "aggressive but clean",
    });

    expect(res.status).toBe(201);
    const offer = (await res.json()) as {
      buyer_name: string;
      contingencies: string[];
      agent_notes: string;
      close_date: string | null;
    };
    expect(offer.buyer_name).toBe("Jane Buyer");
    expect(offer.contingencies).toEqual(["financing", "inspection"]);
    expect(offer.agent_notes).toBe("aggressive but clean");
    expect(offer.close_date).toBeTruthy();
  });

  it("keeps the offer row when the tracked property is later deleted", async () => {
    const { deal } = await seedDeal();
    const prop = await seedProperty(deal.id);
    const res = await postOffer(deal.id, "auth0|agent", {
      tracked_property_id: prop.id,
      offer_price: 385000,
    });
    const { id: offerId } = (await res.json()) as { id: string };

    await prisma.tracked_properties.delete({ where: { id: prop.id } });

    const row = await prisma.offers.findUnique({ where: { id: offerId } });
    expect(row).not.toBeNull();
    expect(row?.tracked_property_id).toBeNull();
  });
});
