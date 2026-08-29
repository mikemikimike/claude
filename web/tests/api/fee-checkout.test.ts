/**
 * POST /api/deals/[id]/fee/checkout — pending-session double-charge guard (#282).
 *
 * The route sets fee_status='pending' and stores fee_checkout_session_id right
 * after minting a Stripe Checkout session. Calling it again while that session
 * is still live (second tab, re-click, retry) must NOT mint a second payable
 * session — both would be independently chargeable, so the agent could be
 * charged the $75 closing fee twice. A still-`open` session is reused; only a
 * genuinely `expired` session is replaced with a fresh one.
 *
 * Stripe is fully stubbed via setStripeForTesting — no real Stripe calls. The
 * fake exposes checkout.sessions.retrieve (the seam added for this fix).
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { POST as checkoutRoute } from "@/app/api/deals/[id]/fee/checkout/route";
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

afterEach(() => setStripeForTesting(undefined));
afterAll(() => setStripeForTesting(undefined));

beforeEach(async () => {
  await truncateAll();
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function checkout(dealId: string, sub: string, roles: string[]) {
  return checkoutRoute(
    new Request(`http://localhost/api/deals/${dealId}/fee/checkout`, {
      method: "POST",
      headers: { authorization: await authHeader(sub, roles) },
    }),
    ctx(dealId)
  );
}

async function feeRow(dealId: string) {
  return prisma.deals.findUnique({
    where: { id: dealId },
    select: { fee_status: true, fee_checkout_session_id: true },
  });
}

type SessionStatus = "open" | "complete" | "expired";

/**
 * Fake Stripe. `create()` mints a fresh open session each call (cs_new_N) and
 * remembers it; `retrieve(id)` reports the remembered status and a live url for
 * open sessions only (expired/complete sessions have no payable url, matching
 * real Stripe). Seed pre-existing sessions with `seed` to model a session that
 * was minted before the test ran.
 */
