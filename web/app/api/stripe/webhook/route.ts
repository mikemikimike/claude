import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { error } from "@/lib/http";
import { constructEvent, retrievePaymentIntentMetadata } from "@/lib/stripe";

export async function POST(req: Request): Promise<Response> {
  const sig = req.headers.get("stripe-signature") ?? "";
  const payload = await req.text();
  let event: Stripe.Event;
  try {
    event = constructEvent(payload, sig);
  } catch (err) {
    console.error("stripe webhook signature error", err);
    return error("invalid signature", 400);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.payment_status !== "paid") {
        return new Response(null, { status: 200 });
      }
      const dealId = session.metadata?.deal_id;
      if (dealId) {
        // The session's metadata.type (set by its creator in lib/stripe.ts)
        // decides which product was bought. Ports the type switch in
        // the legacy Go backend, except unknown/missing types
        // are a logged no-op here instead of defaulting to the closing fee.
        const type = session.metadata?.type;
        if (type === "closing_fee") {
          await markFeePaid(dealId, session.id);
        } else if (type === "smooth_exit_upsell") {
          await markSmoothExitUpsellPaid(dealId, session.id);
        } else if (type === "fast_pass") {
          await markFastPassPaid(dealId, session.id);
        } else {
          console.warn(
            `stripe webhook: unhandled checkout session type ${JSON.stringify(
              type ?? null
            )} for deal ${dealId}`
          );
        }
      }
    } else if (event.type === "payment_intent.succeeded") {
      const pi = event.data.object as Stripe.PaymentIntent;
      const dealId = pi.metadata?.deal_id;
      if (dealId) {
        await markFeePaid(dealId, pi.id);
      }
    } else if (
      event.type === "charge.refunded" ||
      event.type === "charge.dispute.created"
    ) {
      // #364/#365/#366: reverse a refunded/disputed charge. The event object is
      // a Charge or Dispute, which carries only a payment_intent id — not the
      // checkout metadata — so we retrieve the PaymentIntent to read deal_id/type
      // (stamped at checkout via payment_intent_data). The type routes to the fee
      // (#364), the Fast Pass enrollment (#365), or the Smooth Exit upsell (#366).
      const obj = event.data.object as Stripe.Charge | Stripe.Dispute;
      const piRef = (
        obj as { payment_intent?: string | { id: string } | null }
      ).payment_intent;
      const piId = typeof piRef === "string" ? piRef : (piRef?.id ?? null);
      // A partial refund (amount_refunded < amount) is a courtesy credit, not a
      // reversal — leave the fee collected. Full refunds and disputes reverse it.
      const charge = event.data.object as Stripe.Charge;
      const isPartialRefund =
        event.type === "charge.refunded" &&
        (charge.amount_refunded ?? 0) < (charge.amount ?? 0);
      if (piId && !isPartialRefund) {
        const meta = await retrievePaymentIntentMetadata(piId);
        if (meta.deal_id) {
          // Route by the type stamped on the PaymentIntent at checkout. Each
          // branch reverses only its own surface (#364 fee / #365 fast_pass /
          // #366 smooth_exit); the others are left untouched.
          if (meta.type === "closing_fee") {
            await markFeeRefunded(meta.deal_id);
          } else if (meta.type === "fast_pass") {
            await markFastPassRefunded(meta.deal_id);
          } else if (meta.type === "smooth_exit_upsell") {
            await markSmoothExitUpsellRefunded(meta.deal_id);
          }
        }
      }
    } else if (event.type === "payment_intent.payment_failed") {
      // #364: a failed charge on a still-pending fee frees the agent to retry.
      const pi = event.data.object as Stripe.PaymentIntent;
      const dealId = pi.metadata?.deal_id;
      if (dealId && pi.metadata?.type === "closing_fee") {
        await revertPendingFee(dealId);
      }
    }
  } catch (err) {
    console.error("stripe webhook handler error", err);
    // 500 so Stripe redelivers (#81). Retrying is safe: markFeePaid and
    // markSmoothExitUpsellPaid are idempotent status writes — re-running them
    // converges on the same terminal state (fee_status='paid' /
    // upsells_paid=true with the same session id). Returning 200 here would
    // eat the payment on a transient DB failure: money taken in Stripe, fee
    // never marked paid, and no redelivery to recover.
    return error("webhook handler error", 500);
  }

  // Signature-valid but unhandled/ignorable event types fall through to 200.
  return new Response(null, { status: 200 });
}

async function markFeePaid(dealId: string, sessionId: string): Promise<void> {
  await prisma.deals.updateMany({
    where: { id: dealId, fee_status: { not: "waived" } },
    data: {
      fee_status: "paid",
      fee_checkout_session_id: sessionId,
      fee_paid_at: new Date(),
    },
  });
}

// #364: a refunded/disputed fee stops counting as collected revenue. Guarded on
// fee_status='paid' so it's idempotent and can't resurrect a waived/unpaid deal.
async function markFeeRefunded(dealId: string): Promise<void> {
  await prisma.deals.updateMany({
    where: { id: dealId, fee_status: "paid" },
    data: { fee_status: "refunded" },
  });
}

// #364: a failed payment on a still-pending fee reverts it to unpaid so the
// agent can retry. Never touches a paid/refunded/waived fee.
async function revertPendingFee(dealId: string): Promise<void> {
  await prisma.deals.updateMany({
    where: { id: dealId, fee_status: "pending" },
    data: { fee_status: "unpaid" },
  });
}

