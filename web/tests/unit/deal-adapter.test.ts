/**
 * Regression test for issue #85 — dashboard pipeline totals concatenated
 * instead of summing.
 *
 * The deal SELECTs (lib/deals.ts, app/api/deals/route.ts, app/api/me/deals)
 * cast Postgres DECIMAL columns to text — `price::text`, `commission_pct::text`
 * — so on the wire they are strings like "450000.00". ApiDeal must declare
 * them as strings and apiDealToFrontend must parse them to numbers, otherwise
 * `reduce((s, d) => s + d.property.price, 0)` in AdminDashboard /
 * AgentDashboard string-concatenates ("0450000.00") instead of summing.
 *
 * DB-free: exercises only the exported adapter.
 */
import { describe, it, expect } from "vitest";
import { apiDealToFrontend, type ApiDeal } from "@/hooks/useDeals";
import {
  NO_AMOUNT,
  formatCompactMoney,
  pipelineCommission,
  pipelinePrice,
  sumKnown,
} from "@/lib/deal-money";
import { preApprovalState } from "@/lib/pre-approval";

function wireDeal(overrides: Partial<ApiDeal> = {}): ApiDeal {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    agent_id: "00000000-0000-0000-0000-000000000002",
    type: "buy",
    stage: "active_search",
    health: "green",
    title: "Smith — Buy",
    address: "123 Main St",
    price: null,
    arive_linked: false,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("apiDealToFrontend numeric parsing (#85)", () => {
  it("parses wire price text '450000.00' into the number 450000", () => {
    const deal = apiDealToFrontend(wireDeal({ price: "450000.00" }));
    expect(typeof deal.property.price).toBe("number");
    expect(deal.property.price).toBe(450000);
  });

  // #411 — the old contract mapped a missing price to the number 0 ("the
  // client's TBD sentinel"), which is exactly why Pipeline Value and Est.
  // Commission read "$0" on every deal nobody had priced by hand. A price the
  // app does not know is now `null` all the way to the render, so the UI can
  // draw "—" instead of a number that looks computed.
  it("maps null and empty-string price to null, not 0 (#411)", () => {
    expect(apiDealToFrontend(wireDeal({ price: null })).property.price).toBeNull();
    expect(apiDealToFrontend(wireDeal({ price: "" })).property.price).toBeNull();
  });

  it("maps a stored 0 to null too — no house is worth $0 (#411)", () => {
    expect(apiDealToFrontend(wireDeal({ price: "0" })).property.price).toBeNull();
    expect(apiDealToFrontend(wireDeal({ price: "0.00" })).property.price).toBeNull();
  });

  it("leaves estimatedCommission null when there is no price to take a cut of (#411)", () => {
    const deal = apiDealToFrontend(wireDeal({ price: null, commission_pct: "3.00" }));
    expect(deal.estimatedCommission).toBeNull();
    // The rate itself is still known — only the money is missing.
    expect(deal.commissionPct).toBe(3);
  });

  it("dashboard volume reduce sums to a number — never a concatenated string", () => {
    const deals = [
      apiDealToFrontend(wireDeal({ price: "450000.00" })),
      apiDealToFrontend(
        wireDeal({ id: "00000000-0000-0000-0000-000000000003", price: null }),
      ),
    ];
    const total = sumKnown(deals.map((d) => d.property.price));
    expect(typeof total).toBe("number");
    expect(total).toBe(450000);
  });

  it("parses commission_pct '2.50' into 2.5 and computes a numeric estimatedCommission", () => {
    const deal = apiDealToFrontend(
      wireDeal({ price: "450000.00", commission_pct: "2.50" }),
    );
    expect(deal.commissionPct).toBe(2.5);
    expect(deal.estimatedCommission).toBe(11250);
  });

  it("defaults commissionPct to 3 when commission_pct is absent from the wire", () => {
    const deal = apiDealToFrontend(wireDeal({ price: "100000" }));
    expect(deal.commissionPct).toBe(3);
    expect(deal.estimatedCommission).toBe(3000);
  });

  it("treats garbage and whitespace-only numerics as absent — client defaults apply", () => {
    expect(apiDealToFrontend(wireDeal({ price: "abc" })).property.price).toBeNull();
    expect(apiDealToFrontend(wireDeal({ price: "  " })).property.price).toBeNull();
    expect(
      apiDealToFrontend(wireDeal({ price: "100000", commission_pct: "abc" }))
        .commissionPct,
    ).toBe(3);
  });
});

describe("daysInStage anchors to stage entry, not updated_at (#257)", () => {
  it("computes daysInStage from stage_entered_at even when updated_at is 'now'", () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString();
    // updated_at = now simulates an unrelated write (note edit, fee, ARIVE sync)
    // that bumped it. The count must still read 5, not reset to 0.
    const deal = apiDealToFrontend(
      wireDeal({ stage_entered_at: fiveDaysAgo, updated_at: new Date().toISOString() }),
    );
    expect(deal.timeline.daysInStage).toBe(5);
  });

  it("falls back to created_at when stage_entered_at is absent from the wire", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    // e.g. the POST /deals create response carries no stage_entered_at — a
    // brand-new deal's stage entry IS its creation, so created_at anchors it.
    const deal = apiDealToFrontend(
      wireDeal({ created_at: threeDaysAgo, updated_at: new Date().toISOString() }),
    );
    expect(deal.timeline.daysInStage).toBe(3);
  });

  it("never goes negative when the anchor is in the future", () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      apiDealToFrontend(wireDeal({ stage_entered_at: tomorrow })).timeline.daysInStage,
    ).toBe(0);
  });
});

