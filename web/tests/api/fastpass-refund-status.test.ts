/**
 * #484 (FF28) — a refunded enrolment must stop reading as a *running* service.
 *
 * `markFastPassRefunded()` / `markSmoothExitUpsellRefunded()` in the Stripe
 * webhook already reverse the MONEY (#365/#366): `paid=false`, `refunded=true`,
 * `refunded_at` stamped, merged with `jsonb_set` so no sibling key is clobbered
 * (#260). What they never touched is the enrolment's own lifecycle state — and
 * `status` is what the product reads to decide the service is running
 * (`AgentDashboard`'s `fastPass?.status === 'active'` count, the deal-header and
 * pipeline badges, the buyer's tracker). A refunded client therefore kept
 * counting as an active Fast Pass forever.
 *
 * The two surfaces are NOT symmetric, and this file pins that asymmetry down:
 *
 *  - Fast Pass: the Stripe charge IS the enrolment, so a full reversal is
 *    terminal for the enrolment → `status: 'refunded'`.
 *  - Smooth Exit: the refunded charge is the ADD-ON basket. The enrolment's own
 *    1%-of-sale fee is billed from proceeds at closing and was never part of
 *    this charge, so the enrolment is still running and `status` stays `active`.
 *    `upsells_refunded` is the terminal state for the thing that was refunded.
 *
 * Everything the client agreed to — `total_cents`, `base_price_cents`,
 * `upsell_prices` (#464), `selected_upsells` — survives the refund. A refund
 * reverses the money; it does not erase the record of the deal.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import type Stripe from "stripe";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { GET as listDeals } from "@/app/api/deals/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
import { prisma } from "@/lib/db";
import { apiDealToFrontend, type ApiDeal } from "@/hooks/useDeals";
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

beforeEach(async () => {
  await truncateAll();
});

function webhookReq(): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=fake,v1=fake" },
    body: "{}",
  });
}

/**
 * Injects the event plus a `paymentIntents.retrieve` stub — a Charge/Dispute
 * carries only a payment_intent id, so the handler reads deal_id/type off the
 * PaymentIntent metadata stamped at checkout.
 */
function setEvent(
  event: Record<string, unknown>,
  piMetadata?: Record<string, string> | null
): void {
  setStripeForTesting({
    checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
    paymentIntents: {
      retrieve: async (id: string) =>
        ({ id, metadata: piMetadata ?? {} }) as unknown as Stripe.PaymentIntent,
    },
    webhooks: { constructEvent: () => event as unknown as Stripe.Event },
  });
}

const FP_TOTAL_CENTS = 188_400; // $1,787 base + $97 utility_setup
const FP_BASE_CENTS = 178_700;
const SE_UPSELL_CENTS = 24_700;

/**
 * A paid, active Fast Pass enrolment shaped exactly as `POST /deals/[id]
 * /fastpass` persists it, including #464's `base_price_cents` / `upsell_prices`
 * siblings, plus the fields the webhook stamps on payment.
 */
async function paidFastPassDeal(agentAuth0Id = "auth0|fp-agent") {
  const agent = await createUser({ role: "agent", auth0_id: agentAuth0Id });
  const deal = await createDeal({ agent_id: agent.id });
  await prisma.deals.update({
    where: { id: deal.id },
    data: {
      fast_pass: {
        status: "active",
        payment_option: "now",
        selected_upsells: ["utility_setup"],
        base_price_cents: FP_BASE_CENTS,
        upsell_prices: { utility_setup: 9_700 },
        total_cents: FP_TOTAL_CENTS,
        paid: true,
        checkout_session_id: "cs_fp_paid",
        enrolled_at: "2026-06-01T00:00:00.000Z",
        paid_at: "2026-06-01T00:05:00.000Z",
      },
    },
  });
  return { agent, deal };
}

/** A Smooth Exit enrolment whose ADD-ON basket has been paid for. */
async function paidSmoothExitDeal(agentAuth0Id = "auth0|se-agent") {
  const agent = await createUser({ role: "agent", auth0_id: agentAuth0Id });
  const deal = await createDeal({ agent_id: agent.id, type: "sell" });
  await prisma.deals.update({
    where: { id: deal.id },
    data: {
      smooth_exit: {
        status: "active",
        payment_option: "from_proceeds",
        selected_upsells: ["staging_consult"],
        estimated_sale_price: 450_000,
        fee_cents: 450_000,
        upsell_total_cents: SE_UPSELL_CENTS,
        upsells_paid: true,
        upsells_checkout_session_id: "cs_se_paid",
        enrolled_at: "2026-06-01T00:00:00.000Z",
        upsells_paid_at: "2026-06-01T00:05:00.000Z",
      },
    },
  });
  return { agent, deal };
}