// Ports markSmoothExitUpsellPaid (the legacy Go backend), plus
// records which session paid and when so the payment is traceable from the
// enrollment JSONB. COALESCE preserves the payment evidence even if the
// enrollment was cleared between checkout and webhook delivery.
async function markSmoothExitUpsellPaid(
  dealId: string,
  sessionId: string
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE deals
    SET smooth_exit = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(smooth_exit, '{}'::jsonb), '{upsells_paid}', 'true'),
        '{upsells_checkout_session_id}', to_jsonb(${sessionId}::text)
      ),
      '{upsells_paid_at}', to_jsonb(NOW()::text)
    )
    WHERE id = ${dealId}::uuid
  `;
}

// Fast Pass enrollment paid (#78). Mirrors markSmoothExitUpsellPaid: flips
// paid=true and records the session id + paid_at on the fast_pass JSONB.
// Touches ONLY fast_pass — fee_status and smooth_exit are left alone. COALESCE
// preserves the payment evidence even if the enrollment was cleared between
// checkout and webhook delivery.
//
// #440: it also PROMOTES a `pending_payment` enrollment to `active`. This flip
// used to be missing, which was harmless only because nothing produced
// `pending_payment` — FF16 (#439) makes it the normal post-survey state, so a
// buyer who paid would have been left `paid: true, status: 'pending_payment'`:
// still showing "payment needed" on their dashboard and still sitting in the
// admin's awaiting-payment queue. The CASE keeps it narrow — a later lifecycle
// status (`active`, `complete`, `collected`) is never rewritten backwards, and
// this stays the same single UPDATE, so it can't half-apply.
async function markFastPassPaid(
  dealId: string,
  sessionId: string
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE deals
    SET fast_pass = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(fast_pass, '{}'::jsonb), '{paid}', 'true'),
        '{checkout_session_id}', to_jsonb(${sessionId}::text)
      ),
      '{paid_at}', to_jsonb(NOW()::text)
    ) || CASE
      WHEN fast_pass->>'status' = 'pending_payment'
        THEN jsonb_build_object('status', 'active')
      ELSE '{}'::jsonb
    END
    WHERE id = ${dealId}::uuid
  `;
}

// #365: a refunded/disputed Fast Pass charge stops counting as paid. Mirrors
// markFeeRefunded's guard: only acts on a currently-paid enrollment
// (idempotent, and won't flip an unpaid/never-enrolled row). MERGES keys with
// jsonb_set — flips paid=false, sets refunded=true + refunded_at, and preserves
// every sibling field (selected_upsells/total_cents/base_price_cents/
// upsell_prices/…): the refund reverses the money, not the record of what the
// client agreed to.
//
// #484: it also writes the enrollment's own terminal state, `status:
// 'refunded'`. Reversing `paid` alone was not enough, because `status` — not
// `paid` — is what the product reads to decide the service is RUNNING (the
// agent dashboard's `=== 'active'` count, the deal-header/pipeline badges, the
// buyer's tracker). A refunded client kept reading as an active Fast Pass
// forever. `refunded` rather than clearing the enrollment: the agent has to be
// able to tell "we refunded this one" from "never enrolled" — the first is a
// conversation, the second is not.
async function markFastPassRefunded(dealId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE deals
    SET fast_pass = jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(COALESCE(fast_pass, '{}'::jsonb), '{refunded}', 'true'),
          '{paid}', 'false'
        ),
        '{status}', '"refunded"'::jsonb
      ),
      '{refunded_at}', to_jsonb(NOW()::text)
    )
    WHERE id = ${dealId}::uuid AND (fast_pass->>'paid')::boolean IS TRUE
  `;
}

// #366: a refunded/disputed Smooth Exit upsell charge stops counting as paid.
// Same shape as markFastPassRefunded, guarded on upsells_paid. MERGES keys with
// jsonb_set (#260 clobber guard) — flips upsells_paid=false, sets
// upsells_refunded=true + upsells_refunded_at, preserving siblings
// (status/selected_upsells/upsell_total_cents/…).
//
// #484: `smooth_exit.status` is deliberately NOT flipped here, and this is the
// one place the two surfaces diverge. A Fast Pass charge IS the enrollment, so
// reversing it ends the enrollment. This charge is only the ADD-ON basket — the
// enrollment's own 1%-of-sale fee comes out of proceeds at closing and was
// never part of this PaymentIntent. Marking the enrollment `refunded` would
// drop a seller who is still receiving (and will still be billed for) Smooth
// Exit off the admin's active list and out of their own portal badge: a worse
// bug than the one #484 fixes. `upsells_refunded` is the terminal state for the
// thing that was actually refunded, and the readers key off it.
async function markSmoothExitUpsellRefunded(dealId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE deals
    SET smooth_exit = jsonb_set(
      jsonb_set(
        jsonb_set(COALESCE(smooth_exit, '{}'::jsonb), '{upsells_refunded}', 'true'),
        '{upsells_paid}', 'false'
      ),
      '{upsells_refunded_at}', to_jsonb(NOW()::text)
    )
    WHERE id = ${dealId}::uuid AND (smooth_exit->>'upsells_paid')::boolean IS TRUE
  `;
}
