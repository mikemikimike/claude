import { error, json, withAuth } from "@/lib/http";
import { prisma } from "@/lib/db";
import { hasDealAccess } from "@/lib/deals";
import { resolveUserId } from "@/lib/users";
import {
  SMOOTH_EXIT_UPSELL_PRICE_CENTS,
  isSmoothExitUpsellId,
  type SmoothExitUpsellId,
} from "@/lib/smooth-exit-catalog";
import { createSmoothExitUpsellCheckout } from "@/lib/stripe";
import { smoothExitEnrollBodySchema } from "@/lib/schemas/enrollment";
import { parseBody } from "@/lib/schemas/parse";

type Ctx = { params: Promise<{ id: string }> };

// POST /deals/:dealId/smoothexit — owning agent or any deal participant (#170:
// sellers enroll their own deal from the portal pitch; upsells are priced
// server-side, so opening the route to participants stays tamper-safe).
// Stores Smooth Exit enrollment JSONB on the deal. If upsells were selected and
// Stripe is configured, charges them upfront via Stripe Checkout and returns a
// checkout_url. Ports EnrollSmoothExit (the legacy Go backend), except the
// upsell total is priced server-side from lib/smooth-exit-catalog.ts (#81)
// instead of trusting the client's upsell_total_cents.
export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const { id: dealId } = await ctx.params;
  return (await withAuth(req, async (claims): Promise<Response> => {
    const userId = await resolveUserId(claims.sub);
    if (!userId) return error("user not found", 404);

    const deal = await prisma.deals.findFirst({
      where: { id: dealId },
      select: { agent_id: true, title: true, smooth_exit: true },
    });
    if (!deal) return error("deal not found", 404);
    // Owner short-circuits; anyone else must be a deal participant (seller,
    // buyer, …) — hasDealAccess covers both, but the owner check avoids the
    // extra query on the common agent path. (Same pattern as fastpass, #169.)
    const isOwner = deal.agent_id === userId;
    if (!isOwner && !(await hasDealAccess(dealId, userId))) {
      return error("forbidden", 403);
    }

    // Schema-validated (#88): typed junk (string prices, numeric
    // payment_option, non-array upsells) 400s here instead of persisting
    // into the smooth_exit JSONB.
    const parsed = await parseBody(req, smoothExitEnrollBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;

    const selectedUpsells = body.selected_upsells ?? [];

    // Validate every incoming upsell key against the shared catalog BEFORE
    // anything is read back or persisted (#81/#88): unknown keys 400 and the
    // existing enrollment is left untouched. body.upsell_total_cents is ignored
    // — the server prices from the catalog so a tampered client can't set its
    // own price. Dedupe as we go (duplicate keys count once).
    const incoming = new Set<SmoothExitUpsellId>();
    for (const key of selectedUpsells) {
      if (!isSmoothExitUpsellId(key)) {
        return error(`unknown upsell: ${key}`, 400);
      }
      incoming.add(key);
    }

    // #260: read what's already stored before overwriting. If a prior
    // enrollment was already PAID (the Stripe webhook flipped upsells_paid=true
    // and stamped upsells_paid_at), a second POST must NOT downgrade it to
    // unpaid or re-charge those add-ons — re-submission is supported (the Stripe
    // cancel URL returns to the survey; both agent and seller can POST). Treat
    // previously-stored upsells as paid, price only the newly-added ones, and
    // carry the payment record + original enrolled_at forward. A prior UNPAID
    // enrollment (e.g. a cancelled checkout returning to the survey) re-prices
    // in full with a fresh enrolled_at — first-enrollment behavior, unchanged.
    const prior = readPriorEnrollment(deal.smooth_exit);
    const priorPaid = prior?.upsellsPaid === true;
    const paidUpsells = new Set<SmoothExitUpsellId>(
      priorPaid ? prior!.priorUpsells : []
    );

    // Store the union of already-paid upsells and the new selection — a paid
    // add-on can't be un-bought by re-submitting without it.
    const unionUpsells = new Set<SmoothExitUpsellId>([...paidUpsells, ...incoming]);

    // Charge only upsells that aren't already paid for.
    const toChargeUpsells = [...incoming].filter((key) => !paidUpsells.has(key));
    let chargeCents = 0;
    for (const key of toChargeUpsells) {
      chargeCents += SMOOTH_EXIT_UPSELL_PRICE_CENTS[key];
    }

    // Stored total = cumulative catalog value of ALL upsells on the enrollment
    // (paid + newly-added). The admin dashboard sums this as upsell revenue, so
    // it must reflect everything committed to, not just this checkout's delta.
    let unionTotalCents = 0;
    for (const key of unionUpsells) {
      unionTotalCents += SMOOTH_EXIT_UPSELL_PRICE_CENTS[key];
    }

    const enrollment = {
      status: "active",
      payment_option: body.payment_option ?? "",
      estimated_sale_price: body.estimated_sale_price ?? 0,
      fee_cents: body.fee_cents ?? 0,
      survey_answers: (body.survey_answers ?? null) as object | null,
      selected_upsells: [...unionUpsells],
      upsell_total_cents: unionTotalCents,
      // #260: never downgrade a paid enrollment. Carry the payment evidence
      // (upsells_paid / _at / checkout_session_id) and the original enrolled_at
      // forward when already paid; otherwise this is a fresh enrollment.
      upsells_paid: priorPaid,
      enrolled_at:
        priorPaid && prior!.enrolledAt
          ? prior!.enrolledAt
          : new Date().toISOString(),
      ...(priorPaid && prior!.upsellsPaidAt
        ? { upsells_paid_at: prior!.upsellsPaidAt }
        : {}),
      ...(priorPaid && prior!.upsellsCheckoutSessionId
        ? { upsells_checkout_session_id: prior!.upsellsCheckoutSessionId }
        : {}),
    };

    await prisma.deals.update({
      where: { id: dealId },
      data: { smooth_exit: enrollment, updated_at: new Date() },
    });

    // Charge only the newly-added upsells upfront via Stripe. Already-paid
    // add-ons are excluded from chargeCents, so they're never re-billed; when
    // nothing new was added, we skip Stripe entirely and return a plain ok (no
    // checkout_url). The enrollment is already persisted, so any Stripe failure
    // (including no key configured) also falls back to ok — mirrors the Go handler.
    if (chargeCents > 0) {
      const url = new URL(req.url);
      const origin = `${url.protocol}//${url.host}`;
      // Role-aware success URL (#170): a participant (seller) returns to their
      // own portal after paying; the owning agent keeps the legacy completion
      // URL. Cancel returns both to the survey's ?deal_id entry point so a
      // resubmit works (SmoothExitSurvey keeps its handoff for exactly this).
      const successUrl = isOwner
        ? `${origin}/smooth-exit/complete?deal_id=${dealId}&upsells=paid`
        : `${origin}/seller/${userId}?smoothexit=paid`;
      // #413: prefill Checkout with the payer's own address, read here from the
      // DB for the authenticated caller (agent or seller — whoever actually
      // submitted this enrollment) rather than accepted from the request body,
      // which would let a caller point the receipt at an address they don't own.
      const payer = await prisma.users.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      try {
        const session = await createSmoothExitUpsellCheckout({
          dealId,
          dealTitle: deal.title,
          amountCents: chargeCents,
          successUrl,
          cancelUrl: `${origin}/smooth-exit/survey?deal_id=${dealId}&cancelled=1`,
          customerEmail: payer?.email ?? undefined,
        });
        if (session.url) {
          return json({ ok: true, checkout_url: session.url });
        }
      } catch (err) {
        console.error("stripe smooth exit upsell checkout error", err);
      }
    }

    return json({ ok: true });
  })) as Response;
}

