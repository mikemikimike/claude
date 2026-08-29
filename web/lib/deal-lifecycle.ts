/**
 * Is this deal over? (#418)
 *
 * There are two independent ways a deal ends, and until this module every
 * rollup in the app picked one of them by hand:
 *
 * 1. **It closed.** `deals.stage` reaches `post_close`. Nothing writes
 *    `deals.status` when that happens, so the deal stays `status = 'active'`
 *    and keeps arriving in the default (active-only) `GET /deals` response
 *    forever. That is the whole bug in #418: a finished deal inflated Active
 *    Deals, sat in On Track, and counted as pipeline money indefinitely.
 * 2. **It was closed out.** `deals.status` moves off `active` — `archived`
 *    (the agent filed it away, from `post_close` or from anywhere earlier) or
 *    `fallen_through`.
 *
 * There is deliberately NO `completed` lifecycle status to make case 1 look
 * like case 2 (see #417): `deals.stage` already records the successful ending,
 * so "we closed it" is derived, never stored. The consequence is that every
 * consumer has to ask about BOTH fields — which is exactly the duplication
 * that let the agent and admin dashboards drift apart. Ask this instead.
 *
 * Structural on purpose: the wire type (`ApiDeal`, snake_case strings) and the
 * view model (`Deal`) both satisfy it, so server routes and components can
 * share one rule.
 */
export type LifecycleDeal = {
  stage: string;
  /** Absent on payloads that don't SELECT it — treated as still active. */
  status?: string | null;
};

/**
 * The deal is finished: closed (`post_close`) or closed out (any status other
 * than `active`). An absent status means "the payload didn't say", which is
 * only ever the case on the create/`/api/me/deals` shapes where a deal is
 * active by construction — so it reads as active, never as closed.
 */
export function isClosedOut(deal: LifecycleDeal): boolean {
  if (deal.stage === "post_close") return true;
  return deal.status != null && deal.status !== "active";
}

/**
 * The complement: a deal still moving through the pipeline. This — not
 * `status === 'active'` and not `deals.length` — is what "Active Deals" counts,
 * what On Track buckets, and what the money rollups total.
 */
export function isOpenPipeline(deal: LifecycleDeal): boolean {
  return !isClosedOut(deal);
}

/**
 * Split a deal list into the two halves both dashboards need, in one pass, so
 * a caller can never filter one side and forget the other — the failure mode
 * that would make a finished deal vanish from the dashboard entirely rather
 * than move to Completed.
 */
export function splitByLifecycle<T extends LifecycleDeal>(
  deals: readonly T[],
): { open: T[]; closed: T[] } {
  const open: T[] = [];
  const closed: T[] = [];
  for (const deal of deals) (isClosedOut(deal) ? closed : open).push(deal);
  return { open, closed };
}
