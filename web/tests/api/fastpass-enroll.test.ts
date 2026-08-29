import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type Stripe from "stripe";
import { POST as fastPassRoute } from "@/app/api/deals/[id]/fastpass/route";
// #440 (FF17) — paying for an existing enrollment from the buyer's dashboard.
import { POST as fastPassPayRoute } from "@/app/api/deals/[id]/fastpass/pay/route";
// #463 — the Stripe webhook is the ONLY thing that may mark an enrollment paid,
// so the promotion it performs is part of this route's contract.
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { fastPassTotalForPaymentOption } from "@/lib/fast-pass-payment";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
import {
  FAST_PASS_BASE_PRICE_CENTS,
  FAST_PASS_UPSELL_PRICE_CENTS,
  computeFastPassSubtotalCents,
  computeFastPassTotalCents,
} from "@/lib/fast-pass-catalog";
import { FAST_PASS_UPSELLS } from "@/lib/fast-pass-display";
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

// Base + utility_setup 9700 + staging_consult 10000. Derived from the catalog
// so a base-price change doesn't need an edit here — the upsells stay literal
// so a wrong upsell amount is still caught. (staging_consult was repriced from
// $247 to $100 in #430 — the base package already bundles a designer session.)
const EXPECTED_TOTAL = FAST_PASS_BASE_PRICE_CENTS + 9700 + 10000;
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
    // #463: a pay-now enrollment is NOT active until Stripe's webhook says the
    // money landed — reaching Checkout is not the same as paying for it.
    expect(rows[0].status).toBe("pending_payment");
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
    // #463: reaching Checkout is not paying — the webhook activates it.
    expect(rows[0].status).toBe("pending_payment");
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

/**
 * #439 (FF16) — the Fast Pass survey stops taking payment. Onboarding now
 * enrolls the buyer WITHOUT a `payment_option`; the enrollment is persisted
 * awaiting payment (`status: 'pending_payment'`, `paid: false`) and the buyer
 * pays later from their dashboard (#440 / FF17).
 *
 * `payment_option` stays a valid — and still whitelisted — field, because FF17
 * posts it from the dashboard. This block pins the new deferred shape AND
 * re-pins the pricing guarantees (#78 anti-tamper, #281 promo, #169 scoping)
 * on the no-payment-option path, since that is the path onboarding now takes.
 */