function fullRefund(dealId: string, type: string, amount: number): void {
  setEvent(
    {
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_${type}`,
          payment_intent: `pi_${type}`,
          amount,
          amount_refunded: amount,
        },
      },
    },
    { deal_id: dealId, type }
  );
}

type FastPassRow = {
  status: string;
  paid: boolean;
  refunded: boolean;
  refunded_at: string | null;
  selected: unknown;
  total_cents: number;
  base_price_cents: number;
  upsell_prices: unknown;
};

async function readFastPass(dealId: string): Promise<FastPassRow> {
  const rows = await prisma.$queryRaw<FastPassRow[]>`
    SELECT fast_pass->>'status'                 AS status,
           (fast_pass->>'paid')::boolean        AS paid,
           (fast_pass->>'refunded')::boolean    AS refunded,
           fast_pass->>'refunded_at'            AS refunded_at,
           fast_pass->'selected_upsells'        AS selected,
           (fast_pass->>'total_cents')::int     AS total_cents,
           (fast_pass->>'base_price_cents')::int AS base_price_cents,
           fast_pass->'upsell_prices'           AS upsell_prices
    FROM deals WHERE id = ${dealId}::uuid
  `;
  return rows[0];
}

type SmoothExitRow = {
  status: string;
  upsells_paid: boolean;
  upsells_refunded: boolean;
  upsells_refunded_at: string | null;
  selected: unknown;
  upsell_total_cents: number;
  fee_cents: number;
};

async function readSmoothExit(dealId: string): Promise<SmoothExitRow> {
  const rows = await prisma.$queryRaw<SmoothExitRow[]>`
    SELECT smooth_exit->>'status'                       AS status,
           (smooth_exit->>'upsells_paid')::boolean      AS upsells_paid,
           (smooth_exit->>'upsells_refunded')::boolean  AS upsells_refunded,
           smooth_exit->>'upsells_refunded_at'          AS upsells_refunded_at,
           smooth_exit->'selected_upsells'              AS selected,
           (smooth_exit->>'upsell_total_cents')::int    AS upsell_total_cents,
           (smooth_exit->>'fee_cents')::int             AS fee_cents
    FROM deals WHERE id = ${dealId}::uuid
  `;
  return rows[0];
}

describe("Fast Pass refund → terminal enrolment state (#484)", () => {
  it("a full charge.refunded on a paid enrolment leaves status no longer 'active'", async () => {
    const { deal } = await paidFastPassDeal();
    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);

    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const row = await readFastPass(deal.id);
    // The bug: `status` stayed 'active', so every `=== 'active'` reader kept
    // treating the refunded client as a running Fast Pass.
    expect(row.status).not.toBe("active");
    // The deliberate terminal state — 'refunded', not a cleared enrolment, so
    // the agent can still see that there IS something to talk about.
    expect(row.status).toBe("refunded");
  });

  it("still reverses the money and preserves the agreed record (jsonb_set merge)", async () => {
    const { deal } = await paidFastPassDeal();
    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.paid).toBe(false);
    expect(row.refunded).toBe(true);
    expect(row.refunded_at).toBeTruthy();
    // #260/#464 — the merge is load-bearing. What the client agreed to survives
    // the refund; a whole-object write here would erase it.
    expect(row.total_cents).toBe(FP_TOTAL_CENTS);
    expect(row.selected).toEqual(["utility_setup"]);
    expect(row.base_price_cents).toBe(FP_BASE_CENTS);
    expect(row.upsell_prices).toEqual({ utility_setup: 9_700 });
  });

  it("is idempotent — a duplicate refund event is a no-op", async () => {
    const { deal } = await paidFastPassDeal();
    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);
    const first = await readFastPass(deal.id);

    // Stripe redelivers; the `paid IS TRUE` guard must make the second pass a
    // no-op rather than re-stamping refunded_at or rewriting status.
    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);
    const second = await readFastPass(deal.id);

    expect(second).toEqual(first);
  });

  it("a dispute reaches the same terminal state", async () => {
    const { deal } = await paidFastPassDeal();
    setEvent(
      {
        type: "charge.dispute.created",
        data: { object: { id: "dp_fp", payment_intent: "pi_fp_d" } },
      },
      { deal_id: deal.id, type: "fast_pass" }
    );
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("refunded");
    expect(row.paid).toBe(false);
  });

  it("a PARTIAL refund is a courtesy credit — the enrolment stays active", async () => {
    const { deal } = await paidFastPassDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_fp_partial",
            payment_intent: "pi_fp_partial",
            amount: FP_TOTAL_CENTS,
            amount_refunded: 10_000,
          },
        },
      },
      { deal_id: deal.id, type: "fast_pass" }
    );
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const row = await readFastPass(deal.id);
    expect(row.status).toBe("active");
    expect(row.paid).toBe(true);
  });

  it("never resurrects a never-enrolled deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|none" });
    const deal = await createDeal({ agent_id: agent.id });
    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const rows = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { fast_pass: true },
    });
    // No enrolment in, no enrolment out — a refund must not invent one.
    expect(rows?.fast_pass ?? null).toBeNull();
  });
});

/**
 * The reader the issue names: `AgentDashboard`'s
 * `agentDeals.filter((d) => d.fastPass?.status === 'active').length`.
 *
 * Asserted end-to-end (webhook → DB → GET /api/deals → `apiDealToFrontend`)
 * rather than by handing the component a hand-written `status: 'refunded'`
 * deal — the predicate was always right; what was wrong is the state the
 * server produced, so only the full path can fail for the real reason.
 */
describe("Agent dashboard Fast Pass count after a refund (#484)", () => {
  async function agentDeals(auth0Id: string) {
    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader(auth0Id, ["agent"]) },
      })
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as ApiDeal[]).map(apiDealToFrontend);
  }

  it("excludes a refunded enrolment from the Fast Pass count", async () => {
    const { deal } = await paidFastPassDeal("auth0|count-agent");

    const before = await agentDeals("auth0|count-agent");
    expect(before.filter((d) => d.fastPass?.status === "active").length).toBe(1);

    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const after = await agentDeals("auth0|count-agent");
    expect(after.filter((d) => d.fastPass?.status === "active").length).toBe(0);
  });

  it("keeps a refunded enrolment distinguishable from never enrolled", async () => {
    const { agent, deal } = await paidFastPassDeal("auth0|distinct-agent");
    // A second deal on the same agent that never enrolled at all.
    await createDeal({ agent_id: agent.id });

    fullRefund(deal.id, "fast_pass", FP_TOTAL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const deals = await agentDeals("auth0|distinct-agent");
    const refunded = deals.find((d) => d.id === deal.id);
    const never = deals.find((d) => d.id !== deal.id);

    // "Refunded" is a conversation; "never enrolled" is not. The enrolment
    // object — and the agreed total on it — must still be there.
    expect(refunded?.fastPass?.status).toBe("refunded");
    expect(refunded?.fastPass?.totalCents).toBe(FP_TOTAL_CENTS);
    expect(never?.fastPass).toBeUndefined();
  });
});

/**
 * Smooth Exit. The refunded charge is the ADD-ON basket, not the enrolment —
 * the 1%-of-sale fee comes out of proceeds at closing and was never in this
 * PaymentIntent. So the terminal state belongs on the add-ons, and the
 * enrolment's own `status` deliberately stays `active`: flipping it would drop
 * a seller who is still receiving (and will still be billed for) Smooth Exit
 * off the admin's active list and out of their own portal badge.
 */
describe("Smooth Exit upsell refund → terminal add-on state (#484)", () => {
  it("marks the add-ons refunded and leaves the enrolment itself running", async () => {
    const { deal } = await paidSmoothExitDeal();
    fullRefund(deal.id, "smooth_exit_upsell", SE_UPSELL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const row = await readSmoothExit(deal.id);
    expect(row.upsells_paid).toBe(false);
    expect(row.upsells_refunded).toBe(true);
    expect(row.upsells_refunded_at).toBeTruthy();
    // Deliberate: the service was not refunded, only its add-ons.
    expect(row.status).toBe("active");
    // The agreed record survives the merge (#260).
    expect(row.selected).toEqual(["staging_consult"]);
    expect(row.upsell_total_cents).toBe(SE_UPSELL_CENTS);
    expect(row.fee_cents).toBe(450_000);
  });

  it("is idempotent — a duplicate refund event is a no-op", async () => {
    const { deal } = await paidSmoothExitDeal();
    fullRefund(deal.id, "smooth_exit_upsell", SE_UPSELL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);
    const first = await readSmoothExit(deal.id);

    fullRefund(deal.id, "smooth_exit_upsell", SE_UPSELL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);
    expect(await readSmoothExit(deal.id)).toEqual(first);
  });

  it("surfaces the refunded add-ons to the client so a reader can tell", async () => {
    const { deal } = await paidSmoothExitDeal("auth0|se-reader");
    fullRefund(deal.id, "smooth_exit_upsell", SE_UPSELL_CENTS);
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const res = await listDeals(
      new Request("http://localhost/api/deals", {
        headers: { authorization: await authHeader("auth0|se-reader", ["agent"]) },
      })
    );
    const [d] = ((await res.json()) as ApiDeal[]).map(apiDealToFrontend);
    // Without this on the wire, `upsells_refunded` is written and read by
    // nothing — the UI keeps presenting refunded add-ons as bought.
    expect(d.smoothExit?.upsellsRefunded).toBe(true);
    expect(d.smoothExit?.upsellsPaid).toBe(false);
    expect(d.smoothExit?.status).toBe("active");
  });
});
