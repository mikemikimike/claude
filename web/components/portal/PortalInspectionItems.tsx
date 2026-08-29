"use client";

import { ClipboardList } from "lucide-react";
import { useInspectionItems } from "@/hooks/useInspectionItems";
import {
  isClosedInspectionStatus,
  summarizeInspectionItems,
  type InspectionItemSeverity,
  type InspectionItemStatus,
} from "@/lib/inspection-items";

/**
 * The buyer's read-only view of their inspection findings (#429, slice c).
 *
 * This is the thing the `inspection_followup` add-on actually sells — "every
 * item on your inspection report tracked to completion", with the buyer able to
 * see it. Until now the only trace of the $147 they paid was a status label
 * derived from the deal's stage.
 *
 * READ-ONLY, deliberately and structurally. The server is the security boundary
 * (`inspectionItemAccess` gives a participant `canRead` and not `canWrite`, and
 * the routes 403 a buyer's POST/PATCH/DELETE — covered in
 * tests/api/inspection-items.test.ts), so this component does not need to
 * enforce anything. What it must not do is *offer* an action that would then be
 * refused: there is no form, no select, no button anywhere in here. A buyer who
 * disagrees with a status talks to their agent, who owns the record.
 *
 * The labels are their own map rather than an import from the agent's
 * InspectionTab: same data, different voice. "Requested" means something to an
 * agent working a repair addendum; the buyer needs "we have asked the seller".
 */

const STATUS_LABEL: Record<InspectionItemStatus, string> = {
  open: "Not started",
  requested: "Repair requested",
  scheduled: "Repair scheduled",
  resolved: "Resolved",
  waived: "Waived",
};

const STATUS_PILL: Record<InspectionItemStatus, string> = {
  open: "bg-gray-100 text-gray-600",
  requested: "bg-amber-100 text-amber-700",
  scheduled: "bg-blue-100 text-blue-700",
  resolved: "bg-green-100 text-green-700",
  waived: "bg-purple-100 text-purple-700",
};

const SEVERITY_LABEL: Record<InspectionItemSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
  safety: "Safety",
};

const SEVERITY_PILL: Record<InspectionItemSeverity, string> = {
  minor: "bg-gray-100 text-gray-500",
  moderate: "bg-yellow-100 text-yellow-700",
  major: "bg-orange-100 text-orange-700",
  safety: "bg-red-100 text-red-700",
};

export default function PortalInspectionItems({ dealId }: { dealId: string }) {
  const { items, loading, error } = useInspectionItems(dealId);
  const summary = summarizeInspectionItems(items);

  // Nothing to say yet. An empty card that reads "no findings" on a deal whose
  // inspection has not happened would be noise, and — worse — could be read as
  // "the report came back clean". The tracker row above already carries the
  // honest "no findings tracked yet" state for the paid add-on.
  if (loading || error || items.length === 0) return null;

  const pct = Math.round((summary.closed / summary.total) * 100);

  return (
    <div
      data-testid="buyer-inspection-items"
      className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList size={15} className="text-brand-navy" />
          <h3 className="text-sm font-bold text-brand-navy">
            Your inspection follow-up
          </h3>
        </div>
        <span
          data-testid="buyer-inspection-progress"
          className="text-xs font-semibold text-gray-500"
        >
          {summary.closed} of {summary.total} resolved
        </span>
      </div>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className="h-full rounded-full bg-green-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
        Everything the inspector flagged, and where each one stands. Your agent
        updates this as items get chased down — ask them if anything looks wrong.
      </p>

      <ul className="mt-3 divide-y divide-gray-50">
        {items.map((item) => {
          const closed = isClosedInspectionStatus(item.status);
          return (
            <li
              key={item.id}
              data-testid="buyer-inspection-item"
              data-status={item.status}
              className="py-2.5"
            >
              <p
                className={`text-sm ${
                  closed ? "text-gray-400 line-through" : "text-brand-navy"
                }`}
              >
                {item.description}
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-brand-navy/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-navy">
                  {item.category}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SEVERITY_PILL[item.severity]}`}
                >
                  {SEVERITY_LABEL[item.severity]}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${STATUS_PILL[item.status]}`}
                >
                  {STATUS_LABEL[item.status]}
                </span>
              </div>
              {item.notes && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-gray-500">
                  {item.notes}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