describe("POST /api/deals/[id]/fastpass — enrollment without payment_option (#439)", () => {
  async function enroll(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassRoute(r, ctx(dealId));
  }

  /** Fails the test if Stripe is touched at all; returns a getter for the flag. */
  function stripeMustNotBeCalled(): () => boolean {
    let called = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            called = true;
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
    return () => called;
  }

  async function readFastPass(dealId: string) {
    const rows = await prisma.$queryRaw<
      {
        status: string | null;
        payment_option: string | null;
        total_cents: string | null;
        discount_cents: string | null;
        promo_code: string | null;
        paid: boolean | null;
        selected_upsells: unknown;
        enrolled_at: string | null;
        survey_situation: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'                              AS status,
             fast_pass->>'payment_option'                      AS payment_option,
             fast_pass->>'total_cents'                         AS total_cents,
             fast_pass->>'discount_cents'                      AS discount_cents,
             fast_pass->>'promo_code'                          AS promo_code,
             (fast_pass->>'paid')::boolean                     AS paid,
             fast_pass->'selected_upsells'                     AS selected_upsells,
             fast_pass->>'enrolled_at'                         AS enrolled_at,
             fast_pass->'survey_answers'->>'currentSituation'  AS survey_situation
      FROM deals WHERE id = ${dealId}::uuid
    `;
    return rows[0];
  }

  it("buyer enrolls with add-ons and NO payment_option → 200, persisted as pending_payment / unpaid, no Stripe", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id, title: "9 Deferred Dr" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const stripeCalled = stripeMustNotBeCalled();

    const res = await enroll(deal.id, "auth0|buyer", ["buyer"], {
      selected_upsells: ["utility_setup", "staging_consult"],
      survey_answers: { currentSituation: "renting" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      status?: string;
      checkout_url?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending_payment");
    // Nothing to pay here — the survey must never hand back a checkout URL.
    expect(body.checkout_url).toBeUndefined();
    expect(stripeCalled()).toBe(false);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.paid).toBe(false);
    // No option chosen yet — FF17 records it when the buyer pays.
    expect(row.payment_option).toBeNull();
    // Server-computed from the catalog: base + upsells, with NO at-closing
    // premium (nothing was deferred — nothing was chosen).
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
    expect(row.total_cents).not.toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    expect(row.survey_situation).toBe("renting");
    expect(row.enrolled_at).toBeTruthy();
  });

  it("stores the selected add-ons, deduped", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      selected_upsells: ["staging_consult", "utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.selected_upsells).toEqual(["staging_consult", "utility_setup"]);
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
  });

  it("an unknown add-on still 400s before anything is persisted (regression guard)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const stripeCalled = stripeMustNotBeCalled();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      selected_upsells: ["staging_consult", "free_money"],
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("free_money");
    expect(stripeCalled()).toBe(false);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("a tampered total_cents is still ignored — the stored total comes from the catalog (regression guard)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      selected_upsells: ["utility_setup", "staging_consult"],
      // Hostile client claims the whole basket costs 1 cent.
      total_cents: 1,
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
    expect(row.total_cents).not.toBe("1");
  });

  it("a promo code still discounts the SUBTOTAL and increments uses_count (regression guard)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.promo_codes.create({
      data: {
        code: "FF16TEN",
        discount_type: "pct",
        discount_value: 10,
        applies_to: ["fast_pass"],
        max_uses: null,
        uses_count: 0,
      },
    });
    const subtotal = computeFastPassSubtotalCents(["utility_setup", "staging_consult"]);
    const discount = Math.round(subtotal * 0.1);

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      selected_upsells: ["utility_setup", "staging_consult"],
      promo_code: "FF16TEN",
      // Client-claimed discount is never trusted either.
      total_cents: 1,
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.total_cents).toBe(String(subtotal - discount));
    expect(row.discount_cents).toBe(String(discount));
    expect(row.promo_code).toBe("FF16TEN");

    const promo = await prisma.promo_codes.findFirst({ where: { code: "FF16TEN" } });
    expect(promo?.uses_count).toBe(1);
  });

  it("a non-participant still gets 403 — nothing persisted (scoping boundary)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "buyer", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|stranger", ["buyer"], {
      selected_upsells: ["utility_setup"],
    });
    expect(res.status).toBe(403);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("an explicit payment_option still works (FF17 posts it from the dashboard)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: ["utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("at_closing");
    expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
  });

  it("a garbage payment_option is still rejected — absent is not the same as invalid", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "later",
      selected_upsells: [],
    });
    expect(res.status).toBe(400);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  it("an already-enrolled deal keeps its stored total when a deferred enrollment fails validation", async () => {
    // Repo gotcha: each enrollment stores the total computed AT ENROL TIME —
    // that is what protects buyers who enrolled under older pricing. A rejected
    // request must not touch it.
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "active",
          payment_option: "at_closing",
          selected_upsells: [],
          total_cents: 111111,
          paid: true,
          enrolled_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      selected_upsells: ["not_a_real_addon"],
    });
    expect(res.status).toBe(400);

    const row = await readFastPass(deal.id);
    expect(row.total_cents).toBe("111111");
    expect(row.status).toBe("active");
    expect(row.paid).toBe(true);
    expect(row.enrolled_at).toBe("2026-01-01T00:00:00.000Z");
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

/**
 * #430 — Fast Pass add-on repricing. Paul confirmed three corrections on
 * 2026-08-28: Moving Day Coordination $197 → $475, Post-Close Deep Clean
 * $197 → $425, and Staging & Design Consultation $247 → $100 (down on
 * purpose — the base package already bundles a designer session).
 *
 * Pure catalog assertions with no DB or HTTP in the way: the catalog is the
 * single source of truth for BOTH the survey's displayed dollars
 * (lib/fast-pass-display.ts) and the Stripe charge, so pinning it here is
 * what stops marketing copy and the charge from drifting apart.
 *
 * Existing enrolments are unaffected — each stores its computed total_cents
 * on the deal at enrol time.
 */
describe("Fast Pass add-on prices (#430)", () => {
  it("Moving Day Coordination is $475 — subtotal = base + 47500", () => {
    expect(FAST_PASS_UPSELL_PRICE_CENTS.moving_coordination).toBe(47500);
    expect(computeFastPassSubtotalCents(["moving_coordination"])).toBe(226200);
  });

  it("Post-Close Deep Clean is $425 — subtotal = base + 42500", () => {
    expect(FAST_PASS_UPSELL_PRICE_CENTS.deep_clean).toBe(42500);
    expect(computeFastPassSubtotalCents(["deep_clean"])).toBe(221200);
  });

  it("Staging & Design Consultation drops to $100 — subtotal = base + 10000", () => {
    expect(FAST_PASS_UPSELL_PRICE_CENTS.staging_consult).toBe(10000);
    expect(computeFastPassSubtotalCents(["staging_consult"])).toBe(188700);
  });

  it("the +15% at_closing premium multiplies the whole basket once, not the add-on alone", () => {
    // round(226200 * 1.15) — NOT base + round(47500 * 1.15), and not applied
    // twice. Literal 1.15 so a wrong multiplier is still caught.
    expect(computeFastPassTotalCents(["moving_coordination"], "at_closing")).toBe(260130);
    expect(computeFastPassTotalCents(["moving_coordination"], "at_closing")).toBe(
      Math.round(226200 * 1.15)
    );
    // "now" and "seller_concession" carry no premium.
    expect(computeFastPassTotalCents(["moving_coordination"], "now")).toBe(226200);
  });

  it("a promo discount comes off the SUBTOTAL before the premium is applied", () => {
    // Documented order (#281 composed with #280): subtotal → discount → premium.
    // round((226200 − 20000) × 1.15) = 237130.
    // Discounting AFTER the premium would give 260130 − 20000 = 240130.
    expect(
      computeFastPassTotalCents(["moving_coordination"], "at_closing", {
        discountCents: 20000,
      })
    ).toBe(237130);
    expect(
      computeFastPassTotalCents(["moving_coordination"], "at_closing", {
        discountCents: 20000,
      })
    ).not.toBe(240130);
  });

  it("every displayed add-on has a catalog price — nothing can be shown without one", () => {
    for (const upsell of FAST_PASS_UPSELLS) {
      expect(FAST_PASS_UPSELL_PRICE_CENTS).toHaveProperty(upsell.id);
      // The displayed dollars are derived, never hand-typed.
      expect(upsell.price).toBe(FAST_PASS_UPSELL_PRICE_CENTS[upsell.id] / 100);
    }
    // …and no priced add-on is orphaned out of the UI list either.
    const displayedIds = new Set<string>(FAST_PASS_UPSELLS.map((u) => u.id));
    for (const key of Object.keys(FAST_PASS_UPSELL_PRICE_CENTS)) {
      expect(displayedIds.has(key)).toBe(true);
    }
  });
});

/**
 * #440 (FF17) — the buyer pays for an EXISTING Fast Pass enrollment from their
 * dashboard. FF16 (#439) stopped the survey taking money, so an enrollment now
 * lands `status: 'pending_payment'` with no `payment_option`; this route is how
 * one gets chosen and how the money actually moves.
 *
 * It is a SEPARATE route from POST /fastpass on purpose: enrolling and paying
 * are different operations with different failure semantics, and this one must
 * never silently succeed.
 *
 * Absorbed here:
 *   - #412 — a Stripe failure returns a NON-2xx, never `{ ok: true }`. The
 *     enrollment route caught the error, logged it, and returned success, so
 *     the caller showed a "you're paid" screen for an unpaid enrollment.
 *   - #413 — Checkout is created with `customer_email` read SERVER-SIDE from
 *     the paying user's `users.email`, never from the request body.
 */
describe("POST /api/deals/[id]/fastpass/pay (#440)", () => {
  // Enrollment shaped exactly as POST /fastpass persists a #439 deferred one.
  const PENDING_UPSELLS = ["utility_setup", "staging_consult"];
  const PENDING_TOTAL = EXPECTED_TOTAL; // base + 9700 + 10000, no premium

  async function seedPending(
    dealId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<void> {
    await prisma.deals.update({
      where: { id: dealId },
      data: {
        fast_pass: {
          status: "pending_payment",
          payment_option: null,
          selected_upsells: PENDING_UPSELLS,
          total_cents: PENDING_TOTAL,
          paid: false,
          enrolled_at: "2026-08-01T00:00:00.000Z",
          survey_answers: { currentSituation: "renting" },
          ...overrides,
        },
      },
    });
  }

  async function pay(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassPayRoute(r, ctx(dealId));
  }

  async function readFastPass(dealId: string) {
    const rows = await prisma.$queryRaw<
      {
        status: string | null;
        payment_option: string | null;
        total_cents: string | null;
        paid: boolean | null;
        session_id: string | null;
        selected_upsells: unknown;
        enrolled_at: string | null;
        survey_situation: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'                              AS status,
             fast_pass->>'payment_option'                      AS payment_option,
             fast_pass->>'total_cents'                         AS total_cents,
             (fast_pass->>'paid')::boolean                     AS paid,
             fast_pass->>'checkout_session_id'                 AS session_id,
             fast_pass->'selected_upsells'                     AS selected_upsells,
             fast_pass->>'enrolled_at'                         AS enrolled_at,
             fast_pass->'survey_answers'->>'currentSituation'  AS survey_situation
      FROM deals WHERE id = ${dealId}::uuid
    `;
    return rows[0];
  }

  /** Records every Checkout session params object the route sends to Stripe. */
  /**
   * `retrieve` is optional and mirrors the real seam: a stub that doesn't
   * provide it makes retrieveCheckoutSession throw, which is the
   * "can't read the session" branch. Pass one to exercise open / expired /
   * complete.
   */
  function captureStripe(
    result: { id: string; url: string | null } | (() => never),
    retrieve?: (
      id: string
    ) => Promise<Pick<Stripe.Checkout.Session, "id" | "url" | "status">>
  ): Stripe.Checkout.SessionCreateParams[] {
    const calls: Stripe.Checkout.SessionCreateParams[] = [];
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params) => {
            calls.push(params);
            if (typeof result === "function") result();
            return result as { id: string; url: string | null };
          },
          ...(retrieve ? { retrieve } : {}),
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });
    return calls;
  }

  /** A Checkout session snapshot in the shape retrieveCheckoutSession returns. */
  function snapshot(
    id: string,
    status: Stripe.Checkout.Session["status"],
    url: string | null
  ): Pick<Stripe.Checkout.Session, "id" | "url" | "status"> {
    return { id, status, url } as Pick<
      Stripe.Checkout.Session,
      "id" | "url" | "status"
    >;
  }

  // ── 1. Happy path: pay now ────────────────────────────────────────────────
  it("pay now on a pending_payment enrollment returns a checkout_url for the enrolled total", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
      email: "betty@buyer.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "9 Pending Ln" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await seedPending(deal.id);
    const calls = captureStripe({ id: "cs_ff17_1", url: "https://stripe.test/cs_ff17_1" });

    const res = await pay(deal.id, "auth0|buyer", ["buyer"], { payment_option: "now" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      checkout_url?: string;
      total_cents?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.checkout_url).toBe("https://stripe.test/cs_ff17_1");
    // Charged the total the enrollment already agreed to — no premium on "now".
    expect(body.total_cents).toBe(PENDING_TOTAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].line_items?.[0]?.price_data?.unit_amount).toBe(PENDING_TOTAL);

    // Still awaiting payment — only Stripe's webhook may mark it paid.
    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.paid).toBe(false);
    expect(row.payment_option).toBe("now");
    expect(row.session_id).toBe("cs_ff17_1");
    // Sibling enrollment fields survive the merge.
    expect(row.selected_upsells).toEqual(PENDING_UPSELLS);
    expect(row.enrolled_at).toBe("2026-08-01T00:00:00.000Z");
    expect(row.survey_situation).toBe("renting");
  });

  // ── 2. #412: Stripe throws → non-2xx, never a false success ───────────────
  it("a Stripe failure returns a NON-2xx and never {ok:true} (#412)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);
    captureStripe(() => {
      throw new Error("stripe is down");
    });

    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).not.toContain('"ok":true');

    // Nothing was recorded as chosen or paid — the buyer can retry cleanly.
    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.paid).toBe(false);
    expect(row.payment_option).toBeNull();
    expect(row.session_id).toBeNull();
  });

  // ── 3. #412: session with a null url → non-2xx ────────────────────────────
  it("a Checkout session with no url returns a NON-2xx (#412)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);
    captureStripe({ id: "cs_no_url", url: null });

    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.paid).toBe(false);
    expect(row.payment_option).toBeNull();
  });

  // ── Session reuse: never mint a SECOND payable session (#282 pattern) ─────
  //
  // Fast Pass is a $1,787+ charge. Two payable Checkout sessions means a buyer
  // with two tabs open can genuinely pay twice, and refunding that is a trust
  // problem, not an accounting one. The closing-fee route already solved this
  // (#282): re-read the stored session's LIVE status with Stripe and reuse it
  // unless it has genuinely expired. Same rule here.
  describe("does not mint a second payable session", () => {
    it("two sequential pay-now calls create ONE session and return the same URL", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      await seedPending(deal.id);
      // The session minted by call #1 is still open when call #2 arrives.
      const calls = captureStripe(
        { id: "cs_reuse_1", url: "https://stripe.test/cs_reuse_1" },
        async (id) => snapshot(id, "open", `https://stripe.test/${id}`)
      );

      const first = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
      const second = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const firstBody = (await first.json()) as { checkout_url?: string };
      const secondBody = (await second.json()) as { checkout_url?: string };
      // The buyer lands on the ONE live checkout, not a second payable one.
      expect(secondBody.checkout_url).toBe(firstBody.checkout_url);
      expect(calls).toHaveLength(1);

      const row = await readFastPass(deal.id);
      expect(row.session_id).toBe("cs_reuse_1");
      expect(row.paid).toBe(false);
    });

    it("an EXPIRED stored session falls through and mints a fresh, retryable one", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      // An abandoned session from an earlier attempt.
      await seedPending(deal.id, { checkout_session_id: "cs_stale" });
      const calls = captureStripe(
        { id: "cs_fresh", url: "https://stripe.test/cs_fresh" },
        async (id) => snapshot(id, "expired", null)
      );

      const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
      expect(res.status).toBe(200);
      expect((await res.json()).checkout_url).toBe("https://stripe.test/cs_fresh");
      expect(calls).toHaveLength(1);

      const row = await readFastPass(deal.id);
      expect(row.session_id).toBe("cs_fresh");
    });

    it("a COMPLETED stored session is a 409 — the webhook just hasn't landed yet", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      await seedPending(deal.id, { checkout_session_id: "cs_done" });
      // Completed sessions carry no payable URL.
      const calls = captureStripe({ id: "cs_never", url: "https://stripe.test/never" }, async (id) =>
        snapshot(id, "complete", null)
      );

      const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
      expect(res.status).toBe(409);
      // This is the money-critical assertion: charging again is never the answer.
      expect(calls).toHaveLength(0);

      const row = await readFastPass(deal.id);
      expect(row.session_id).toBe("cs_done");
      expect(row.paid).toBe(false);
    });

    it("an UNREADABLE stored session is a 409 — we never mint on an unknown state", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      await seedPending(deal.id, { checkout_session_id: "cs_unknown" });
      const calls = captureStripe(
        { id: "cs_never", url: "https://stripe.test/never" },
        async () => {
          throw new Error("stripe unreachable");
        }
      );

      const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
      expect(res.status).toBe(409);
      expect(calls).toHaveLength(0);
    });

    it("a live session also blocks a DEFERRAL — it would charge a total we no longer agree with", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      await seedPending(deal.id, { checkout_session_id: "cs_live" });
      captureStripe({ id: "cs_never", url: "https://stripe.test/never" }, async (id) =>
        snapshot(id, "open", `https://stripe.test/${id}`)
      );

      const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "at_closing" });
      expect(res.status).toBe(409);

      // Untouched: still awaiting payment at the un-premiumed total, so the
      // live session can't collect an amount the record disagrees with.
      const row = await readFastPass(deal.id);
      expect(row.status).toBe("pending_payment");
      expect(row.payment_option).toBeNull();
      expect(row.total_cents).toBe(String(PENDING_TOTAL));
    });

    it("an expired session does NOT block a deferral", async () => {
      const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
      const deal = await createDeal({ agent_id: agent.id });
      await seedPending(deal.id, { checkout_session_id: "cs_gone" });
      captureStripe({ id: "cs_never", url: "https://stripe.test/never" }, async (id) =>
        snapshot(id, "expired", null)
      );

      const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "at_closing" });
      expect(res.status).toBe(200);

      const row = await readFastPass(deal.id);
      expect(row.status).toBe("active");
      expect(row.payment_option).toBe("at_closing");
      expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    });
  });

  // ── 4. at_closing records the deferral + the +15% premium, once ───────────
  it("at_closing records the deferral, applies +15% to the whole basket once, and returns no checkout URL", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);
    const calls = captureStripe({ id: "cs_nope", url: "https://stripe.test/nope" });

    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "at_closing" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      status?: string;
      checkout_url?: string;
      total_cents?: number;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("active");
    expect(body.checkout_url).toBeUndefined();
    // Identical to today's math: round(basket * 1.15), applied once.
    expect(body.total_cents).toBe(EXPECTED_AT_CLOSING_TOTAL);
    // Deferring takes no money — Stripe is never touched.
    expect(calls).toHaveLength(0);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("at_closing");
    expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    // Deferred is not paid — the money still has to arrive at closing.
    expect(row.paid).toBe(false);
    expect(row.selected_upsells).toEqual(PENDING_UPSELLS);
  });

  it("seller_concession activates the enrollment at the un-premiumed total", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);

    const res = await pay(deal.id, "auth0|a", ["agent"], {
      payment_option: "seller_concession",
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("seller_concession");
    expect(row.total_cents).toBe(String(PENDING_TOTAL));
  });

  // ── 5. #413: customer_email from the paying user's users.email ────────────
  it("creates the Checkout session with customer_email from the paying user's users.email (#413)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
      email: "betty@buyer.test",
    });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    await seedPending(deal.id);
    const calls = captureStripe({ id: "cs_email", url: "https://stripe.test/cs_email" });

    const res = await pay(deal.id, "auth0|buyer", ["buyer"], {
      payment_option: "now",
      // A hostile client cannot pick whose email Stripe prefills.
      customer_email: "attacker@evil.test",
    });
    expect(res.status).toBe(200);
    expect(calls[0].customer_email).toBe("betty@buyer.test");
  });

  // ── 6. Scoping ────────────────────────────────────────────────────────────
  it("a non-participant cannot start checkout for someone else's enrollment (403)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "buyer", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);
    const calls = captureStripe({ id: "cs_x", url: "https://stripe.test/x" });

    const res = await pay(deal.id, "auth0|stranger", ["buyer"], { payment_option: "now" });
    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);

    const row = await readFastPass(deal.id);
    expect(row.payment_option).toBeNull();
    expect(row.status).toBe("pending_payment");
  });

  // ── 7. An already-paid enrollment cannot be charged again ─────────────────
  it("an already-paid enrollment cannot be charged again (409, nothing touched)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id, {
      status: "active",
      payment_option: "now",
      paid: true,
      total_cents: 111111,
    });
    const calls = captureStripe({ id: "cs_x", url: "https://stripe.test/x" });

    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "at_closing" });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);

    const row = await readFastPass(deal.id);
    expect(row.paid).toBe(true);
    expect(row.payment_option).toBe("now");
    expect(row.total_cents).toBe("111111");
  });

  it("a second deferral submit is rejected — the pending_payment guard is in the UPDATE", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);

    const first = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "at_closing" });
    expect(first.status).toBe(200);
    // A double-click / retry must not re-price the now-active enrollment.
    const second = await pay(deal.id, "auth0|a", ["agent"], {
      payment_option: "seller_concession",
    });
    expect(second.status).toBe(409);

    const row = await readFastPass(deal.id);
    expect(row.payment_option).toBe("at_closing");
    expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
  });

  // ── Input + existence guards ──────────────────────────────────────────────
  it("a deal with no enrollment is a 404", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
    expect(res.status).toBe(404);
  });

  it("a missing or unrecognised payment_option is a 400", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await seedPending(deal.id);
    const calls = captureStripe({ id: "cs_x", url: "https://stripe.test/x" });

    expect((await pay(deal.id, "auth0|a", ["agent"], {})).status).toBe(400);
    expect(
      (await pay(deal.id, "auth0|a", ["agent"], { payment_option: "later" })).status
    ).toBe(400);
    expect(calls).toHaveLength(0);

    const row = await readFastPass(deal.id);
    expect(row.payment_option).toBeNull();
    expect(row.status).toBe("pending_payment");
  });
});

