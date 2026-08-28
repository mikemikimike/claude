import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type Stripe from "stripe";
import { POST as checkoutRoute } from "@/app/api/deals/[id]/fee/checkout/route";
import { POST as waiveRoute } from "@/app/api/deals/[id]/fee/waive/route";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { PATCH as linkAriveRoute } from "@/app/api/deals/[id]/arive/route";
import { POST as syncAriveRoute } from "@/app/api/deals/[id]/arive/sync/route";
import { POST as ariveWebhook } from "@/app/api/arive/webhook/route";
import { resetEnvForTesting } from "@/lib/env";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setStripeForTesting } from "@/lib/stripe";
import { setAriveForTesting, type AriveClient } from "@/lib/arive";
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
  setAriveForTesting(undefined);
});

beforeEach(async () => {
  await truncateAll();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/deals/[id]/fee/checkout", () => {
  it("creates a session and marks the deal pending", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "Test Deal" });

    setStripeForTesting({
      checkout: {
        sessions: {
          create: async () => ({
            id: "cs_test_123",
            url: "https://stripe.test/checkout/cs_test_123",
          }),
        },
      },
      webhooks: {
        constructEvent: () => {
          throw new Error("not used");
        },
      },
    });

    const req = new Request(
      `http://localhost/api/deals/${deal.id}/fee/checkout`,
      {
        method: "POST",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const res = await checkoutRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkout_url: string };
    expect(body.checkout_url).toBe("https://stripe.test/checkout/cs_test_123");

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("pending");
    expect(row?.fee_checkout_session_id).toBe("cs_test_123");
  });

  it("409 when fee already paid or waived", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "paid" },
    });
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: { constructEvent: () => ({} as Stripe.Event) },
    });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/fee/checkout`,
      {
        method: "POST",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const res = await checkoutRoute(req, ctx(deal.id));
    expect(res.status).toBe(409);
  });

  it("403 when not owner", async () => {
    const agent = await createUser({ role: "agent" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|o" });
    const deal = await createDeal({ agent_id: agent.id });
    void other;
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: { constructEvent: () => ({} as Stripe.Event) },
    });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/fee/checkout`,
      {
        method: "POST",
        headers: { authorization: await authHeader("auth0|o", ["agent"]) },
      }
    );
    const res = await checkoutRoute(req, ctx(deal.id));
    expect(res.status).toBe(403);
  });
});

