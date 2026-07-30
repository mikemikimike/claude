import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type Stripe from "stripe";
import { POST as fastPassRoute } from "@/app/api/deals/[id]/fastpass/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
import {
  FAST_PASS_BASE_PRICE_CENTS,
  FAST_PASS_UPSELL_PRICE_CENTS,
} from "@/lib/fast-pass-catalog";
import { prisma } from "@/lib/db";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

afterEach(() => {
  setStripeForTesting(undefined);
});

afterAll(() => {
  setStripeForTesting(undefined);
});

beforeEach(async () => {
  await truncateAll();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

// Base + utility_setup 9700 + staging_consult 24700. Derived from the catalog
// so a base-price change doesn't need an edit here — the upsells stay literal
// so a wrong upsell amount is still caught.
const EXPECTED_TOTAL = FAST_PASS_BASE_PRICE_CENTS + 9700 + 24700;
// "Pay at closing" defers the charge and adds a 15% premium to the FULL basket
// (base + upsells) exactly once. "now" / "seller_concession" carry no premium.
// Literal 1.15 here (not the catalog constant) so a wrong multiplier is caught.
const EXPECTED_AT_CLOSING_TOTAL = Math.round(EXPECTED_TOTAL * 1.15);

describe("POST /api/deals/[id]/fastpass", () => {
  it("owner enrolls deferred (at_closing) → 200 {ok:true}, persisted with server total (+15% premium) + deduped upsells", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "123 Main St" });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "at_closing",
        // Duplicate staging_consult proves dedupe; client total is ignored.
        selected_upsells: ["utility_setup", "staging_consult", "staging_consult"],
        total_cents: 999,
        survey_answers: { currentSituation: "renting", targetMoveDate: "2026-08-01" },
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBeUndefined();

    // Read back the JSONB via raw SQL to confirm the persisted shape.
    const rows = await prisma.$queryRaw<
      {
        status: string;
        payment_option: string;
        total_cents: string;
        paid: boolean;
        survey_situation: string;
        selected_upsells: unknown;
        enrolled_at: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'                          AS status,
             fast_pass->>'payment_option'                  AS payment_option,
             fast_pass->>'total_cents'                     AS total_cents,
             (fast_pass->>'paid')::boolean                 AS paid,
             fast_pass->'survey_answers'->>'currentSituation' AS survey_situation,
             fast_pass->'selected_upsells'                 AS selected_upsells,
             fast_pass->>'enrolled_at'                     AS enrolled_at
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    const row = rows[0];
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("at_closing");
    // at_closing stores the marked-up basket, NOT the un-marked EXPECTED_TOTAL.
    expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    expect(row.paid).toBe(false);
    expect(row.survey_situation).toBe("renting");
    // Deduped — staging_consult appears once.
    expect(row.selected_upsells).toEqual(["utility_setup", "staging_consult"]);
    expect(row.enrolled_at).toBeTruthy();
  });

  // ── #280: server-side pricing is payment-option-aware ──────────────────────
  it("at_closing with NO upsells → persisted total = base + 15% deferral premium (#280)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Premium Way" });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ payment_option: "at_closing", selected_upsells: [] }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<{ total_cents: string }[]>`
      SELECT fast_pass->>'total_cents' AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    // Pre-fix this equalled the un-marked base — the revenue leak.
    expect(rows[0].total_cents).toBe(
      String(Math.round(FAST_PASS_BASE_PRICE_CENTS * 1.15))
    );
    expect(rows[0].total_cents).not.toBe(String(FAST_PASS_BASE_PRICE_CENTS));
  });

  it("payment_option 'now' → stored total AND Stripe amount = base + upsells with NO premium (#280)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "2 Upfront Rd" });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_now_nomarkup",
              url: "https://stripe.test/checkout/cs_now_nomarkup",
            };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "now",
        selected_upsells: ["utility_setup", "staging_consult"],
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);

    // Stripe is charged the un-marked basket…
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(EXPECTED_TOTAL);
    // …never the at-closing (marked-up) figure.
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).not.toBe(
      EXPECTED_AT_CLOSING_TOTAL
    );

    const rows = await prisma.$queryRaw<{ total_cents: string }[]>`
      SELECT fast_pass->>'total_cents' AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].total_cents).toBe(String(EXPECTED_TOTAL));
  });

  it("at_closing + one upsell → premium applied to full basket once; tampered total_cents still ignored (#280 + #78)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "3 Basket Ln" });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "at_closing",
        selected_upsells: ["utility_setup"],
        // Hostile client tries to set its own price — must be ignored (#78).
        total_cents: 1,
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);

    // (base + one upsell) * 1.15, rounded — the premium hits the WHOLE basket
    // once, not the upsell marked up separately.
    const expected = Math.round(
      (FAST_PASS_BASE_PRICE_CENTS + FAST_PASS_UPSELL_PRICE_CENTS.utility_setup) * 1.15
    );
    const rows = await prisma.$queryRaw<{ total_cents: string }[]>`
      SELECT fast_pass->>'total_cents' AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].total_cents).toBe(String(expected));
    // The client's 1-cent claim was ignored (#78 anti-tamper unchanged).
    expect(rows[0].total_cents).not.toBe("1");
  });

  it("payment_option 'now' → 200 {checkout_url}; tampered total_cents ignored, Stripe gets catalog amount + fast_pass metadata", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "456 Oak Ave" });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_fastpass_1",
              url: "https://stripe.test/checkout/cs_fastpass_1",
            };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "now",
        selected_upsells: ["utility_setup", "staging_consult"],
        // Hostile client claims the whole thing costs 1 cent.
        total_cents: 1,
        survey_answers: { currentSituation: "selling" },
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBe("https://stripe.test/checkout/cs_fastpass_1");

    // Stripe received the catalog amount (base + upsells), product, metadata.
    expect(captured).toBeDefined();
    const lineItem = captured!.line_items?.[0];
    expect(lineItem?.price_data?.unit_amount).toBe(EXPECTED_TOTAL);
    expect(lineItem?.price_data?.product_data?.name).toBe("Fast Pass Concierge Service");
    expect(lineItem?.price_data?.product_data?.description).toBe(
      "Fast Pass enrollment for 456 Oak Ave"
    );
    expect(captured!.mode).toBe("payment");
    expect(captured!.metadata).toMatchObject({
      deal_id: deal.id,
      type: "fast_pass",
    });
    // Owner keeps the agent-facing return URLs (role-aware URLs, #169).
    expect(captured!.success_url).toBe(
      `http://localhost/agent/deals/${deal.id}?fastpass=paid`
    );
    expect(captured!.cancel_url).toBe(`http://localhost/agent/deals/${deal.id}`);

    // The JSONB stores the SERVER-computed total, not the client's 1 cent.
    const rows = await prisma.$queryRaw<
      { status: string; paid: boolean; total_cents: string }[]
    >`
      SELECT fast_pass->>'status' AS status,
             (fast_pass->>'paid')::boolean AS paid,
             fast_pass->>'total_cents' AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].status).toBe("active");
    expect(rows[0].paid).toBe(false);
    expect(rows[0].total_cents).toBe(String(EXPECTED_TOTAL));
  });

  it("invalid payment_option → 400, nothing persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "later",
        selected_upsells: [],
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(400);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("unknown upsell key → 400, no Stripe call, existing enrollment untouched", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    // Seed a prior enrollment so we can prove the bad request doesn't clobber it.
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "active",
          payment_option: "at_closing",
          selected_upsells: [],
          total_cents: FAST_PASS_BASE_PRICE_CENTS,
          paid: false,
          enrolled_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    let stripeCalled = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            stripeCalled = true;
            return { id: "cs_nope", url: "https://stripe.test/nope" };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "now",
        selected_upsells: ["staging_consult", "free_money"],
        total_cents: 1,
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("free_money");
    expect(stripeCalled).toBe(false);

    // Validation happens BEFORE persisting — the seeded enrollment survives.
    const rows = await prisma.$queryRaw<
      { payment_option: string; enrolled_at: string }[]
    >`
      SELECT fast_pass->>'payment_option' AS payment_option,
             fast_pass->>'enrolled_at'    AS enrolled_at
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].payment_option).toBe("at_closing");
    expect(rows[0].enrolled_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("buyer participant enrolls with 'now' → 200 {checkout_url}; Stripe gets buyer-facing success/cancel URLs (#169)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id, title: "789 Elm St" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_fastpass_buyer",
              url: "https://stripe.test/checkout/cs_fastpass_buyer",
            };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|buyer", ["buyer"]),
      },
      body: JSON.stringify({
        payment_option: "now",
        selected_upsells: ["utility_setup", "staging_consult"],
        survey_answers: { currentSituation: "renting" },
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBe("https://stripe.test/checkout/cs_fastpass_buyer");

    // Role-aware return URLs: a buyer lands back on THEIR portal, not the
    // agent's deal page; cancel returns to the survey's deal_id entry point
    // so a resubmit works (FastPassSurvey keeps its handoff for exactly this).
    expect(captured).toBeDefined();
    expect(captured!.success_url).toBe(
      `http://localhost/buyer/${buyer.id}?fastpass=paid`
    );
    expect(captured!.cancel_url).toBe(
      `http://localhost/fast-pass/survey?deal_id=${deal.id}`
    );

    // Enrollment persisted on the deal.
    const rows = await prisma.$queryRaw<
      { status: string; payment_option: string }[]
    >`
      SELECT fast_pass->>'status' AS status,
             fast_pass->>'payment_option' AS payment_option
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].status).toBe("active");
    expect(rows[0].payment_option).toBe("now");
  });

  it("buyer participant's tampered total_cents is ignored — Stripe charges the server catalog amount (#169)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return { id: "cs_tamper", url: "https://stripe.test/checkout/cs_tamper" };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|buyer", ["buyer"]),
      },
      body: JSON.stringify({
        payment_option: "now",
        selected_upsells: ["utility_setup", "staging_consult"],
        // Hostile buyer client claims the whole thing costs 1 cent.
        total_cents: 1,
      }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);

    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(EXPECTED_TOTAL);

    const rows = await prisma.$queryRaw<{ total_cents: string }[]>`
      SELECT fast_pass->>'total_cents' AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].total_cents).toBe(String(EXPECTED_TOTAL));
  });

  it("403 when a buyer is NOT a participant on the deal — nothing persisted, no Stripe call", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "buyer", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: agent.id });

    let stripeCalled = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            stripeCalled = true;
            return { id: "cs_nope", url: "https://stripe.test/nope" };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|stranger", ["buyer"]),
      },
      body: JSON.stringify({ payment_option: "now", selected_upsells: [] }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(403);
    expect(stripeCalled).toBe(false);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("403 when caller is neither the owner nor a participant", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    await createUser({ role: "agent", auth0_id: "auth0|other" });
    const deal = await createDeal({ agent_id: agent.id });

    const r = new Request(`http://localhost/api/deals/${deal.id}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|other", ["agent"]),
      },
      body: JSON.stringify({ payment_option: "at_closing", selected_upsells: [] }),
    });
    const res = await fastPassRoute(r, ctx(deal.id));
    expect(res.status).toBe(403);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("404 when the deal does not exist", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const missingId = "00000000-0000-0000-0000-000000000000";

    const r = new Request(`http://localhost/api/deals/${missingId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ payment_option: "at_closing", selected_upsells: [] }),
    });
    const res = await fastPassRoute(r, ctx(missingId));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals/[id]/fastpass — malformed body validation (#88)", () => {
  async function enroll(dealId: string, body: string) {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return fastPassRoute(r, ctx(dealId));
  }

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "null");
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("400 when payment_option is a number — junk never persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, JSON.stringify({ payment_option: 5 }));
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("400 when selected_upsells contains non-strings", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(
      deal.id,
      JSON.stringify({ payment_option: "at_closing", selected_upsells: [1, 2] })
    );
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });
});
