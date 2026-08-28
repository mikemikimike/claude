import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { hasDealAccess } from "@/lib/deals";
import { resolveUserId } from "@/lib/users";
import { isFastPassUpsellId, type FastPassUpsellId } from "@/lib/fast-pass-catalog";
import {
  fastPassTotalForPaymentOption,
  isFastPassPaymentOption,
} from "@/lib/fast-pass-payment";
import {
  createFastPassCheckout,
  retrieveCheckoutSession,
  type CheckoutSessionSnapshot,
} from "@/lib/stripe";
import { fastPassPayBodySchema } from "@/lib/schemas/enrollment";
import { parseBody } from "@/lib/schemas/parse";

type Ctx = { params: Promise<{ id: string }> };

// POST /deals/:dealId/fastpass/pay — owning agent or any deal participant.
//
// FF17 (#440): settle a Fast Pass enrollment that ALREADY EXISTS. FF16 (#439)
// took payment out of the onboarding survey, so an enrollment now lands
// `status: 'pending_payment'` with no `payment_option`, and this is where the
// buyer chooses one from their dashboard:
//
//   now               → Stripe Checkout for the agreed total; stays
//                       `pending_payment` until the webhook confirms the money.
//   at_closing        → deferred, +15% on the whole basket once (#280);
//                       activates immediately, still unpaid.
//   seller_concession → deferred at the agreed total; activates immediately.
//
// Deliberately a SEPARATE route from POST /fastpass. Enrolling and paying have
// different failure semantics, and this one must never silently succeed:
//
//   #412 — the enrollment route swallows a Stripe error and returns
//     `{ ok: true }` with no checkout_url, which the caller renders as success
//     for an enrollment nobody paid for. Here a Stripe failure (thrown, or a
//     session with no url) is a 502 and NOTHING is recorded, so the buyer sees
//     a real error and can retry.
//   #413 — Checkout is created with `customer_email` read from the paying
//     user's `users.email`. Server-side only; the body has no such field.
//
// The amount is never taken from the client: it is derived from the stored,
// already-discounted `total_cents` via fastPassTotalForPaymentOption(), which
// defers all premium/discount math to computeFastPassTotalCents() (#280/#281).
// The buyer's card renders from the same helper, so the figure on screen is the
// figure Stripe charges.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const deal = await prisma.deals.findFirst({
      where: { id: dealId },
      select: { agent_id: true, title: true, fast_pass: true },
    });
    if (!deal) return error("deal not found", 404);
    // Same scoping as the enrollment route (#169): the owning agent, or any
    // participant on the deal. Checked BEFORE the body is parsed so a stranger
    // gets a flat 403 and learns nothing about the enrollment.
    const isOwner = deal.agent_id === userId;
    if (!isOwner && !(await hasDealAccess(dealId, userId))) {
      return error("forbidden", 403);
    }

    const parsed = await parseBody(req, fastPassPayBodySchema);
    if (!parsed.ok) return parsed.response;
    const paymentOption = parsed.data.payment_option;
    // Unlike enrollment (where an absent option is the #439 deferred path), an
    // option is REQUIRED here — this route exists to record one.
    if (!isFastPassPaymentOption(paymentOption)) {
      return error(`invalid payment_option: ${paymentOption ?? ""}`, 400);
    }

    const enrollment = deal.fast_pass as Record<string, unknown> | null;
    if (!enrollment) return error("no fast pass enrollment for this deal", 404);
    // Paid is checked separately from status so an already-settled enrollment
    // gets the clearer message, and so a paid-but-oddly-statused row can never
    // be re-charged.
    if (enrollment.paid === true) return error("fast pass is already paid", 409);
    if (enrollment.status !== "pending_payment") {
      return error(
        "fast pass is not awaiting payment (already settled or not enrolled)",
        409
      );
    }

    // Re-validate the stored basket against the catalog rather than trusting
    // the JSONB blob: an unknown key would otherwise silently drop out of the
    // price the buyer is shown but stay on the enrollment.
    const storedUpsells = Array.isArray(enrollment.selected_upsells)
      ? enrollment.selected_upsells
      : [];
    const selectedUpsells: FastPassUpsellId[] = [];
    for (const key of new Set(storedUpsells)) {
      if (typeof key === "string" && isFastPassUpsellId(key)) {
        selectedUpsells.push(key);
      }
    }

    const enrolledTotalCents = Number(enrollment.total_cents);
    if (!Number.isFinite(enrolledTotalCents) || enrolledTotalCents <= 0) {
      return error("fast pass enrollment has no priced total", 409);
    }
    const totalCents = fastPassTotalForPaymentOption(
      enrolledTotalCents,
      selectedUpsells,
      paymentOption
    );

    // ── Never mint a SECOND payable Checkout session (the #282 pattern) ─────
    //
    // Fast Pass is a $1,787+ charge, so two live sessions is a real
    // double-charge path: a buyer with two tabs open can complete both. The
    // closing-fee route already solved this — re-read the stored session's LIVE
    // status with Stripe and only replace it if it has genuinely expired.
    //
    // Reaching here means the enrollment is unpaid and `pending_payment`, so a
    // stored `checkout_session_id` can only have come from an earlier pay-now
    // attempt on this same route.
    //
    // The guard runs BEFORE the branch on payment option, not just on the
    // pay-now path, because a live session is equally wrong under a deferral:
    // recording "pay at closing" while a session that charges the un-premiumed
    // total is still payable leaves the buyer able to pay an amount the record
    // no longer agrees with. Only an expired session lets either path proceed.
    const existingSessionId =
      typeof enrollment.checkout_session_id === "string" && enrollment.checkout_session_id
        ? enrollment.checkout_session_id
        : null;
    let reusableUrl: string | null = null;
    if (existingSessionId) {
      let existing: CheckoutSessionSnapshot;
      try {
        existing = await retrieveCheckoutSession(existingSessionId);
      } catch (err) {
        // Unknown state — the one thing we must not do is mint another.
        console.error("fast pass checkout: could not verify the existing session", {
          dealId,
          sessionId: existingSessionId,
          err,
        });
        return error("a Fast Pass checkout is already in progress; please retry", 409);
      }
      if (existing.status !== "expired") {
        if (paymentOption === "now" && existing.url) {
          // Still open → hand back the SAME session so a re-click or a second
          // tab lands on the one live checkout.
          reusableUrl = existing.url;
        } else {
          // Completed-but-webhook-not-landed, or a deferral attempted over a
          // live session. Either way: change nothing, charge nothing.
          return error("a Fast Pass checkout is already in progress", 409);
        }
      }
      // expired → fall through; a fresh session (or a deferral) is safe now.
    }

    // ── Deferred: at_closing / seller_concession ────────────────────────────
    // No money moves now, so the enrollment activates immediately. The
    // `pending_payment` predicate lives in the UPDATE's WHERE, which is also
    // the double-submit guard: a second click touches 0 rows and 409s instead
    // of re-pricing an enrollment that is already active. (`paid` stays false —
    // the fee still has to arrive at the closing table.)
    if (paymentOption !== "now") {
      const count = await prisma.$executeRaw`
        UPDATE deals
        SET fast_pass = fast_pass || jsonb_build_object(
              'status', 'active',
              'payment_option', ${paymentOption}::text,
              'total_cents', ${totalCents}::int,
              'payment_chosen_at', NOW()::text,
              'payment_chosen_by', ${userId}::text
            ),
            updated_at = NOW()
        WHERE id = ${dealId}::uuid
          AND fast_pass IS NOT NULL
          AND fast_pass->>'status' = 'pending_payment'
          AND COALESCE((fast_pass->>'paid')::boolean, false) = false
      `;
      if (count === 0) {
        return error("fast pass is not awaiting payment (already settled)", 409);
      }
      return json({
        ok: true,
        status: "active",
        payment_option: paymentOption,
        total_cents: totalCents,
      });
    }

    // ── Pay now: Stripe Checkout ────────────────────────────────────────────

    // An earlier attempt's session is still open — send them back to it rather
    // than creating a second payable one. Nothing to re-persist: the stored
    // session id and total are already the ones this URL charges.
    if (reusableUrl) {
      return json({
        ok: true,
        status: "pending_payment",
        payment_option: "now",
        total_cents: totalCents,
        checkout_url: reusableUrl,
      });
    }

    // #413: the prefill is the authenticated payer's own address, looked up
    // here rather than accepted from the request.
    const payer = await prisma.users.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    // Role-aware returns: the owning agent lands back on the deal, a buyer on
    // their own portal — where the card either disappears (webhook confirmed)
    // or is still there to retry (cancelled).
    const successUrl = isOwner
      ? `${origin}/agent/deals/${dealId}?fastpass=paid`
      : `${origin}/buyer/${userId}?fastpass=paid`;
    const cancelUrl = isOwner
      ? `${origin}/agent/deals/${dealId}?fastpass=cancelled`
      : `${origin}/buyer/${userId}?fastpass=cancelled`;

    // #412: both failure shapes are hard errors. Nothing has been written yet,
    // so the enrollment is still cleanly `pending_payment` and retryable.
    let session: { id: string; url: string | null };
    try {
      session = await createFastPassCheckout({
        dealId,
        dealTitle: deal.title,
        amountCents: totalCents,
        successUrl,
        cancelUrl,
        customerEmail: payer?.email ?? undefined,
      });
    } catch (err) {
      console.error("stripe fast pass checkout error", { dealId, err });
      return error("could not start checkout — please try again", 502);
    }
    if (!session.url) {
      console.error("stripe fast pass checkout returned no url", {
        dealId,
        sessionId: session.id,
      });
      return error("could not start checkout — please try again", 502);
    }

    // Record the choice + the session, but leave `status` and `paid` alone:
    // only Stripe's webhook may mark this enrollment paid, and it promotes
    // `pending_payment` → `active` when it does (#440). Guarded on
    // `pending_payment` so a webhook that landed while Checkout was being
    // created can't be overwritten back to unpaid.
    await prisma.$executeRaw`
      UPDATE deals
      SET fast_pass = fast_pass || jsonb_build_object(
            'payment_option', 'now',
            'total_cents', ${totalCents}::int,
            'checkout_session_id', ${session.id}::text,
            'payment_chosen_at', NOW()::text,
            'payment_chosen_by', ${userId}::text
          ),
          updated_at = NOW()
      WHERE id = ${dealId}::uuid
        AND fast_pass IS NOT NULL
        AND fast_pass->>'status' = 'pending_payment'
    `;

    return json({
      ok: true,
      status: "pending_payment",
      payment_option: "now",
      total_cents: totalCents,
      checkout_url: session.url,
    });
  })) as Response;
}
