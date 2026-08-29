"use client";

/**
 * IntakeCard (#175) — read-only card showing the buyer/seller onboarding
 * questionnaire persisted on the deal (`deals.intake`, migration 000050).
 *
 * Self-contained: give it a dealId and it fetches GET /api/deals/:id/intake
 * itself (the endpoint is agent-/participant-scoped server-side). Or pass the
 * `intake` payload directly to skip the fetch (pass null for the empty state).
 *
 * NOT mounted anywhere yet — DealDetail.tsx is owned by another PR. To mount
 * it there (follow-up DealDetail-owner PR), add:
 *
 *   import IntakeCard from "@/components/intake/IntakeCard";
 *   <IntakeCard dealId={deal.id} />
 *
 * (e.g. on the deal's overview/intake tab, same pattern as
 * AddCustomLineControl in PR #236 → #240.)
 */
import { useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { api } from "@/lib/api-client";
// #427 — the labels and value formatting are shared with the CLIENT's own
// review screen (lib/intake-review.ts), so a reworded question reads the same
// on both sides of the deal.
import {
  BUYER_FIELDS,
  LENDER_LABELS,
  SELLER_FIELDS,
  formatValue,
  humanize,
  moneyShort,
} from "@/lib/intake-fields";

export type DealIntakePayload = {
  role: "buyer" | "seller";
  submitted_at: string;
  answers: Record<string, unknown>;
};

type Props = {
  dealId: string;
  /** Pass the payload to skip the fetch; pass null to force the empty state. */
  intake?: DealIntakePayload | null;
};

// Keys rendered by the special rows below — excluded from the generic list.
const SPECIAL_KEYS = new Set(["minBudget", "maxBudget", "lenderChoice"]);

type Row = { key: string; label: string; value: string };

function buildRows(intake: DealIntakePayload): Row[] {
  const fields = intake.role === "seller" ? SELLER_FIELDS : BUYER_FIELDS;
  const rows: Row[] = [];

  // Budget first — the combined min/max range.
  const min = intake.answers.minBudget;
  const max = intake.answers.maxBudget;
  if (typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max)) {
    rows.push({ key: "budget", label: "Budget", value: `${moneyShort(min)} – ${moneyShort(max)}` });
  }

  const listed = new Set<string>(SPECIAL_KEYS);
  for (const { key, label } of fields) {
    listed.add(key);
    const value = formatValue(key, intake.answers[key]);
    if (value !== null) rows.push({ key, label, value });
  }
  // Future-proofing: any answer key we don't know about still renders.
  for (const key of Object.keys(intake.answers)) {
    if (listed.has(key)) continue;
    const value = formatValue(key, intake.answers[key]);
    if (value !== null) rows.push({ key, label: humanize(key), value });
  }
  return rows;
}

export default function IntakeCard({ dealId, intake: intakeProp }: Props) {
  // undefined = still loading (fetch path only); null = no intake.
  const [fetched, setFetched] = useState<DealIntakePayload | null | undefined>(undefined);

  useEffect(() => {
    if (intakeProp !== undefined) return; // payload supplied — no fetch
    let cancelled = false;
    api
      .get<{ intake: DealIntakePayload | null }>(`/deals/${dealId}/intake`)
      .then((res) => {
        if (!cancelled) setFetched(res.intake ?? null);
      })
      .catch(() => {
        // Read failures degrade to the empty state — this card is contextual,
        // never blocking.
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [dealId, intakeProp]);

  const intake = intakeProp !== undefined ? intakeProp : fetched;

  const header = (
    <div className="mb-3 flex items-center gap-2">
      <ClipboardList size={16} className="text-brand-navy" />
      <h3 className="text-sm font-bold uppercase tracking-wider text-brand-navy">Client Intake</h3>
    </div>
  );

  if (intake === undefined) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {header}
        <p className="text-sm text-gray-400">Loading…</p>
      </div>
    );
  }

  if (intake === null) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        {header}
        <p className="text-sm text-gray-400">
          No intake submitted yet — it appears here when the client finishes onboarding.
        </p>
      </div>
    );
  }

  const rows = buildRows(intake);
  const lenderChoice =
    typeof intake.answers.lenderChoice === "string" && intake.answers.lenderChoice.trim()
      ? intake.answers.lenderChoice.trim()
      : null;
  const submitted = new Date(intake.submitted_at);
  const submittedLabel = Number.isNaN(submitted.getTime())
    ? null
    : submitted.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="rounded-lg bg-brand-navy/10 px-2.5 py-1 text-xs font-bold uppercase tracking-wider text-brand-navy">
          {intake.role}
        </span>
        {lenderChoice && (
          <span
            className={[
              "rounded-lg px-2.5 py-1 text-xs font-bold",
              lenderChoice === "mountain" || lenderChoice === "fastpass"
                ? "bg-green-100 text-green-700"
                : "bg-gray-100 text-gray-500",
            ].join(" ")}
          >
            {LENDER_LABELS[lenderChoice] ?? lenderChoice}
          </span>
        )}
        {submittedLabel && <span className="text-xs text-gray-400">Submitted {submittedLabel}</span>}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-gray-400">The questionnaire was submitted without answers.</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {rows.map(({ key, label, value }) => (
            <div key={key} className="min-w-0">
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {label}
              </dt>
              <dd className="mt-0.5 break-words text-sm font-medium text-brand-navy">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