// ─── Enrollment mapping (#426, US-08 of epic #441) ──────────────────────────
//
// The agent's Fast Pass card can only show what the adapter carries. Four
// fields the enrollment route writes — survey_answers, paid, promo_code,
// discount_cents — were being dropped here (a zod object strips unknown keys),
// which is also why the admin dashboard's survey block, written against
// `fp.surveyAnswers`, had never once rendered.

describe("apiDealToFrontend Fast Pass enrollment mapping (#426)", () => {
  const FULL_FAST_PASS = {
    status: "active",
    payment_option: "at_closing",
    selected_upsells: ["deep_clean", "utility_setup"],
    total_cents: 274000,
    enrolled_at: "2026-08-27T15:00:00.000Z",
    paid: true,
    promo_code: "LAUNCH100",
    discount_cents: 10000,
    survey_answers: {
      currentSituation: "renting",
      targetMoveDate: "2026-09-15",
      utilities: ["Electric", "Internet"],
      notes: "Cat is scared of movers.",
    },
  };

  it("carries selected add-ons and the client's survey answers through", () => {
    const deal = apiDealToFrontend(wireDeal({ fast_pass: FULL_FAST_PASS }));

    expect(deal.fastPass?.selectedUpsells).toEqual(["deep_clean", "utility_setup"]);
    expect(deal.fastPass?.surveyAnswers?.notes).toBe("Cat is scared of movers.");
    expect(deal.fastPass?.surveyAnswers?.utilities).toEqual(["Electric", "Internet"]);
  });

  it("carries the paid flag and the redeemed promo", () => {
    const deal = apiDealToFrontend(wireDeal({ fast_pass: FULL_FAST_PASS }));

    expect(deal.fastPass?.paid).toBe(true);
    expect(deal.fastPass?.promoCode).toBe("LAUNCH100");
    expect(deal.fastPass?.discountCents).toBe(10000);
  });

  it("a pending_payment enrollment keeps its add-ons but is neither paid nor optioned", () => {
    const deal = apiDealToFrontend(
      wireDeal({
        fast_pass: {
          status: "pending_payment",
          payment_option: null,
          selected_upsells: ["deep_clean"],
          total_cents: 221200,
          enrolled_at: "2026-08-27T15:00:00.000Z",
          paid: false,
        },
      })
    );

    expect(deal.fastPass?.status).toBe("pending_payment");
    expect(deal.fastPass?.paymentOption).toBeNull();
    expect(deal.fastPass?.paid).toBe(false);
    expect(deal.fastPass?.selectedUpsells).toEqual(["deep_clean"]);
  });

  it("never surfaces the Stripe checkout session id — that is plumbing (#440)", () => {
    const deal = apiDealToFrontend(
      wireDeal({
        fast_pass: {
          ...FULL_FAST_PASS,
          checkout_session_id: "cs_test_should_not_leak",
        } as unknown as ApiDeal["fast_pass"],
      })
    );

    expect(JSON.stringify(deal.fastPass)).not.toContain("cs_test_should_not_leak");
  });

  it("tolerates a survey blob with holes — null answers become absent, not null", () => {
    const deal = apiDealToFrontend(
      wireDeal({
        fast_pass: {
          status: "active",
          payment_option: "now",
          total_cents: 178700,
          enrolled_at: "2026-08-27T15:00:00.000Z",
          survey_answers: { targetMoveDate: null, notes: "Just the notes." },
        },
      })
    );

    expect(deal.fastPass?.surveyAnswers).toEqual({ notes: "Just the notes." });
  });
});