// #260: the slice of a previously-stored Smooth Exit enrollment we must read
// back before overwriting, so a re-POST after payment can't wipe the payment
// record or re-charge already-paid upsells. Only catalog-valid upsell ids are
// kept — a hand-mangled JSONB can't smuggle an unknown key into pricing.
type PriorEnrollment = {
  upsellsPaid: boolean;
  priorUpsells: SmoothExitUpsellId[];
  upsellsPaidAt: string | null;
  upsellsCheckoutSessionId: string | null;
  enrolledAt: string | null;
};

function readPriorEnrollment(raw: unknown): PriorEnrollment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const rawUpsells = Array.isArray(obj.selected_upsells)
    ? obj.selected_upsells
    : [];
  const priorUpsells = rawUpsells.filter(
    (k): k is SmoothExitUpsellId =>
      typeof k === "string" && isSmoothExitUpsellId(k)
  );
  return {
    upsellsPaid: obj.upsells_paid === true,
    priorUpsells,
    upsellsPaidAt:
      typeof obj.upsells_paid_at === "string" ? obj.upsells_paid_at : null,
    upsellsCheckoutSessionId:
      typeof obj.upsells_checkout_session_id === "string"
        ? obj.upsells_checkout_session_id
        : null,
    enrolledAt: typeof obj.enrolled_at === "string" ? obj.enrolled_at : null,
  };
}
