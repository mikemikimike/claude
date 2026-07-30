import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import type Stripe from "stripe";
import { POST as fastPassRoute } from "@/app/api/deals/[id]/fastpass/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { FAST_PASS_BASE_PRICE_CENTS } from "@/lib/fast-pass-catalog";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

// Issue #281 — promo codes are admin-CRUD'd but never redeemable. These tests
// drive redemption through the Fast Pass enrollment route (the pilot surface):
// a server-validated code discounts the server-computed total, uses_count
// increments transactionally with the enrollment, and no client-supplied
// discount is ever trusted.

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

// No upsells → subtotal is just the base fee. Keeps the discount math obvious.
const SUBTOTAL = FAST_PASS_BASE_PRICE_CENTS;
// Derived, never hardcoded: a base-price change should not need edits here.
const TEN_PCT_DISCOUNT = Math.round(SUBTOTAL * 0.1);

type PromoSeed = {
  code: string;
  discount_type: "pct" | "fixed";
  discount_value: number;
  applies_to?: string[];
  max_uses?: number | null;
  uses_count?: number;
  expires_at?: Date | null;
};

async function seedPromo(p: PromoSeed): Promise<string> {
  const row = await prisma.promo_codes.create({
    data: {
      code: p.code,
      discount_type: p.discount_type,
      discount_value: p.discount_value,
      applies_to: p.applies_to ?? ["fast_pass"],
      max_uses: p.max_uses ?? null,
      uses_count: p.uses_count ?? 0,
      expires_at: p.expires_at ?? null,
    },
    select: { id: true },
  });
  return row.id;
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

async function readFastPass(dealId: string) {
  const rows = await prisma.$queryRaw<
    { total_cents: string | null; promo_code: string | null; discount_cents: string | null }[]
  >`
    SELECT fast_pass->>'total_cents'    AS total_cents,
           fast_pass->>'promo_code'     AS promo_code,
           fast_pass->>'discount_cents' AS discount_cents
    FROM deals WHERE id = ${dealId}::uuid
  `;
  return rows[0];
}

async function usesCount(promoId: string): Promise<number> {
  const row = await prisma.promo_codes.findUnique({
    where: { id: promoId },
    select: { uses_count: true },
  });
  return row!.uses_count;
}

describe("Fast Pass promo redemption (#281)", () => {
  // ── Case 1: active pct code applied → discount persisted + charged ──────────
  it("active pct code + 'now' → Stripe charges discounted total, enrollment persists the discount, uses_count → 1", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Discount Way" });
    const promoId = await seedPromo({ code: "SAVE10", discount_type: "pct", discount_value: 10 });

    const expectedDiscount = TEN_PCT_DISCOUNT;
    const expectedTotal = SUBTOTAL - expectedDiscount;

    let captured: Stripe.Checkout.SessionCreateParams | undefined;
    setStripeForTesting({
      checkout: {
        sessions: {
          create: async (params: Stripe.Checkout.SessionCreateParams) => {
            captured = params;
            return { id: "cs_promo_1", url: "https://stripe.test/checkout/cs_promo_1" };
          },
        },
      },
      webhooks: { constructEvent: () => { throw new Error("not used"); } },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
      // Hostile client claims a bogus discount + total — both must be ignored.
      promo_code: "save10",
      total_cents: 1,
      discount_cents: 999999,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok?: boolean; checkout_url?: string };
    expect(json.checkout_url).toBe("https://stripe.test/checkout/cs_promo_1");

    // Stripe billed the server-computed discounted amount, not the client's cent.
    expect(captured?.line_items?.[0]?.price_data?.unit_amount).toBe(expectedTotal);

    // Enrollment persists the discounted total (server recomputed).
    const fp = await readFastPass(deal.id);
    expect(fp.total_cents).toBe(String(expectedTotal));
    expect(fp.promo_code).toBe("SAVE10");
    expect(fp.discount_cents).toBe(String(expectedDiscount));

    // uses_count incremented exactly once.
    expect(await usesCount(promoId)).toBe(1);
  });

  it("active fixed ($) code + 'at_closing' → discount THEN +15% premium composed, persisted, no Stripe, uses_count → 1", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    // Fixed discount_value is DOLLARS (admin UI: "Fixed ($)"). $100 → 10000 cents.
    const promoId = await seedPromo({ code: "FLAT100", discount_type: "fixed", discount_value: 100 });
    // Composed order (#281 + #280): discount the subtotal FIRST, then apply the
    // at_closing +15% premium on the already-discounted basket.
    const discounted = SUBTOTAL - 10000;
    const expectedTotal = Math.round(discounted * 1.15);

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: [],
      promo_code: "FLAT100",
    });
    expect(res.status).toBe(200);

    const fp = await readFastPass(deal.id);
    expect(fp.total_cents).toBe(String(expectedTotal));
    // discount_cents records the SUBTOTAL discount (pre-premium), not the delta.
    expect(fp.discount_cents).toBe("10000");
    expect(await usesCount(promoId)).toBe(1);
  });

  it("no promo_code + 'at_closing' → #280 premium only, no discount (regression: existing flow unchanged)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: [],
    });
    expect(res.status).toBe(200);
    const fp = await readFastPass(deal.id);
    // No code → #280's plain at_closing premium: round(subtotal × 1.15).
    expect(fp.total_cents).toBe(String(Math.round(SUBTOTAL * 1.15)));
    expect(fp.promo_code).toBeNull();
  });

  // ── Case 2: invalid codes → 400, nothing persisted, uses_count untouched ────
  it("expired code → 400, enrollment NOT persisted, uses_count untouched", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const promoId = await seedPromo({
      code: "EXPIRED",
      discount_type: "pct",
      discount_value: 10,
      expires_at: new Date(Date.now() - 24 * 3600 * 1000),
    });

    let stripeCalled = false;
    setStripeForTesting({
      checkout: { sessions: { create: async () => { stripeCalled = true; return { id: "x", url: "x" }; } } },
      webhooks: { constructEvent: () => { throw new Error("not used"); } },
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "now",
      selected_upsells: [],
      promo_code: "EXPIRED",
    });
    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain("expired");
    expect(stripeCalled).toBe(false);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
    expect(await usesCount(promoId)).toBe(0);
  });

  it("applies_to excludes fast_pass → 400, nothing persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const promoId = await seedPromo({
      code: "SMOOTHONLY",
      discount_type: "pct",
      discount_value: 10,
      applies_to: ["smooth_exit"],
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: [],
      promo_code: "SMOOTHONLY",
    });
    expect(res.status).toBe(400);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
    expect(await usesCount(promoId)).toBe(0);
  });

  it("code already at max_uses → 400, nothing persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const promoId = await seedPromo({
      code: "MAXED",
      discount_type: "pct",
      discount_value: 10,
      max_uses: 1,
      uses_count: 1,
    });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: [],
      promo_code: "MAXED",
    });
    expect(res.status).toBe(400);
    expect((await res.text()).toLowerCase()).toContain("limit");

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
    expect(await usesCount(promoId)).toBe(1);
  });

  it("unknown code → 400, nothing persisted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await enroll(deal.id, "auth0|a", ["agent"], {
      payment_option: "at_closing",
      selected_upsells: [],
      promo_code: "NOPE",
    });
    expect(res.status).toBe(400);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fast_pass).toBeNull();
  });

  // ── Case 3: concurrency — no double-spend under max_uses: 1 ──────────────────
  it("two concurrent redemptions of a max_uses:1 code → exactly one discounts; uses_count ends at 1", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const dealA = await createDeal({ agent_id: agent.id, title: "A" });
    const dealB = await createDeal({ agent_id: agent.id, title: "B" });
    const promoId = await seedPromo({
      code: "ONESHOT",
      discount_type: "pct",
      discount_value: 10,
      max_uses: 1,
    });

    const [resA, resB] = await Promise.all([
      enroll(dealA.id, "auth0|a", ["agent"], {
        payment_option: "at_closing",
        selected_upsells: [],
        promo_code: "ONESHOT",
      }),
      enroll(dealB.id, "auth0|a", ["agent"], {
        payment_option: "at_closing",
        selected_upsells: [],
        promo_code: "ONESHOT",
      }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([200, 400]); // exactly one won, one rejected

    // No double-spend: the code was consumed exactly once.
    expect(await usesCount(promoId)).toBe(1);

    // Exactly one deal ended up enrolled, at the composed discounted at_closing
    // price: (subtotal − 10% discount) × 1.15.
    const fps = await Promise.all([readFastPass(dealA.id), readFastPass(dealB.id)]);
    const enrolled = fps.filter((f) => f.total_cents != null);
    expect(enrolled).toHaveLength(1);
    expect(enrolled[0].total_cents).toBe(
      String(Math.round((SUBTOTAL - TEN_PCT_DISCOUNT) * 1.15))
    );
  });
});