describe("apiDealToFrontend Smooth Exit enrollment mapping (#426)", () => {
  it("carries the seller's survey answers and lifts nextStep out of them", () => {
    const deal = apiDealToFrontend(
      wireDeal({
        type: "sell",
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          estimated_sale_price: 450000,
          fee_cents: 450000,
          enrolled_at: "2026-08-27T15:00:00.000Z",
          selected_upsells: ["staging_consult"],
          upsell_total_cents: 24700,
          upsells_paid: true,
          survey_answers: {
            nextStep: "downsizing",
            moveOutDate: "2026-10-01",
            notes: "Wants to stay through the holidays.",
          },
        },
      })
    );

    expect(deal.smoothExit?.surveyAnswers?.notes).toBe("Wants to stay through the holidays.");
    expect(deal.smoothExit?.nextStep).toBe("downsizing");
    expect(deal.smoothExit?.selectedUpsells).toEqual(["staging_consult"]);
  });

  it("drops an unrecognised nextStep rather than casting it (it indexes an exhaustive label map)", () => {
    const deal = apiDealToFrontend(
      wireDeal({
        type: "sell",
        smooth_exit: {
          status: "active",
          payment_option: "from_proceeds",
          enrolled_at: "2026-08-27T15:00:00.000Z",
          survey_answers: { nextStep: "moving_to_mars" },
        },
      })
    );

    expect(deal.smoothExit?.nextStep).toBeUndefined();
    expect(deal.smoothExit?.surveyAnswers?.nextStep).toBeUndefined();
  });
});

