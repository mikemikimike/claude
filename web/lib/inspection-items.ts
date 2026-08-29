/**
 * Per-item inspection follow-up tracking (#429).
 *
 * The `inspection_followup` Fast Pass add-on promises that every finding in the
 * inspection report is chased to completion. These are those findings.
 *
 * This module is deliberately PURE — no prisma, no db imports — because the
 * agent's InspectionTab imports these constants into the browser. Importing a
 * Prisma-touching module from a client component fails the Turbopack build
 * ("the chunking context does not support external modules"), which is why the
 * server-side access gate lives in `lib/inspection-item-access.ts` instead.
 */
export const INSPECTION_ITEM_STATUSES = [
  "open",
  "requested",
  "scheduled",
  "resolved",
  "waived",
] as const;
export type InspectionItemStatus = (typeof INSPECTION_ITEM_STATUSES)[number];

export const INSPECTION_ITEM_SEVERITIES = [
  "minor",
  "moderate",
  "major",
  "safety",
] as const;
export type InspectionItemSeverity =
  (typeof INSPECTION_ITEM_SEVERITIES)[number];

export const INSPECTION_ITEM_OWNERS = [
  "seller",
  "buyer",
  "agent",
  "tc",
  "third_party",
] as const;
export type InspectionItemOwner = (typeof INSPECTION_ITEM_OWNERS)[number];

/**
 * Terminal statuses. An item in either state needs no further chasing:
 * 'resolved' means the work was done, 'waived' means it was deliberately
 * dropped (a credit was taken, or the buyer accepted it as-is). Both stamp
 * `resolved_at`. Slice (c) reads this set to decide whether the Fast Pass
 * add-on is genuinely complete.
 */
export const INSPECTION_CLOSED_STATUSES = new Set<string>([
  "resolved",
  "waived",
]);

export function isClosedInspectionStatus(status: string): boolean {
  return INSPECTION_CLOSED_STATUSES.has(status);
}

/**
 * Progress over a deal's inspection items. `allClosed` is false for an empty
 * list on purpose — "no items entered" is not "all work done", which is exactly
 * the false-completion trap the stage-derived tracker fell into.
 */
export function summarizeInspectionItems(
  items: readonly { status: string }[]
): { total: number; closed: number; open: number; allClosed: boolean } {
  const total = items.length;
  const closed = items.filter((i) => isClosedInspectionStatus(i.status)).length;
  return { total, closed, open: total - closed, allClosed: total > 0 && closed === total };
}