describe("POST /api/deals/[id]/fee/waive", () => {
  it("admin can waive; status set to waived; non-admin gets 403", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    // Non-admin agent
    const denied = await waiveRoute(
      new Request(`http://localhost/api/deals/${deal.id}/fee/waive`, {
        method: "POST",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(denied.status).toBe(403);

    // Admin succeeds
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const allowed = await waiveRoute(
      new Request(`http://localhost/api/deals/${deal.id}/fee/waive`, {
        method: "POST",
        headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
      }),
      ctx(deal.id)
    );
    expect(allowed.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("waived");
  });
});

describe("POST /api/stripe/webhook", () => {
  // Injects a checkout.session.completed event with the given session shape.
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

  it("checkout.session.completed marks deal paid", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });

    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: {
        constructEvent: () =>
          ({
            type: "checkout.session.completed",
            data: {
              object: {
                id: "cs_test_999",
                payment_status: "paid",
                metadata: { deal_id: deal.id, type: "closing_fee" },
              } as unknown as Stripe.Checkout.Session,
            },
          }) as unknown as Stripe.Event,
      },
    });

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=fake,v1=fake" },
      body: JSON.stringify({ test: true }),
    });
    const res = await stripeWebhook(req);
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("paid");
    expect(row?.fee_paid_at).not.toBeNull();
  });

  it("smooth_exit_upsell payment sets upsells_paid and does NOT touch the closing fee", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    // Seed an enrollment shaped like POST /deals/[id]/smoothexit persists it
    // (catalog key + the server-computed total for it).
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          selected_upsells: ["staging_consult"],
          upsell_total_cents: 24700,
          upsells_paid: false,
          enrolled_at: new Date().toISOString(),
        },
      },
    });

    setSessionCompleted({
      id: "cs_upsell_1",
      payment_status: "paid",
      metadata: { deal_id: deal.id, type: "smooth_exit_upsell" },
    });
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<
      {
        status: string;
        upsells_paid: boolean;
        session_id: string | null;
        paid_at: string | null;
      }[]
    >`
      SELECT smooth_exit->>'status'                        AS status,
             (smooth_exit->>'upsells_paid')::boolean       AS upsells_paid,
             smooth_exit->>'upsells_checkout_session_id'   AS session_id,
             smooth_exit->>'upsells_paid_at'               AS paid_at
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsells_paid).toBe(true);
    expect(rows[0].session_id).toBe("cs_upsell_1");
    expect(rows[0].paid_at).toBeTruthy();
    // Sibling enrollment fields survive the merge.
    expect(rows[0].status).toBe("active");

    // The closing fee must be untouched by an upsell payment.
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("unpaid");
    expect(row?.fee_checkout_session_id).toBeNull();
    expect(row?.fee_paid_at).toBeNull();
  });

  it("fast_pass payment sets fast_pass.paid and touches neither the closing fee nor smooth_exit", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    // Seed an enrollment shaped like POST /deals/[id]/fastpass persists it
    // (server-computed total for base + the selected upsell), plus an unrelated
    // smooth_exit row to prove the fast_pass branch leaves it alone.
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "active",
          payment_option: "now",
          selected_upsells: ["staging_consult"],
          total_cents: 322400,
          paid: false,
          enrolled_at: new Date().toISOString(),
        },
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          selected_upsells: [],
          upsell_total_cents: 0,
          upsells_paid: false,
          enrolled_at: new Date().toISOString(),
        },
      },
    });

    setSessionCompleted({
      id: "cs_fastpass_paid_1",
      payment_status: "paid",
      metadata: { deal_id: deal.id, type: "fast_pass" },
    });
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<
      {
        status: string;
        paid: boolean;
        session_id: string | null;
        paid_at: string | null;
        se_paid: boolean;
      }[]
    >`
      SELECT fast_pass->>'status'                       AS status,
             (fast_pass->>'paid')::boolean              AS paid,
             fast_pass->>'checkout_session_id'          AS session_id,
             fast_pass->>'paid_at'                      AS paid_at,
             (smooth_exit->>'upsells_paid')::boolean    AS se_paid
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].paid).toBe(true);
    expect(rows[0].session_id).toBe("cs_fastpass_paid_1");
    expect(rows[0].paid_at).toBeTruthy();
    // Sibling enrollment fields survive the merge.
    expect(rows[0].status).toBe("active");
    // smooth_exit must NOT be touched by a fast_pass payment.
    expect(rows[0].se_paid).toBe(false);

    // The closing fee must be untouched too.
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("unpaid");
    expect(row?.fee_checkout_session_id).toBeNull();
    expect(row?.fee_paid_at).toBeNull();
  });

  /**
   * #440 — the webhook used to flip `paid` and leave `status` alone. Harmless
   * while nothing produced `pending_payment`, but FF16 (#439) makes that the
   * NORMAL post-survey state, so a buyer who pays would have landed as
   * `paid: true, status: 'pending_payment'` — an enrollment that is paid for
   * but still renders "payment needed" on their dashboard and still counts as
   * awaiting payment in the admin queue.
   */
  it("a fast_pass payment promotes a pending_payment enrollment to active (#440)", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "pending_payment",
          payment_option: "now",
          selected_upsells: ["staging_consult"],
          total_cents: 188700,
          paid: false,
          enrolled_at: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    setSessionCompleted({
      id: "cs_fastpass_pending_1",
      payment_status: "paid",
      metadata: { deal_id: deal.id, type: "fast_pass" },
    });
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const rows = await prisma.$queryRaw<
      {
        status: string;
        paid: boolean;
        session_id: string | null;
        option: string | null;
        total_cents: string | null;
      }[]
    >`
      SELECT fast_pass->>'status'              AS status,
             (fast_pass->>'paid')::boolean     AS paid,
             fast_pass->>'checkout_session_id' AS session_id,
             fast_pass->>'payment_option'      AS option,
             fast_pass->>'total_cents'         AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].paid).toBe(true);
    // The bit that was missing: paid AND active, not paid-but-pending.
    expect(rows[0].status).toBe("active");
    expect(rows[0].session_id).toBe("cs_fastpass_pending_1");
    // Everything else about the enrollment is preserved.
    expect(rows[0].option).toBe("now");
    expect(rows[0].total_cents).toBe("188700");
  });

  it("a fast_pass payment does not downgrade a 'collected' enrollment to active (#440)", async () => {
    // Only `pending_payment` is promoted — a later lifecycle status stands.
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "collected",
          payment_option: "at_closing",
          selected_upsells: [],
          total_cents: 205505,
          paid: false,
          enrolled_at: "2026-08-01T00:00:00.000Z",
        },
      },
    });

    setSessionCompleted({
      id: "cs_fastpass_collected_1",
      payment_status: "paid",
      metadata: { deal_id: deal.id, type: "fast_pass" },
    });
    expect((await stripeWebhook(webhookReq())).status).toBe(200);

    const rows = await prisma.$queryRaw<{ status: string; paid: boolean }[]>`
      SELECT fast_pass->>'status'          AS status,
             (fast_pass->>'paid')::boolean AS paid
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].paid).toBe(true);
    expect(rows[0].status).toBe("collected");
  });

  it("payment_status !== 'paid' changes nothing", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    setSessionCompleted({
      id: "cs_async_1",
      payment_status: "unpaid",
      metadata: { deal_id: deal.id, type: "closing_fee" },
    });
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("unpaid");
    expect(row?.fee_checkout_session_id).toBeNull();
    expect(row?.fee_paid_at).toBeNull();
  });

  it("unknown or missing session type is a no-op", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    setSessionCompleted({
      id: "cs_untyped_1",
      payment_status: "paid",
      metadata: { deal_id: deal.id },
    });
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("unpaid");
    expect(row?.fee_paid_at).toBeNull();
    expect(row?.smooth_exit).toBeNull();
  });

  it("invalid signature returns 400", async () => {
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: {
        constructEvent: () => {
          throw new Error("bad signature");
        },
      },
    });
    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "bad" },
      body: "{}",
    });
    const res = await stripeWebhook(req);
    expect(res.status).toBe(400);
  });

  it("does NOT mark waived deals as paid", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "waived" },
    });
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      webhooks: {
        constructEvent: () =>
          ({
            type: "checkout.session.completed",
            data: {
              object: {
                id: "cs_x",
                payment_status: "paid",
                // type must be closing_fee so this exercises the waived
                // guard, not the unknown-type no-op.
                metadata: { deal_id: deal.id, type: "closing_fee" },
              } as unknown as Stripe.Checkout.Session,
            },
          }) as unknown as Stripe.Event,
      },
    });
    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "ok" },
      body: "{}",
    });
    await stripeWebhook(req);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("waived");
  });

  it("DB failure during a closing_fee update → 5xx so Stripe redelivers", async () => {
    // Injection: metadata.deal_id is a malformed uuid, so markFeePaid's
    // WHERE id = ... comparison throws in Postgres (22P02 invalid input
    // syntax for type uuid) — landing in the same catch block a transient
    // DB outage would. Swallowing it with a 200 would eat the payment:
    // money taken in Stripe, fee never marked paid, no redelivery.
    setSessionCompleted({
      id: "cs_dbfail_1",
      payment_status: "paid",
      metadata: { deal_id: "not-a-uuid", type: "closing_fee" },
    });
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});