// ─── #459: Pipeline Value fills in at under contract, from the contract price ─
//
// Paul, 2026-08-28: "Pipeline only fills in when the client goes under
// contract, then it takes the commission % based on the contract price. Keep
// it simple."
//
// #410 stamps `deals.price` from the offer amount when a deal advances to
// Offer Active — that capture stays; it is the input, and on acceptance the
// accepted amount IS the contract price. What moves is the point at which it
// COUNTS: an offer can be rejected, so it is not pipeline until the deal is
// under contract. `pipelinePrice` / `pipelineCommission` are the one rule both
// dashboards ask, so the agent and admin rollups cannot drift apart.
describe("pipeline contribution by stage (#459)", () => {
  const priced = (stage: string) =>
    apiDealToFrontend(
      wireDeal({ stage, price: "475000.00", commission_pct: "3.00" })
    );

  it("counts nothing before under contract, however real the offer amount is", () => {
    for (const stage of ["intake", "active_search", "offer_active"]) {
      const deal = priced(stage);
      // The amount is still on the deal — an offer is still displayed as an offer.
      expect(deal.property.price).toBe(475000);
      // It just is not pipeline yet.
      expect(pipelinePrice(deal)).toBeNull();
      expect(pipelineCommission(deal)).toBeNull();
    }
  });

  it("counts the contract price from under_contract onward", () => {
    for (const stage of ["under_contract", "pre_close", "closing", "post_close"]) {
      expect(pipelinePrice(priced(stage))).toBe(475000);
      expect(pipelineCommission(priced(stage))).toBe(14250);
    }
  });

  it("commission is the contract price × commission_pct on that same set", () => {
    const deal = apiDealToFrontend(
      wireDeal({ stage: "under_contract", price: "475000.00", commission_pct: "2.75" })
    );
    expect(pipelineCommission(deal)).toBe(Math.round((475000 * 2.75) / 100));
    expect(pipelineCommission(deal)).toBe(13063);
  });

  it("an under-contract deal with no price contributes nothing — '—', never $0 (#411)", () => {
    const deal = apiDealToFrontend(wireDeal({ stage: "under_contract", price: null }));
    expect(pipelinePrice(deal)).toBeNull();
    expect(formatCompactMoney(sumKnown([pipelinePrice(deal)]), 2)).toBe(NO_AMOUNT);
  });

  it("totals a mixed pipeline from the under-contract deals only", () => {
    const deals = [
      apiDealToFrontend(wireDeal({ stage: "offer_active", price: "600000.00" })),
      apiDealToFrontend(wireDeal({ stage: "under_contract", price: "475000.00" })),
      apiDealToFrontend(wireDeal({ stage: "closing", price: "525000.00" })),
      apiDealToFrontend(wireDeal({ stage: "active_search", price: null })),
    ];
    const total = sumKnown(deals.map(pipelinePrice));
    expect(typeof total).toBe("number");
    expect(total).toBe(1_000_000);
  });
});

/**
 * The pre-approval wire→state path (#437 + #438).
 *
 * The agent's three-way display (#438) reads `deal.preApprovalAppliedAt`, which
 * exists only because `apiDealToFrontend` maps `pre_approval_applied_at` across
 * — ONE line. The component tests inject the view-model field directly, so they
 * cannot see that line disappear: drop it and every agent surface silently
 * reverts to "not started" for a buyer who applied, with a fully green suite.
 *
 * This is that missing link, tested through the real adapter on a real wire
 * shape. DB-free.
 */
describe("apiDealToFrontend → pre-approval state (#437/#438)", () => {
  it("carries pre_approval_applied_at across to the view model", () => {
    const deal = apiDealToFrontend(
      wireDeal({ pre_approval_applied_at: "2026-08-12T12:00:00.000Z" })
    );
    expect(deal.preApprovalAppliedAt).toBe("2026-08-12T12:00:00.000Z");
    expect(preApprovalState(deal)).toBe("applied");
  });

  it("a payload without the column reads as not-started, never as applied", () => {
    // An older cached response, or any route that doesn't SELECT the column.
    const deal = apiDealToFrontend(wireDeal());
    expect(deal.preApprovalAppliedAt).toBeNull();
    expect(preApprovalState(deal)).toBe("not_started");
  });

  it("agent-set pre_approved outranks the buyer's applied date", () => {
    const deal = apiDealToFrontend(
      wireDeal({ pre_approved: true, pre_approval_applied_at: "2026-08-12T12:00:00.000Z" })
    );
    expect(preApprovalState(deal)).toBe("pre_approved");
  });

  it("the buyer's applied date alone never reaches the pre-approved state", () => {
    // The #437 invariant, restated from the display side: only the agent opens
    // the offer gate, so `applied` must never resolve to `pre_approved`.
    const deal = apiDealToFrontend(
      wireDeal({ pre_approved: false, pre_approval_applied_at: "2026-08-12T12:00:00.000Z" })
    );
    expect(preApprovalState(deal)).not.toBe("pre_approved");
  });
});
