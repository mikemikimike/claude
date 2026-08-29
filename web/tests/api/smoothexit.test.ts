import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type Stripe from "stripe";
import { POST as smoothExitRoute } from "@/app/api/deals/[id]/smoothexit/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
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

describe("POST /api/deals/[id]/smoothexit", () => {
  it("owner enrolls with no upsells → 200 {ok:true}, enrollment persisted active", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "123 Main St" });

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 450000,
        fee_cents: 450000,
        survey_answers: { goal: "upsize", timeline: "asap" },
        selected_upsells: [],
        upsell_total_cents: 0,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBeUndefined();

    // Read back the JSONB via raw SQL to confirm the persisted shape.
    const rows = await prisma.$queryRaw<
      {
        status: string;
        payment_option: string;
        estimated_sale_price: string;
        fee_cents: string;
        upsell_total_cents: string;
        upsells_paid: boolean;
        survey_goal: string;
        selected_upsells: unknown;
        enrolled_at: string | null;
      }[]
    >`
      SELECT smooth_exit->>'status'                       AS status,
             smooth_exit->>'payment_option'               AS payment_option,
             smooth_exit->>'estimated_sale_price'         AS estimated_sale_price,
             smooth_exit->>'fee_cents'                    AS fee_cents,
             smooth_exit->>'upsell_total_cents'           AS upsell_total_cents,
             (smooth_exit->>'upsells_paid')::boolean      AS upsells_paid,
             smooth_exit->'survey_answers'->>'goal'       AS survey_goal,
             smooth_exit->'selected_upsells'              AS selected_upsells,
             smooth_exit->>'enrolled_at'                  AS enrolled_at
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    const row = rows[0];
    expect(row.status).toBe("active");
    expect(row.payment_option).toBe("from_proceeds");
    expect(row.estimated_sale_price).toBe("450000");
    expect(row.fee_cents).toBe("450000");
    expect(row.upsell_total_cents).toBe("0");
    expect(row.upsells_paid).toBe(false);
    expect(row.survey_goal).toBe("upsize");
    expect(row.selected_upsells).toEqual([]);
    expect(row.enrolled_at).toBeTruthy();
  });

  it("owner enrolls WITH upsells → 200 {ok:true, checkout_url}; Stripe gets right amount + metadata", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "456 Oak Ave" });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_smoothexit_1",
              url: "https://stripe.test/checkout/cs_smoothexit_1",
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "buyer_concession",
        estimated_sale_price: 600000,
        fee_cents: 600000,
        survey_answers: { goal: "downsize" },
        // staging_consult (24700) + photography_upgrade (19700) = 44400
        selected_upsells: ["staging_consult", "photography_upgrade"],
        upsell_total_cents: 44400,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBe("https://stripe.test/checkout/cs_smoothexit_1");

    // Stripe received the catalog amount, correct product, and metadata.
    expect(captured).toBeDefined();
    const lineItem = captured!.line_items?.[0];
    expect(lineItem?.price_data?.unit_amount).toBe(44400);
    expect(lineItem?.price_data?.product_data?.name).toBe("Smooth Exit Add-ons");
    expect(lineItem?.price_data?.product_data?.description).toBe(
      "Concierge add-ons for: 456 Oak Ave"
    );
    expect(captured!.mode).toBe("payment");
    expect(captured!.metadata).toMatchObject({
      deal_id: deal.id,
      type: "smooth_exit_upsell",
    });
    expect(captured!.success_url).toContain(
      `/smooth-exit/complete?deal_id=${deal.id}&upsells=paid`
    );
    expect(captured!.cancel_url).toContain(
      `/smooth-exit/survey?deal_id=${deal.id}&cancelled=1`
    );

    // Enrollment is still persisted (upsells_paid stays false until webhook)
    // with the SERVER-computed total.
    const rows = await prisma.$queryRaw<
      { status: string; upsells_paid: boolean; upsell_total_cents: string }[]
    >`
      SELECT smooth_exit->>'status' AS status,
             (smooth_exit->>'upsells_paid')::boolean AS upsells_paid,
             smooth_exit->>'upsell_total_cents' AS upsell_total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].status).toBe("active");
    expect(rows[0].upsells_paid).toBe(false);
    expect(rows[0].upsell_total_cents).toBe("44400");
  });

  it("tampered upsell_total_cents is ignored — server prices from the catalog", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "789 Pine Ln" });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_smoothexit_2",
              url: "https://stripe.test/checkout/cs_smoothexit_2",
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 500000,
        fee_cents: 500000,
        // Hostile client claims the add-ons cost 1 cent.
        selected_upsells: ["staging_consult", "photography_upgrade"],
        upsell_total_cents: 1,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.checkout_url).toBe("https://stripe.test/checkout/cs_smoothexit_2");

    // Stripe is charged the catalog total, not the client's number.
    expect(captured).toBeDefined();
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(44400);

    // And the JSONB stores the server-computed total.
    const rows = await prisma.$queryRaw<{ upsell_total_cents: string }[]>`
      SELECT smooth_exit->>'upsell_total_cents' AS upsell_total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsell_total_cents).toBe("44400");
  });

  it("unknown upsell key → 400, no Stripe call, existing enrollment untouched", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    // Seed a prior enrollment so we can prove the bad request doesn't clobber it.
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          selected_upsells: [],
          upsell_total_cents: 0,
          upsells_paid: false,
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "buyer_concession",
        selected_upsells: ["staging_consult", "free_money"],
        upsell_total_cents: 1,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("free_money");
    expect(stripeCalled).toBe(false);

    // Validation happens BEFORE persisting — the seeded enrollment survives.
    const rows = await prisma.$queryRaw<
      { payment_option: string; enrolled_at: string }[]
    >`
      SELECT smooth_exit->>'payment_option' AS payment_option,
             smooth_exit->>'enrolled_at'    AS enrolled_at
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].payment_option).toBe("from_proceeds");
    expect(rows[0].enrolled_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("seller participant enrolls own deal with no upsells → 200 {ok:true}, enrollment persisted (#170)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const seller = await createUser({ role: "seller", auth0_id: "auth0|seller" });
    const deal = await createDeal({ agent_id: agent.id, title: "321 Cedar Ct" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: seller.id, role: "seller" },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|seller", ["seller"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 400000,
        fee_cents: 400000,
        survey_answers: { goal: "relocate" },
        selected_upsells: [],
        upsell_total_cents: 0,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    expect(json.checkout_url).toBeUndefined();

    const rows = await prisma.$queryRaw<
      { status: string; payment_option: string; upsells_paid: boolean }[]
    >`
      SELECT smooth_exit->>'status' AS status,
             smooth_exit->>'payment_option' AS payment_option,
             (smooth_exit->>'upsells_paid')::boolean AS upsells_paid
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].status).toBe("active");
    expect(rows[0].payment_option).toBe("from_proceeds");
    expect(rows[0].upsells_paid).toBe(false);
  });

  it("seller participant's tampered upsell_total_cents is ignored — Stripe charges the catalog total, seller-facing return URLs (#170)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const seller = await createUser({ role: "seller", auth0_id: "auth0|seller" });
    const deal = await createDeal({ agent_id: agent.id, title: "654 Birch Blvd" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: seller.id, role: "seller" },
    });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_smoothexit_seller",
              url: "https://stripe.test/checkout/cs_smoothexit_seller",
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|seller", ["seller"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 500000,
        fee_cents: 500000,
        // Hostile seller client claims the add-ons cost 1 cent.
        selected_upsells: ["staging_consult", "photography_upgrade"],
        upsell_total_cents: 1,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.checkout_url).toBe(
      "https://stripe.test/checkout/cs_smoothexit_seller"
    );

    // Stripe is charged the server catalog total, not the client's number.
    expect(captured).toBeDefined();
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(44400);

    // Role-aware return URLs (#170): a seller lands back on THEIR portal on
    // success; cancel returns to the survey's ?deal_id entry point so a
    // resubmit works (SmoothExitSurvey keeps its handoff for exactly this).
    expect(captured!.success_url).toBe(
      `http://localhost/seller/${seller.id}?smoothexit=paid`
    );
    expect(captured!.cancel_url).toBe(
      `http://localhost/smooth-exit/survey?deal_id=${deal.id}&cancelled=1`
    );

    // The JSONB stores the SERVER-computed total.
    const rows = await prisma.$queryRaw<{ upsell_total_cents: string }[]>`
      SELECT smooth_exit->>'upsell_total_cents' AS upsell_total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsell_total_cents).toBe("44400");
  });

  it("403 when a seller is NOT a participant on the deal — nothing persisted, no Stripe call (#170)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "seller", auth0_id: "auth0|stranger" });
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|stranger", ["seller"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        selected_upsells: ["staging_consult"],
        upsell_total_cents: 1,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(403);
    expect(stripeCalled).toBe(false);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.smooth_exit).toBeNull();
  });

  it("403 when caller is not the deal owner", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    await createUser({ role: "agent", auth0_id: "auth0|other" });
    const deal = await createDeal({ agent_id: agent.id });

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|other", ["agent"]),
      },
      body: JSON.stringify({ payment_option: "from_proceeds", upsell_total_cents: 0 }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(403);
  });

  it("404 when the deal does not exist", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const missingId = "00000000-0000-0000-0000-000000000000";

    const r = new Request(`http://localhost/api/deals/${missingId}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ payment_option: "from_proceeds", upsell_total_cents: 0 }),
    });
    const res = await smoothExitRoute(r, ctx(missingId));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/deals/[id]/smoothexit — re-enrollment after payment (#260)", () => {
  const PAID_AT = "2026-03-01T12:00:00.000Z";
  const ENROLLED_AT = "2026-02-28T09:00:00.000Z";

  // Seed a smooth_exit that a completed Stripe checkout would have left behind:
  // the webhook (stripe/webhook/route.ts) flips upsells_paid=true and stamps
  // upsells_paid_at + upsells_checkout_session_id. Done directly via Prisma so
  // the paid timestamps are deterministic and assertable.
  async function seedPaidEnrollment(
    dealId: string,
    selected: string[],
    upsellTotalCents: number
  ): Promise<void> {
    await prisma.deals.update({
      where: { id: dealId },
      data: {
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          estimated_sale_price: 500000,
          fee_cents: 500000,
          survey_answers: { goal: "downsize" },
          selected_upsells: selected,
          upsell_total_cents: upsellTotalCents,
          upsells_paid: true,
          upsells_paid_at: PAID_AT,
          upsells_checkout_session_id: "cs_paid_original",
          enrolled_at: ENROLLED_AT,
        },
      },
    });
  }

  it("re-POSTing the same paid enrollment keeps upsells_paid + original upsells_paid_at, and does NOT re-charge (no checkout_url)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "999 Paid Way" });
    // staging_consult = 24700, already paid.
    await seedPaidEnrollment(deal.id, ["staging_consult"], 24700);

    let stripeCalled = false;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => {
            stripeCalled = true;
            return { id: "cs_should_not_happen", url: "https://stripe.test/nope" };
          },
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 500000,
        fee_cents: 500000,
        survey_answers: { goal: "downsize" },
        // Same single upsell that was already paid for.
        selected_upsells: ["staging_consult"],
        upsell_total_cents: 24700,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.ok).toBe(true);
    // No new upsells → no second checkout for services already paid for.
    expect(json.checkout_url).toBeUndefined();
    expect(stripeCalled).toBe(false);

    // The payment record survives: upsells_paid stays true with the ORIGINAL
    // upsells_paid_at + session id, and enrolled_at is not reset.
    const rows = await prisma.$queryRaw<
      {
        upsells_paid: boolean;
        upsells_paid_at: string | null;
        upsells_checkout_session_id: string | null;
        enrolled_at: string | null;
        selected_upsells: unknown;
      }[]
    >`
      SELECT (smooth_exit->>'upsells_paid')::boolean     AS upsells_paid,
             smooth_exit->>'upsells_paid_at'             AS upsells_paid_at,
             smooth_exit->>'upsells_checkout_session_id' AS upsells_checkout_session_id,
             smooth_exit->>'enrolled_at'                 AS enrolled_at,
             smooth_exit->'selected_upsells'             AS selected_upsells
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsells_paid).toBe(true);
    expect(rows[0].upsells_paid_at).toBe(PAID_AT);
    expect(rows[0].upsells_checkout_session_id).toBe("cs_paid_original");
    expect(rows[0].enrolled_at).toBe(ENROLLED_AT);
    expect(rows[0].selected_upsells).toEqual(["staging_consult"]);
  });

  it("re-POSTing a paid enrollment with ONE new upsell charges only the new upsell; selected_upsells is the union, payment record preserved", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "777 Delta Dr" });
    // staging_consult = 24700, already paid.
    await seedPaidEnrollment(deal.id, ["staging_consult"], 24700);

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_smoothexit_delta",
              url: "https://stripe.test/checkout/cs_smoothexit_delta",
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 500000,
        fee_cents: 500000,
        survey_answers: { goal: "downsize" },
        // Keep the paid staging_consult, ADD photography_upgrade (19700).
        selected_upsells: ["staging_consult", "photography_upgrade"],
        // Client claims the full 44400; server must only charge the delta.
        upsell_total_cents: 44400,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.checkout_url).toBe(
      "https://stripe.test/checkout/cs_smoothexit_delta"
    );

    // Stripe is charged ONLY for the newly-added photography_upgrade (19700),
    // NOT the already-paid staging_consult.
    expect(captured).toBeDefined();
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(19700);

    // The payment record for the first upsell is preserved, and selected_upsells
    // stores the union (paid + newly-added). upsell_total_cents reflects the
    // cumulative catalog value of the union (24700 + 19700).
    const rows = await prisma.$queryRaw<
      {
        upsells_paid: boolean;
        upsells_paid_at: string | null;
        enrolled_at: string | null;
        upsell_total_cents: string;
        selected_upsells: string[];
      }[]
    >`
      SELECT (smooth_exit->>'upsells_paid')::boolean AS upsells_paid,
             smooth_exit->>'upsells_paid_at'         AS upsells_paid_at,
             smooth_exit->>'enrolled_at'             AS enrolled_at,
             smooth_exit->>'upsell_total_cents'      AS upsell_total_cents,
             smooth_exit->'selected_upsells'         AS selected_upsells
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsells_paid).toBe(true);
    expect(rows[0].upsells_paid_at).toBe(PAID_AT);
    expect(rows[0].enrolled_at).toBe(ENROLLED_AT);
    expect([...rows[0].selected_upsells].sort()).toEqual([
      "photography_upgrade",
      "staging_consult",
    ]);
    expect(rows[0].upsell_total_cents).toBe("44400");
  });

  it("first-time enrollment (no existing smooth_exit) is unchanged — upsells_paid false, full selection priced, fresh enrolled_at", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "111 First St" });

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return {
              id: "cs_smoothexit_first",
              url: "https://stripe.test/checkout/cs_smoothexit_first",
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

    const r = new Request(`http://localhost/api/deals/${deal.id}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({
        payment_option: "from_proceeds",
        estimated_sale_price: 600000,
        fee_cents: 600000,
        survey_answers: { goal: "downsize" },
        // staging_consult (24700) + photography_upgrade (19700) = 44400
        selected_upsells: ["staging_consult", "photography_upgrade"],
        upsell_total_cents: 44400,
      }),
    });
    const res = await smoothExitRoute(r, ctx(deal.id));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.checkout_url).toBe(
      "https://stripe.test/checkout/cs_smoothexit_first"
    );

    // No prior enrollment → the whole selection is charged.
    expect(captured).toBeDefined();
    expect(captured!.line_items?.[0]?.price_data?.unit_amount).toBe(44400);

    const rows = await prisma.$queryRaw<
      {
        upsells_paid: boolean;
        upsell_total_cents: string;
        enrolled_at: string | null;
        selected_upsells: string[];
      }[]
    >`
      SELECT (smooth_exit->>'upsells_paid')::boolean AS upsells_paid,
             smooth_exit->>'upsell_total_cents'      AS upsell_total_cents,
             smooth_exit->>'enrolled_at'             AS enrolled_at,
             smooth_exit->'selected_upsells'         AS selected_upsells
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsells_paid).toBe(false);
    expect(rows[0].upsell_total_cents).toBe("44400");
    expect(rows[0].enrolled_at).toBeTruthy();
    expect([...rows[0].selected_upsells].sort()).toEqual([
      "photography_upgrade",
      "staging_consult",
    ]);
  });
});