/**
 * #440 — the shared helper that applies a payment option to an ALREADY-AGREED
 * enrollment total. The buyer's dashboard card and the /fastpass/pay route both
 * price from this, so the figure on screen is always the figure Stripe charges
 * (the survey's success screen reading a stale sessionStorage number is exactly
 * the class of bug this closes).
 *
 * It owns NO arithmetic of its own — computeFastPassTotalCents() stays the only
 * home of the +15% premium and the discount ordering.
 */
describe("fastPassTotalForPaymentOption (#440)", () => {
  const UPSELLS: ("utility_setup" | "staging_consult")[] = ["utility_setup", "staging_consult"];

  it("returns the agreed total unchanged for now / seller_concession", () => {
    expect(fastPassTotalForPaymentOption(EXPECTED_TOTAL, UPSELLS, "now")).toBe(EXPECTED_TOTAL);
    expect(fastPassTotalForPaymentOption(EXPECTED_TOTAL, UPSELLS, "seller_concession")).toBe(
      EXPECTED_TOTAL
    );
  });

  it("adds the +15% deferral premium to the agreed total exactly once for at_closing", () => {
    expect(fastPassTotalForPaymentOption(EXPECTED_TOTAL, UPSELLS, "at_closing")).toBe(
      EXPECTED_AT_CLOSING_TOTAL
    );
    // Literal 1.15 so a wrong multiplier is still caught here too.
    expect(fastPassTotalForPaymentOption(EXPECTED_TOTAL, UPSELLS, "at_closing")).toBe(
      Math.round(EXPECTED_TOTAL * 1.15)
    );
  });

  it("honours a DISCOUNTED agreed total — the promo is not silently dropped", () => {
    // A #281 promo took $200 off at enrollment; the premium multiplies the
    // discounted basket, never the list price.
    const discounted = EXPECTED_TOTAL - 20000;
    expect(fastPassTotalForPaymentOption(discounted, UPSELLS, "now")).toBe(discounted);
    expect(fastPassTotalForPaymentOption(discounted, UPSELLS, "at_closing")).toBe(
      Math.round(discounted * 1.15)
    );
  });

  it("never charges more than the current catalog price if the catalog is repriced DOWN", () => {
    // Agreed total above today's subtotal (add-ons were cheapened after they
    // enrolled) — the buyer gets the lower number, never the stale higher one.
    const stale = EXPECTED_TOTAL + 50000;
    expect(fastPassTotalForPaymentOption(stale, UPSELLS, "now")).toBe(EXPECTED_TOTAL);
  });
});