const ARIVE_WEBHOOK_TOKEN = "test-arive-webhook-secret";

describe("ARIVE link + sync + webhook", () => {
  // The webhook is fail-closed: it requires ARIVE_WEBHOOK_SECRET and a matching
  // token (#270). Set the secret for the whole block so the happy-path webhook
  // test still exercises the sync; the auth block below flips it as needed.
  beforeAll(() => {
    process.env.ARIVE_WEBHOOK_SECRET = ARIVE_WEBHOOK_TOKEN;
    resetEnvForTesting();
  });
  afterAll(() => {
    delete process.env.ARIVE_WEBHOOK_SECRET;
    resetEnvForTesting();
  });

  function fakeAriveClient(enabled = true): AriveClient {
    return {
      enabled: () => enabled,
      fetchLoan: async (loanId: string) => ({
        loanId,
        status: "active",
        milestones: { contract: true },
        keyDates: { closing: "2026-06-15" },
      }),
    };
  }

  // Fake client that records whether fetchLoan ran — lets the auth tests assert
  // no sync happened when the caller is rejected before the gate.
  function spyAriveClient(): { client: AriveClient; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      client: {
        enabled: () => true,
        fetchLoan: async (loanId: string) => {
          calls.push(loanId);
          return {
            loanId,
            status: "active",
            milestones: { contract: true },
            keyDates: { closing: "2026-06-15" },
          };
        },
      },
    };
  }

  it("PATCH /deals/[id]/arive links and stores loan ID", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    setAriveForTesting(fakeAriveClient());

    const req = new Request(`http://localhost/api/deals/${deal.id}/arive`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|a", ["agent"]),
      },
      body: JSON.stringify({ arive_loan_id: "loan-abc-123" }),
    });
    const res = await linkAriveRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.arive_loan_id).toBe("loan-abc-123");
    expect(row?.arive_linked).toBe(true);
  });

  it("POST /deals/[id]/arive/sync writes back loan data", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { arive_loan_id: "loan-xyz", arive_linked: true },
    });
    setAriveForTesting(fakeAriveClient());

    const req = new Request(`http://localhost/api/deals/${deal.id}/arive/sync`, {
      method: "POST",
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await syncAriveRoute(req, ctx(deal.id));
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.arive_loan_status).toBe("active");
    expect(row?.arive_milestones).toEqual({ contract: true });
    expect(row?.arive_key_dates).toEqual({ closing: "2026-06-15" });
    expect(row?.arive_synced_at).not.toBeNull();
  });

  it("sync surfaces a 5xx and writes nothing when fetchLoan throws", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { arive_loan_id: "loan-boom", arive_linked: true },
    });
    // A non-2xx ARIVE response makes the real client throw; assert the route
    // surfaces a 5xx and never writes a phantom "unknown" status.
    setAriveForTesting({
      enabled: () => true,
      fetchLoan: async () => {
        throw new Error("arive get loan loan-boom: status 500");
      },
    });
    const req = new Request(`http://localhost/api/deals/${deal.id}/arive/sync`, {
      method: "POST",
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await syncAriveRoute(req, ctx(deal.id));
    expect(res.status).toBeGreaterThanOrEqual(500);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.arive_loan_status).toBeNull();
    expect(row?.arive_synced_at).toBeNull();
  });

  it("sync returns 400 when deal not linked", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    setAriveForTesting(fakeAriveClient());
    const req = new Request(`http://localhost/api/deals/${deal.id}/arive/sync`, {
      method: "POST",
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await syncAriveRoute(req, ctx(deal.id));
    expect(res.status).toBe(400);
  });

  it("sync returns 503 when client disabled (no config)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { arive_loan_id: "loan-z", arive_linked: true },
    });
    setAriveForTesting(fakeAriveClient(false));
    const req = new Request(`http://localhost/api/deals/${deal.id}/arive/sync`, {
      method: "POST",
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await syncAriveRoute(req, ctx(deal.id));
    expect(res.status).toBe(503);
  });

  it("webhook 200s and has synced the deal by the time it responds", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { arive_loan_id: "loan-hook", arive_linked: true },
    });
    setAriveForTesting(fakeAriveClient());
    const req = new Request("http://localhost/api/arive/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-arive-token": ARIVE_WEBHOOK_TOKEN,
      },
      body: JSON.stringify({ loanId: "loan-hook" }),
    });
    const res = await ariveWebhook(req);
    expect(res.status).toBe(200);

    // T15 (#83): the sync is awaited before the ack — the deal row must be
    // updated by the time the response resolves (no waitFor, no polling).
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.arive_loan_status).toBe("active");
    expect(row?.arive_milestones).toEqual({ contract: true });
    expect(row?.arive_key_dates).toEqual({ closing: "2026-06-15" });
    expect(row?.arive_synced_at).not.toBeNull();
  });

  // #270 — the webhook was the only one in the app with zero auth. It must
  // authenticate a shared secret (x-arive-token header or ?token= query) and
  // fail closed (503) when the secret is unconfigured.
  describe("ARIVE webhook auth", () => {
    it("401 with no/wrong token, and does NOT sync (fetchLoan not called)", async () => {
      const agent = await createUser({ role: "agent" });
      const deal = await createDeal({ agent_id: agent.id });
      await prisma.deals.update({
        where: { id: deal.id },
        data: { arive_loan_id: "loan-noauth", arive_linked: true },
      });
      const spy = spyAriveClient();
      setAriveForTesting(spy.client);

      // No token at all.
      const noToken = await ariveWebhook(
        new Request("http://localhost/api/arive/webhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ loanId: "loan-noauth" }),
        })
      );
      expect(noToken.status).toBe(401);

      // Wrong token.
      const wrongToken = await ariveWebhook(
        new Request("http://localhost/api/arive/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-arive-token": "nope",
          },
          body: JSON.stringify({ loanId: "loan-noauth" }),
        })
      );
      expect(wrongToken.status).toBe(401);

      // The gate ran before any sync — ARIVE was never queried and nothing
      // was written.
      expect(spy.calls).toEqual([]);
      const row = await prisma.deals.findUnique({ where: { id: deal.id } });
      expect(row?.arive_loan_status).toBeNull();
      expect(row?.arive_synced_at).toBeNull();
    });

    it("200 with the correct token in the query string → syncs as before", async () => {
      const agent = await createUser({ role: "agent" });
      const deal = await createDeal({ agent_id: agent.id });
      await prisma.deals.update({
        where: { id: deal.id },
        data: { arive_loan_id: "loan-ok", arive_linked: true },
      });
      setAriveForTesting(fakeAriveClient());

      const res = await ariveWebhook(
        new Request(
          `http://localhost/api/arive/webhook?token=${ARIVE_WEBHOOK_TOKEN}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ loanId: "loan-ok" }),
          }
        )
      );
      expect(res.status).toBe(200);
      const row = await prisma.deals.findUnique({ where: { id: deal.id } });
      expect(row?.arive_loan_status).toBe("active");
      expect(row?.arive_synced_at).not.toBeNull();
    });

    it("503 when ARIVE_WEBHOOK_SECRET is unset — fail closed, no sync", async () => {
      const agent = await createUser({ role: "agent" });
      const deal = await createDeal({ agent_id: agent.id });
      await prisma.deals.update({
        where: { id: deal.id },
        data: { arive_loan_id: "loan-unset", arive_linked: true },
      });
      const spy = spyAriveClient();
      setAriveForTesting(spy.client);

      process.env.ARIVE_WEBHOOK_SECRET = "";
      resetEnvForTesting();
      try {
        const res = await ariveWebhook(
          new Request("http://localhost/api/arive/webhook", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Even with a token, an unset secret disables the endpoint.
              "x-arive-token": "anything",
            },
            body: JSON.stringify({ loanId: "loan-unset" }),
          })
        );
        expect(res.status).toBe(503);
      } finally {
        process.env.ARIVE_WEBHOOK_SECRET = ARIVE_WEBHOOK_TOKEN;
        resetEnvForTesting();
      }

      expect(spy.calls).toEqual([]);
      const row = await prisma.deals.findUnique({ where: { id: deal.id } });
      expect(row?.arive_loan_status).toBeNull();
      expect(row?.arive_synced_at).toBeNull();
    });
  });
});

// #364 (umbrella #283): refund / dispute / failed-payment handling for the
// closing fee. Charges and disputes don't carry the checkout metadata, so the
// handler resolves the deal by retrieving the PaymentIntent (which we stamp with
// deal_id/type at checkout). Fee only — fast_pass / smooth_exit are sibling slices.
describe("POST /api/stripe/webhook — fee refund / dispute / failed payment (#364)", () => {
  function webhookReq() {
    return new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=fake,v1=fake" },
      body: "{}",
    });
  }

  // Injects an event plus a paymentIntents.retrieve stub so the handler can read
  // deal_id/type off the PaymentIntent referenced by a charge/dispute.
  function setEvent(
    event: Record<string, unknown>,
    piMetadata?: Record<string, string> | null
  ) {
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      paymentIntents: {
        retrieve: async (id: string) =>
          ({ id, metadata: piMetadata ?? {} }) as unknown as Stripe.PaymentIntent,
      },
      webhooks: {
        constructEvent: () => event as unknown as Stripe.Event,
      },
    });
  }

  async function paidFeeDeal() {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fee_status: "paid",
        fee_checkout_session_id: "cs_paid",
        fee_paid_at: new Date(),
      },
    });
    return deal;
  }

  it("charge.refunded (full) on a paid fee → fee_status 'refunded'", async () => {
    const deal = await paidFeeDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_1",
            payment_intent: "pi_1",
            amount: 7500,
            amount_refunded: 7500,
          },
        },
      },
      { deal_id: deal.id, type: "closing_fee" }
    );
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("refunded");
  });

  it("charge.dispute.created on a paid fee → fee_status 'refunded'", async () => {
    const deal = await paidFeeDeal();
    setEvent(
      {
        type: "charge.dispute.created",
        data: { object: { id: "dp_1", payment_intent: "pi_1" } },
      },
      { deal_id: deal.id, type: "closing_fee" }
    );
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    const row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("refunded");
  });

  it("payment_intent.payment_failed reverts a 'pending' fee to 'unpaid', leaves 'paid' alone", async () => {
    const agent = await createUser({ role: "agent" });
    const pending = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: pending.id },
      data: { fee_status: "pending" },
    });
    setEvent({
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: "pi_2",
          metadata: { deal_id: pending.id, type: "closing_fee" },
        },
      },
    });
    let res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    let row = await prisma.deals.findUnique({ where: { id: pending.id } });
    expect(row?.fee_status).toBe("unpaid");

    const paid = await paidFeeDeal();
    setEvent({
      type: "payment_intent.payment_failed",
      data: {
        object: { id: "pi_3", metadata: { deal_id: paid.id, type: "closing_fee" } },
      },
    });
    res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    row = await prisma.deals.findUnique({ where: { id: paid.id } });
    expect(row?.fee_status).toBe("paid");
  });

  it("a PARTIAL refund leaves the fee 'paid'; a non-fee (fast_pass) refund leaves the fee alone", async () => {
    const partial = await paidFeeDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_2",
            payment_intent: "pi_4",
            amount: 7500,
            amount_refunded: 5000,
          },
        },
      },
      { deal_id: partial.id, type: "closing_fee" }
    );
    let res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    let row = await prisma.deals.findUnique({ where: { id: partial.id } });
    expect(row?.fee_status).toBe("paid");

    const nonFee = await paidFeeDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_3",
            payment_intent: "pi_5",
            amount: 322400,
            amount_refunded: 322400,
          },
        },
      },
      { deal_id: nonFee.id, type: "fast_pass" }
    );
    res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    row = await prisma.deals.findUnique({ where: { id: nonFee.id } });
    expect(row?.fee_status).toBe("paid");
  });
});

// #365 / #366: reflect a refund/dispute on the Fast Pass enrollment (fast_pass
// JSONB) and the Smooth Exit upsell (smooth_exit JSONB). Same shape as the fee
// (#364): a Charge/Dispute carries only a payment_intent id, so the handler
// retrieves the PI metadata (deal_id/type stamped at checkout) to route the
// refund. Both flips MERGE keys into the JSONB (jsonb_set) — sibling enrollment
// fields must survive (#260 clobber guard). Partial refunds are skipped for all
// surfaces, consistent with the fee.
describe("POST /api/stripe/webhook — fast_pass / smooth_exit refund / dispute (#365/#366)", () => {
  function webhookReq() {
    return new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=fake,v1=fake" },
      body: "{}",
    });
  }

  // Injects an event plus a paymentIntents.retrieve stub so the handler can read
  // deal_id/type off the PaymentIntent referenced by a charge/dispute.
  function setEvent(
    event: Record<string, unknown>,
    piMetadata?: Record<string, string> | null
  ) {
    setStripeForTesting({
      checkout: { sessions: { create: async () => ({ id: "x", url: null }) } },
      paymentIntents: {
        retrieve: async (id: string) =>
          ({ id, metadata: piMetadata ?? {} }) as unknown as Stripe.PaymentIntent,
      },
      webhooks: {
        constructEvent: () => event as unknown as Stripe.Event,
      },
    });
  }

  // Seeds a deal with a fully-paid Fast Pass enrollment, shaped like
  // POST /deals/[id]/fastpass persists it, plus the webhook-stamped paid fields.
  async function paidFastPassDeal() {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fast_pass: {
          status: "active",
          payment_option: "now",
          selected_upsells: ["staging_consult"],
          total_cents: 322400,
          paid: true,
          checkout_session_id: "cs_fp_paid",
          enrolled_at: new Date().toISOString(),
          paid_at: new Date().toISOString(),
        },
      },
    });
    return deal;
  }

  // Seeds a deal with a fully-paid Smooth Exit upsell enrollment.
  async function paidSmoothExitDeal() {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          selected_upsells: ["staging_consult"],
          upsell_total_cents: 24700,
          upsells_paid: true,
          upsells_checkout_session_id: "cs_se_paid",
          enrolled_at: new Date().toISOString(),
          upsells_paid_at: new Date().toISOString(),
        },
      },
    });
    return deal;
  }

  // Case 1 (#365): a full charge.refunded on a paid fast_pass flips paid=false /
  // refunded=true and preserves sibling enrollment fields.
  it("charge.refunded (full) on a paid fast_pass → paid=false, refunded=true; siblings survive", async () => {
    const deal = await paidFastPassDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_fp_1",
            payment_intent: "pi_fp_1",
            amount: 322400,
            amount_refunded: 322400,
          },
        },
      },
      { deal_id: deal.id, type: "fast_pass" }
    );
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<
      {
        status: string;
        paid: boolean;
        refunded: boolean;
        selected: unknown;
        total_cents: number;
      }[]
    >`
      SELECT fast_pass->>'status'                    AS status,
             (fast_pass->>'paid')::boolean           AS paid,
             (fast_pass->>'refunded')::boolean       AS refunded,
             fast_pass->'selected_upsells'           AS selected,
             (fast_pass->>'total_cents')::int        AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].paid).toBe(false);
    expect(rows[0].refunded).toBe(true);
    // Sibling enrollment fields survive the merge (no clobber).
    expect(rows[0].status).toBe("active");
    expect(rows[0].selected).toEqual(["staging_consult"]);
    expect(rows[0].total_cents).toBe(322400);
  });

  // Case 2 (#365): a dispute on a paid fast_pass triggers the same reversal.
  it("charge.dispute.created on a paid fast_pass → paid=false, refunded=true", async () => {
    const deal = await paidFastPassDeal();
    setEvent(
      {
        type: "charge.dispute.created",
        data: { object: { id: "dp_fp_1", payment_intent: "pi_fp_2" } },
      },
      { deal_id: deal.id, type: "fast_pass" }
    );
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<
      { paid: boolean; refunded: boolean }[]
    >`
      SELECT (fast_pass->>'paid')::boolean     AS paid,
             (fast_pass->>'refunded')::boolean AS refunded
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].paid).toBe(false);
    expect(rows[0].refunded).toBe(true);
  });

  // Case 3 (#366): a full charge.refunded on a paid smooth_exit upsell flips
  // upsells_paid=false / upsells_refunded=true and preserves siblings (#260).
  it("charge.refunded (full) on a paid smooth_exit upsell → upsells_paid=false, upsells_refunded=true; siblings survive", async () => {
    const deal = await paidSmoothExitDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_se_1",
            payment_intent: "pi_se_1",
            amount: 24700,
            amount_refunded: 24700,
          },
        },
      },
      { deal_id: deal.id, type: "smooth_exit_upsell" }
    );
    const res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);

    const rows = await prisma.$queryRaw<
      {
        status: string;
        upsells_paid: boolean;
        upsells_refunded: boolean;
        selected: unknown;
        total_cents: number;
      }[]
    >`
      SELECT smooth_exit->>'status'                        AS status,
             (smooth_exit->>'upsells_paid')::boolean       AS upsells_paid,
             (smooth_exit->>'upsells_refunded')::boolean   AS upsells_refunded,
             smooth_exit->'selected_upsells'               AS selected,
             (smooth_exit->>'upsell_total_cents')::int     AS total_cents
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].upsells_paid).toBe(false);
    expect(rows[0].upsells_refunded).toBe(true);
    // Sibling enrollment fields survive the merge (#260 clobber guard).
    expect(rows[0].status).toBe("active");
    expect(rows[0].selected).toEqual(["staging_consult"]);
    expect(rows[0].total_cents).toBe(24700);
  });

  // Case 4: cross-surface isolation + partial-refund skip.
  it("a fast_pass refund touches neither smooth_exit nor the fee, and vice-versa; a partial fast_pass refund is a no-op", async () => {
    // Deal carrying paid fast_pass + paid smooth_exit + paid fee at once.
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: {
        fee_status: "paid",
        fee_checkout_session_id: "cs_fee_paid",
        fee_paid_at: new Date(),
        fast_pass: {
          status: "active",
          selected_upsells: ["staging_consult"],
          total_cents: 322400,
          paid: true,
        },
        smooth_exit: {
          status: "active",
          selected_upsells: ["staging_consult"],
          upsell_total_cents: 24700,
          upsells_paid: true,
        },
      },
    });

    // A fast_pass refund flips ONLY fast_pass.
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_iso_fp",
            payment_intent: "pi_iso_fp",
            amount: 322400,
            amount_refunded: 322400,
          },
        },
      },
      { deal_id: deal.id, type: "fast_pass" }
    );
    let res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    let rows = await prisma.$queryRaw<
      { fp_paid: boolean; se_paid: boolean }[]
    >`
      SELECT (fast_pass->>'paid')::boolean          AS fp_paid,
             (smooth_exit->>'upsells_paid')::boolean AS se_paid
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].fp_paid).toBe(false);
    expect(rows[0].se_paid).toBe(true); // smooth_exit untouched
    let row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("paid"); // fee untouched

    // A smooth_exit refund flips ONLY smooth_exit (fast_pass already refunded,
    // fee still paid).
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_iso_se",
            payment_intent: "pi_iso_se",
            amount: 24700,
            amount_refunded: 24700,
          },
        },
      },
      { deal_id: deal.id, type: "smooth_exit_upsell" }
    );
    res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    rows = await prisma.$queryRaw<
      { fp_paid: boolean; se_paid: boolean }[]
    >`
      SELECT (fast_pass->>'paid')::boolean          AS fp_paid,
             (smooth_exit->>'upsells_paid')::boolean AS se_paid
      FROM deals WHERE id = ${deal.id}::uuid
    `;
    expect(rows[0].se_paid).toBe(false);
    row = await prisma.deals.findUnique({ where: { id: deal.id } });
    expect(row?.fee_status).toBe("paid"); // fee still untouched

    // A PARTIAL fast_pass refund leaves a paid fast_pass paid.
    const partial = await paidFastPassDeal();
    setEvent(
      {
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_fp_partial",
            payment_intent: "pi_fp_partial",
            amount: 322400,
            amount_refunded: 100000,
          },
        },
      },
      { deal_id: partial.id, type: "fast_pass" }
    );
    res = await stripeWebhook(webhookReq());
    expect(res.status).toBe(200);
    rows = await prisma.$queryRaw<{ fp_paid: boolean; se_paid: boolean }[]>`
      SELECT (fast_pass->>'paid')::boolean          AS fp_paid,
             (fast_pass->>'paid')::boolean          AS se_paid
      FROM deals WHERE id = ${partial.id}::uuid
    `;
    expect(rows[0].fp_paid).toBe(true);
  });
});