describe("POST /api/deals/[id]/smoothexit — malformed body validation (#88)", () => {
  async function enroll(dealId: string, body: string) {
    const r = new Request(`http://localhost/api/deals/${dealId}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body,
    });
    return smoothExitRoute(r, ctx(dealId));
  }

  it("400 when estimated_sale_price is a string — junk never persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(
      deal.id,
      JSON.stringify({ payment_option: "from_proceeds", estimated_sale_price: "lots" })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("estimated_sale_price");
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.smooth_exit).toBeNull();
  });

  it("400 when fee_cents is a string — junk never persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(
      deal.id,
      JSON.stringify({ payment_option: "from_proceeds", fee_cents: "4500" })
    );
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.smooth_exit).toBeNull();
  });

  it("400 when payment_option is a number — junk never persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, JSON.stringify({ payment_option: 123 }));
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.smooth_exit).toBeNull();
  });

  it("400 (not 500) when the body is JSON null", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "null");
    expect(res.status).toBe(400);
  });

  it("400 when selected_upsells is not an array (unchanged)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(
      deal.id,
      JSON.stringify({ payment_option: "from_proceeds", selected_upsells: "staging_consult" })
    );
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #413 — the Smooth Exit upsell Checkout is prefilled with the PAYING USER's
// account email, read server-side from `users.email`. Same fix as the Fast Pass
// checkouts: without it Stripe collects the address from scratch and the receipt
// can land somewhere other than the RealTourFlow account.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/deals/[id]/smoothexit — customer_email prefill (#413)", () => {
  function captureCreate(): Stripe.Checkout.SessionCreateParams[] {
    const calls: Stripe.Checkout.SessionCreateParams[] = [];
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            calls.push(params);
            return { id: "cs_se_email", url: "https://stripe.test/checkout/cs_se_email" };
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
    const r = new Request(`http://localhost/api/deals/${dealId}/smoothexit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0Sub, roles),
      },
      body: JSON.stringify(body),
    });
    return smoothExitRoute(r, ctx(dealId));
  }

  it("prefills customer_email from the paying user's users.email", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const seller = await createUser({
      role: "seller",
      auth0_id: "auth0|seller",
      email: "sam@seller.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Prefill Pl" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: seller.id, role: "seller" },
    });
    const calls = captureCreate();

    const res = await enroll(deal.id, "auth0|seller", ["seller"], {
      payment_option: "from_proceeds",
      selected_upsells: ["pre_listing_clean"],
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // The seller is paying — not the deal's agent.
    expect(calls[0].customer_email).toBe("sam@seller.test");
    expect(calls[0].customer_email).not.toBe(agent.email);
    // The metadata the refund/dispute webhooks resolve the deal from is intact.
    expect(calls[0].metadata).toMatchObject({
      deal_id: deal.id,
      type: "smooth_exit_upsell",
    });
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
      payment_option: "from_proceeds",
      selected_upsells: ["pre_listing_clean"],
      customer_email: "attacker@evil.test",
      email: "attacker@evil.test",
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].customer_email).toBe("real@agent.test");
    expect(calls[0].customer_email).not.toBe("attacker@evil.test");
  });
});