/**
 * #453 (FF20) — the last swallow-and-succeed path in the OLD enrollment route.
 *
 * `POST /fastpass` used to catch a Stripe failure on the `payment_option:
 * "now"` branch, log it, and fall through to a plain `{ ok: true }` — success
 * reported for a payment that never happened (#412). #439 stopped the survey
 * sending an option and #440 rebuilt payment on `/fastpass/pay`, so nothing in
 * the app reaches it any more, but a direct API call still could.
 *
 * The `now` branch is KEPT — it still has callers (this file and the #281 promo
 * suite exercise its server-side pricing) — and made to fail loudly, mirroring
 * `/fastpass/pay`:
 *   - a thrown Stripe error, or a session with no `url`, is a 502
 *   - the already-persisted enrollment is demoted back to `pending_payment`
 *     with no `payment_option`, so `/fastpass/pay` can still settle it rather
 *     than stranding the buyer on an `active`-but-unpaid, unpayable record
 *
 * The paths the app actually uses are pinned here as regressions: NO
 * `payment_option` (onboarding, #439) and both deferred options are untouched.
 */
describe("POST /api/deals/[id]/fastpass — 'now' that cannot reach Checkout (#453)", () => {
  async function enroll(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassRoute(r, ctx(dealId));
  }

  async function pay(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassPayRoute(r, ctx(dealId));
  }

  async function readFastPass(dealId: string) {
    const rows = await prisma.$queryRaw<
      {
        status: string | null;
        payment_option: string | null;
        total_cents: string | null;
        paid: boolean | null;
        selected_upsells: unknown;
        enrolled_at: string | null;
        survey_situation: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'                              AS status,
             fast_pass->>'payment_option'                      AS payment_option,
             fast_pass->>'total_cents'                         AS total_cents,
             (fast_pass->>'paid')::boolean                     AS paid,
             fast_pass->'selected_upsells'                     AS selected_upsells,
             fast_pass->>'enrolled_at'                         AS enrolled_at,
             fast_pass->'survey_answers'->>'currentSituation'  AS survey_situation
      FROM deals WHERE id = ${dealId}::uuid
    `;
    return rows[0];
  }

  /** Stripe stub whose Checkout create always throws (no key, API down, …). */
  function stripeThrows(): void {
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            throw new Error("stripe is down");
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });
  }

  /** Records whether Stripe was touched at all; returns a getter for the flag. */
  function stripeMustNotBeCalled(): () => boolean {
    let called = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            called = true;
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
    return () => called;
  }

  // ── 1. Stripe throws → non-2xx, never `{ ok: true }` (the #412 defect) ─────
  it("Stripe create throws → 502, no checkout_url, and NEVER ok:true", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Broken Way" });
    stripeThrows();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: ["utility_setup", "staging_consult"],
    });

    // Non-2xx is the contract; 502 is the shape /fastpass/pay already uses.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("checkout");
    // The old code returned a JSON body claiming success — it must be gone.
    expect(text).not.toContain('"ok":true');
  });

  it("Stripe create throws → the enrollment is left payable, not active-and-unpaid", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "2 Broken Way" });
    stripeThrows();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: ["utility_setup", "staging_consult"],
      survey_answers: { currentSituation: "renting" },
    });
    expect(res.status).toBe(502);

    const row = await readFastPass(deal.id);
    // Demoted to the #439 shape: awaiting payment, no option chosen, unpaid.
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBeNull();
    expect(row.paid).toBe(false);
    // Nothing else about the enrollment is disturbed.
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
    expect(row.selected_upsells).toEqual(["utility_setup", "staging_consult"]);
    expect(row.survey_situation).toBe("renting");
    expect(row.enrolled_at).toBeTruthy();
  });

  // ── 2. A session with no url is the same failure ───────────────────────────
  it("Stripe returns a session with url:null → 502, no checkout_url", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "3 Nourl Rd" });
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => ({ id: "cs_no_url", url: null }),
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
    });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('"ok":true');

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBeNull();
    expect(row.paid).toBe(false);
  });

  it("after a failed 'now', /fastpass/pay can still settle the enrollment", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "4 Retry Ave" });
    stripeThrows();

    expect(
      (
        await enroll(deal.id, "auth0|a", ["agent"], {
          payment_option: "now",
          selected_upsells: [],
        })
      ).status
    ).toBe(502);

    // The buyer retries from their dashboard, deferring instead. This only
    // works because the failed attempt left the enrollment `pending_payment`.
    const res = await pay(deal.id, "auth0|a", ["agent"], {
      payment_option: "seller_concession",
    });
    expect(res.status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("seller_concession");
    expect(row.paid).toBe(false);
  });

  // ── 3. REGRESSION: the path the app actually uses is untouched (#439) ──────
  it("NO payment_option → 200 pending_payment, Stripe never consulted (#439)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id, title: "5 Survey St" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    // Even a Stripe that would blow up must not be reached on this path.
    stripeThrows();

    const res = await enroll(deal.id, "auth0|buyer", ["buyer"], {
      selected_upsells: ["utility_setup", "staging_consult"],
      survey_answers: { currentSituation: "renting" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      status?: string;
      checkout_url?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending_payment");
    expect(body.checkout_url).toBeUndefined();

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBeNull();
    expect(row.paid).toBe(false);
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
  });

  // ── 4. The deferred options behave exactly as before ───────────────────────
  it("at_closing → 200 active with the +15% premium, no Stripe call", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "6 Closing Ct" });
    const stripeCalled = stripeMustNotBeCalled();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: ["utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("active");
    expect(stripeCalled()).toBe(false);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("at_closing");
    expect(row.total_cents).toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    expect(row.paid).toBe(false);
  });

  it("seller_concession → 200 active at the un-premiumed total, no Stripe call", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "7 Concession Cl" });
    const stripeCalled = stripeMustNotBeCalled();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "seller_concession",
      selected_upsells: ["utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(200);
    expect(stripeCalled()).toBe(false);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("seller_concession");
    // No deferral premium — that only attaches to at_closing (#280).
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
    expect(row.total_cents).not.toBe(String(EXPECTED_AT_CLOSING_TOTAL));
    expect(row.paid).toBe(false);
  });

  it("a successful 'now' still returns the checkout_url — the happy path is untouched", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "8 Happy Path" });
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => ({
            id: "cs_ok",
            url: "https://stripe.test/checkout/cs_ok",
          }),
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(body.ok).toBe(true);
    expect(body.checkout_url).toBe("https://stripe.test/checkout/cs_ok");

    const row = await readFastPass(deal.id);
    // #463: still `pending_payment` — the webhook, not the redirect, activates.
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBe("now");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #463 (FF23) — the old enrollment route's `now` branch must not claim an
// enrollment is settled before the money arrives, and must record the Checkout
// session it minted.
//
// Two defects, deliberately one ticket:
//
//   1. A SUCCESSFUL `now` used to persist `status: 'active'` the moment Stripe
//      handed back a URL. A buyer who reached Checkout and closed the tab left
//      an `active`, unpaid enrollment behind — a payment record that lies.
//   2. It stored no `checkout_session_id`, so the #282 double-session guard in
//      /fastpass/pay could not see a session this route created.
//
// Fixing (1) alone would re-open a double-charge path: the `active` status was
// the only thing making /pay 409 such a record. Hence both, together.
//
// This route is not reachable from the UI (FastPassSurvey stopped sending a
// payment_option in #439, and BuyerView posts to /fastpass/pay), so these are
// latent defects on a direct-API path — but it is still a payment route.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/deals/[id]/fastpass — 'now' is not paid until the webhook (#463)", () => {
  async function enroll(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassRoute(r, ctx(dealId));
  }

  async function pay(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassPayRoute(r, ctx(dealId));
  }

  async function readFastPass(dealId: string) {
    const rows = await prisma.$queryRaw<
      {
        status: string | null;
        payment_option: string | null;
        total_cents: string | null;
        paid: boolean | null;
        session_id: string | null;
        paid_at: string | null;
        selected_upsells: unknown;
        enrolled_at: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'              AS status,
             fast_pass->>'payment_option'      AS payment_option,
             fast_pass->>'total_cents'         AS total_cents,
             (fast_pass->>'paid')::boolean     AS paid,
             fast_pass->>'checkout_session_id' AS session_id,
             fast_pass->>'paid_at'             AS paid_at,
             fast_pass->'selected_upsells'     AS selected_upsells,
             fast_pass->>'enrolled_at'         AS enrolled_at
      FROM deals WHERE id = ${dealId}::uuid
    `;
    return rows[0];
  }

  /**
   * Stripe fake. `create` mints sequential open sessions and records every
   * params object; `retrieve` reports the remembered status (open sessions keep
   * a payable url, expired ones don't — matching real Stripe).
   */
  function fakeStripe(seed: Record<string, "open" | "complete" | "expired"> = {}) {
    const createCalls: Stripe.Checkout.SessionCreateParams[] = [];
    const status: Record<string, "open" | "complete" | "expired"> = { ...seed };
    let n = 0;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            createCalls.push(params);
            n += 1;
            const id = `cs_enroll_${n}`;
            status[id] = "open";
            return { id, url: `https://stripe.test/checkout/${id}` };
          },
          retrieve: async (id: string) => {
            const st = status[id] ?? "open";
            return {
              id,
              status: st,
              url: st === "open" ? `https://stripe.test/checkout/${id}` : null,
            } as Pick<Stripe.Checkout.Session, "id" | "url" | "status">;
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });
    return createCalls;
  }

  /** Injects a checkout.session.completed event for the given session shape. */
  function setSessionCompleted(session: Record<string, unknown>) {
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: {
        constructEvent: () =>
          ({
            type: "checkout.session.completed",
            data: { object: session as unknown as Stripe.Checkout.Session },
          }) as unknown as Stripe.Event,
      },
    });
  }

  function webhookReq() {
    return new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=fake,v1=fake" },
      body: "{}",
    });
  }

  // ── 1. A successful `now` stays pending_payment ───────────────────────────
  it("a successful 'now' persists pending_payment, NOT active — no money has arrived yet", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Unpaid Way" });
    fakeStripe();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: ["utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; status?: string };
    expect(body.ok).toBe(true);
    // The echoed status matches /fastpass/pay's contract exactly.
    expect(body.status).toBe("pending_payment");

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.status).not.toBe("active");
    expect(row.paid).toBe(false);
    expect(row.paid_at).toBeNull();
    // The choice IS recorded — only the settlement isn't.
    expect(row.payment_option).toBe("now");
    // Nothing else about the enrollment shifted.
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
    expect(row.selected_upsells).toEqual(["utility_setup", "staging_consult"]);
    expect(row.enrolled_at).toBeTruthy();
  });

  // ── 2. The minted session id is recorded ──────────────────────────────────
  it("a successful 'now' stores the checkout_session_id it just minted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "2 Session Sq" });
    fakeStripe();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url?: string };
    expect(body.checkout_url).toBe("https://stripe.test/checkout/cs_enroll_1");

    const row = await readFastPass(deal.id);
    expect(row.session_id).toBe("cs_enroll_1");
  });

  // ── 3. The webhook promotes a record from THIS route just like one from /pay
  it("the webhook promotes a record from this route identically to one from /fastpass/pay (#440 CASE)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const viaEnroll = await createDeal({ agent_id: agent.id, title: "3 Old Route" });
    const viaPay = await createDeal({ agent_id: agent.id, title: "3 New Route" });

    fakeStripe();
    expect(
      (
        await enroll(viaEnroll.id, "auth0|a", ["agent"], {
          payment_option: "now",
          selected_upsells: ["utility_setup"],
        })
      ).status
    ).toBe(200);

    // The /pay equivalent: a #439 deferred enrollment settled from the dashboard.
    expect(
      (
        await enroll(viaPay.id, "auth0|a", ["agent"], {
          selected_upsells: ["utility_setup"],
        })
      ).status
    ).toBe(200);
    expect(
      (await pay(viaPay.id, "auth0|a", ["agent"], { payment_option: "now" })).status
    ).toBe(200);

    // Both records reach the webhook in the SAME state — that is the parity
    // the #440 CASE promotion depends on.
    const beforeEnroll = await readFastPass(viaEnroll.id);
    const beforePay = await readFastPass(viaPay.id);
    expect(beforeEnroll.status).toBe("pending_payment");
    expect(beforePay.status).toBe("pending_payment");
    expect(beforeEnroll.session_id).toBeTruthy();
    expect(beforePay.session_id).toBeTruthy();

    for (const dealId of [viaEnroll.id, viaPay.id]) {
      setSessionCompleted({
        id: "cs_webhook_promo",
        payment_status: "paid",
        metadata: { deal_id: dealId, type: "fast_pass" },
      });
      expect((await stripeWebhook(webhookReq())).status).toBe(200);
    }

    const afterEnroll = await readFastPass(viaEnroll.id);
    const afterPay = await readFastPass(viaPay.id);
    for (const row of [afterEnroll, afterPay]) {
      expect(row.paid).toBe(true);
      expect(row.status).toBe("active");
      expect(row.session_id).toBe("cs_webhook_promo");
      expect(row.paid_at).toBeTruthy();
      expect(row.payment_option).toBe("now");
    }
    // Identical lifecycle, not merely both "fine".
    expect(afterEnroll.status).toBe(afterPay.status);
    expect(afterEnroll.paid).toBe(afterPay.paid);
    expect(afterEnroll.total_cents).toBe(afterPay.total_cents);
  });

  // ── 4. /fastpass/pay now SEES the session this route created (#282) ────────
  it("/fastpass/pay reuses the session this route stored instead of minting a second (#282)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "4 One Session" });
    const calls = fakeStripe();

    expect(
      (
        await enroll(deal.id, "auth0|a", ["agent"], {
          payment_option: "now",
          selected_upsells: [],
        })
      ).status
    ).toBe(200);
    expect(calls).toHaveLength(1);

    // The buyer re-opens the pay card and clicks "pay now" again.
    const res = await pay(deal.id, "auth0|a", ["agent"], { payment_option: "now" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url?: string };
    // Same live session, not a second independently-payable one.
    expect(body.checkout_url).toBe("https://stripe.test/checkout/cs_enroll_1");
    expect(calls).toHaveLength(1);
    expect((await readFastPass(deal.id)).session_id).toBe("cs_enroll_1");
  });

  it("a live session from this route also blocks a DEFERRAL through /fastpass/pay", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "5 No Deferral" });
    fakeStripe();

    expect(
      (
        await enroll(deal.id, "auth0|a", ["agent"], {
          payment_option: "now",
          selected_upsells: [],
        })
      ).status
    ).toBe(200);

    // Recording "pay at closing" while a session charging the un-premiumed
    // total is still payable would leave the buyer able to pay an amount the
    // record no longer agrees with.
    const res = await pay(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
    });
    expect(res.status).toBe(409);
    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBe("now");
  });

  // ── 5. #453 is unregressed: a FAILED 'now' still 502s and stays payable ────
  it("a failed 'now' still 502s and leaves the enrollment payable at pending_payment (#453)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "6 Still Broken" });
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            throw new Error("stripe is down");
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: ["utility_setup", "staging_consult"],
    });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('"ok":true');

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    // Demoted back to the #439 shape so the dashboard pay card offers the
    // choice again — a `now` that never reached Checkout is not a choice made.
    expect(row.payment_option).toBeNull();
    expect(row.paid).toBe(false);
    // No session was minted, so none may be recorded — otherwise the #282
    // guard would later try to retrieve a session that does not exist.
    expect(row.session_id).toBeNull();
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
  });

  // ── 6. REGRESSION: the path the app actually uses is untouched (#439) ──────
  it("no payment_option → 200 pending_payment, no Stripe, no session id (#439 regression)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const deal = await createDeal({ agent_id: agent.id, title: "7 Survey St" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    let stripeTouched = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            stripeTouched = true;
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

    const res = await enroll(deal.id, "auth0|buyer", ["buyer"], {
      selected_upsells: ["utility_setup", "staging_consult"],
      survey_answers: { currentSituation: "renting" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok?: boolean;
      status?: string;
      checkout_url?: string;
    };
    expect(body.ok).toBe(true);
    expect(body.status).toBe("pending_payment");
    expect(body.checkout_url).toBeUndefined();
    expect(stripeTouched).toBe(false);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("pending_payment");
    expect(row.payment_option).toBeNull();
    expect(row.paid).toBe(false);
    expect(row.session_id).toBeNull();
    expect(row.total_cents).toBe(String(EXPECTED_TOTAL));
  });

  it("the deferred options still activate immediately, with no session id", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    for (const option of ["at_closing", "seller_concession"] as const) {
      const deal = await createDeal({ agent_id: agent.id, title: `8 ${option}` });
      fakeStripe();
      const res = await enroll(deal.id, "auth0|a", ["agent"], {
        payment_option: option,
        selected_upsells: [],
      });
      expect(res.status).toBe(200);
      const row = await readFastPass(deal.id);
      // No money moves now, so `active` is honest here — unchanged behaviour.
      expect(row.status).toBe("active");
      expect(row.payment_option).toBe(option);
      expect(row.paid).toBe(false);
      expect(row.session_id).toBeNull();
    }
  });

  // ── 7. checkout_session_id is plumbing — it never reaches a client ─────────
  it("the checkout_session_id never appears in the route's response payload", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "9 No Leak Ln" });
    fakeStripe();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // It IS stored…
    expect((await readFastPass(deal.id)).session_id).toBe("cs_enroll_1");
    // …and it is NOT a field on the payload. (The id is not a secret — a real
    // Checkout URL embeds it, and the buyer's browser is about to be sent
    // there. What must not happen is the enrollment's internal plumbing key
    // becoming part of the wire schema, which is what clients would then read.)
    expect(text).not.toContain("checkout_session_id");
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("checkout_session_id");
    expect(Object.keys(payload).sort()).toEqual(["checkout_url", "ok", "status"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #413 — Stripe Checkout is prefilled with the PAYING USER's account email.
//
// Read server-side from `users.email` for the authenticated caller, never from
// the request body: an email taken from the client would let a caller point the
// receipt (and the Stripe customer record) at an address they don't own.
//
// /fastpass/pay already does this (its own case lives above). These cover the
// old enrollment route; the sibling checkouts (Smooth Exit, closing fee) are
// covered in tests/api/smoothexit.test.ts and tests/api/fee-checkout.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/deals/[id]/fastpass — customer_email prefill (#413)", () => {
  function captureCreate(): Stripe.Checkout.SessionCreateParams[] {
    const calls: Stripe.Checkout.SessionCreateParams[] = [];
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            calls.push(params);
            return {
              id: "cs_email_1",
              url: "https://stripe.test/checkout/cs_email_1",
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
    return calls;
  }

  async function enroll(
    dealId: string,
    auth0Sub: string,
    roles: string[],
    body: Record<string, unknown>
  ): Promise<Response> {
    const r = new Request(`http://localhost/api/deals/${dealId}/fastpass`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return fastPassRoute(r, ctx(dealId));
  }

  it("a 'now' enrollment prefills customer_email from the paying user's users.email", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer",
      email: "betty@buyer.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Prefill Pl" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const calls = captureCreate();

    const res = await enroll(deal.id, "auth0|buyer", ["buyer"], {
      payment_option: "now",
      selected_upsells: [],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // The buyer is the one paying — not the deal's agent.
    expect(calls[0].customer_email).toBe("betty@buyer.test");
    expect(calls[0].customer_email).not.toBe(agent.email);
    // The metadata the refund/dispute webhooks resolve the deal from is intact.
    expect(calls[0].metadata).toMatchObject({ deal_id: deal.id, type: "fast_pass" });
  });

  it("an email in the request body is ignored — the prefill comes from the DB", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|a",
      email: "real@agent.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "2 Spoof St" });
    const calls = captureCreate();

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
      // Hostile client tries to redirect the receipt.
      customer_email: "attacker@evil.test",
      email: "attacker@evil.test",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].customer_email).toBe("real@agent.test");
    expect(calls[0].customer_email).not.toBe("attacker@evil.test");
  });
});