function fakeStripe(seed: Record<string, SessionStatus> = {}) {
  const createCalls: Stripe.Checkout.SessionCreateParams[] = [];
  const retrieveCalls: string[] = [];
  const status: Record<string, SessionStatus> = { ...seed };
  let n = 0;

  setStripeForTesting({
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          createCalls.push(params);
          n += 1;
          const id = `cs_new_${n}`;
          status[id] = "open";
          return { id, url: `https://stripe.test/checkout/${id}` };
        },
        retrieve: async (id: string) => {
          retrieveCalls.push(id);
          const s = status[id] ?? "expired";
          return {
            id,
            url: s === "open" ? `https://stripe.test/checkout/${id}` : null,
            status: s,
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

  return { createCalls, retrieveCalls };
}

describe("POST /api/deals/[id]/fee/checkout — double-charge guard (#282)", () => {
  it("case 1: a second call while the session is still open reuses it — only ONE Stripe session minted", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "123 Main St" });
    const stripe = fakeStripe();

    // First call mints session A, flips fee_status → pending.
    const first = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { checkout_url: string }).checkout_url).toBe(
      "https://stripe.test/checkout/cs_new_1"
    );
    const afterFirst = await feeRow(deal.id);
    expect(afterFirst?.fee_status).toBe("pending");
    expect(afterFirst?.fee_checkout_session_id).toBe("cs_new_1");

    // Second call — no completion in between. Session A is still open, so the
    // route must reuse it, not mint session B.
    const second = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { checkout_url: string }).checkout_url).toBe(
      "https://stripe.test/checkout/cs_new_1"
    );

    // The core assertion: exactly ONE Stripe session was ever created.
    expect(stripe.createCalls.length).toBe(1);

    // Stored session id unchanged (not overwritten with a second session).
    expect((await feeRow(deal.id))?.fee_checkout_session_id).toBe("cs_new_1");
  });

  it("case 2: an expired pending session is replaced — a fresh session is minted and retryable", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    // A prior attempt left a pending session that has since expired in Stripe.
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "pending", fee_checkout_session_id: "cs_old_expired" },
    });
    const stripe = fakeStripe({ cs_old_expired: "expired" });

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(200);
    // A brand-new session (cs_new_1), not the expired one.
    expect(((await res.json()) as { checkout_url: string }).checkout_url).toBe(
      "https://stripe.test/checkout/cs_new_1"
    );
    expect(stripe.createCalls.length).toBe(1);

    const row = await feeRow(deal.id);
    expect(row?.fee_status).toBe("pending");
    expect(row?.fee_checkout_session_id).toBe("cs_new_1");
  });

  it("case 3: an already-paid fee still 409s and never touches Stripe", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "paid", fee_checkout_session_id: "cs_paid" },
    });
    const stripe = fakeStripe({ cs_paid: "complete" });

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(409);
    expect(stripe.createCalls.length).toBe(0);
    expect(stripe.retrieveCalls.length).toBe(0);
  });

  it("case 3b: a waived fee still 409s and never touches Stripe", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "waived" },
    });
    const stripe = fakeStripe();

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(409);
    expect(stripe.createCalls.length).toBe(0);
  });

  it("a pending session that already completed (webhook not yet in) never mints a second session", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { fee_status: "pending", fee_checkout_session_id: "cs_completing" },
    });
    const stripe = fakeStripe({ cs_completing: "complete" });

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    // Must not mint — a completed session is a real charge in flight; a fresh
    // session here is exactly the double-charge this guard prevents.
    expect(stripe.createCalls.length).toBe(0);
    expect(res.status).toBe(409);
    // Session id preserved, not overwritten.
    expect((await feeRow(deal.id))?.fee_checkout_session_id).toBe("cs_completing");
  });

  it("first checkout on an unpaid deal mints a session and stores it (happy path)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, title: "456 Oak Ave" });
    const stripe = fakeStripe();

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(200);
    expect(stripe.createCalls.length).toBe(1);
    // The closing-fee metadata is preserved on the minted session.
    expect(stripe.createCalls[0].metadata).toMatchObject({
      deal_id: deal.id,
      type: "closing_fee",
    });
    const row = await feeRow(deal.id);
    expect(row?.fee_status).toBe("pending");
    expect(row?.fee_checkout_session_id).toBe("cs_new_1");
  });

  it("403 when a non-owner agent calls checkout — no Stripe call", async () => {
    const owner = await createUser({ role: "agent", auth0_id: "auth0|owner" });
    await createUser({ role: "agent", auth0_id: "auth0|intruder" });
    const deal = await createDeal({ agent_id: owner.id });
    const stripe = fakeStripe();

    const res = await checkout(deal.id, "auth0|intruder", ["agent"]);
    expect(res.status).toBe(403);
    expect(stripe.createCalls.length).toBe(0);
  });

  it("404 for a nonexistent deal — no Stripe call", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|a" });
    const stripe = fakeStripe();

    const res = await checkout(randomUUID(), "auth0|a", ["agent"]);
    expect(res.status).toBe(404);
    expect(stripe.createCalls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #413 — the $75 closing-fee Checkout is prefilled with the PAYING USER's
// account email, read server-side from `users.email`. This route is agent-only
// (a non-owner 403s before Stripe is reached), so the payer is always the
// owning agent — but the email still comes from the DB, never the request.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/deals/[id]/fee/checkout — customer_email prefill (#413)", () => {
  it("prefills customer_email from the owning agent's users.email", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|a",
      email: "agnes@agent.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "1 Prefill Pl" });
    const stripe = fakeStripe();

    const res = await checkout(deal.id, "auth0|a", ["agent"]);
    expect(res.status).toBe(200);
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0].customer_email).toBe("agnes@agent.test");
    // The metadata the refund/dispute webhooks resolve the deal from is intact.
    expect(stripe.createCalls[0].metadata).toMatchObject({
      deal_id: deal.id,
      type: "closing_fee",
    });
  });

  it("a body carrying a different email is ignored — this route reads no body at all", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|a",
      email: "real@agent.test",
    });
    const deal = await createDeal({ agent_id: agent.id, title: "2 Spoof St" });
    const stripe = fakeStripe();

    const res = await checkoutRoute(
      new Request(`http://localhost/api/deals/${deal.id}/fee/checkout`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({
          customer_email: "attacker@evil.test",
          email: "attacker@evil.test",
        }),
      }),
      ctx(deal.id)
    );
    expect(res.status).toBe(200);
    expect(stripe.createCalls).toHaveLength(1);
    expect(stripe.createCalls[0].customer_email).toBe("real@agent.test");
    expect(stripe.createCalls[0].customer_email).not.toBe("attacker@evil.test");
  });
});
