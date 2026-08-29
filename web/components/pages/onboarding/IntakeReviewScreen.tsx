"use client";

/**
 * "Here's what you told us" — the last step of both onboarding wizards, and the
 * screen the portal's *Your preferences* link reopens (#427).
 *
 * Before this, a client answered ~20 questions, submitted blind, and never saw
 * the answers again. Now every visible question is listed with its answer, and
 * every row is a button that jumps back to the screen that asked it.
 *
 * Shared by the buyer and the seller wizard so the two reviews cannot drift.
 * It is purely presentational: the rows (and what "visible" means) come from
 * lib/intake-review, and the caller owns the navigation and the save.
 *
 * ⚠️ #407: this is an OPT-IN review, never a prompt. It renders only where the
 * client asked for it — the end of the wizard they are already in, or the
 * preferences link they clicked. Nothing here may be surfaced at a client who
 * has already submitted unless they went looking for it.
 */
import { Pencil } from "lucide-react";
import type { IntakeReviewRow } from "@/lib/intake-review";

export default function IntakeReviewScreen({
  rows,
  onEdit,
  onSubmit,
  submitLabel,
  title,
  blurb,
  saving = false,
  error = null,
  onCancel,
}: {
  rows: IntakeReviewRow[];
  /** Jump to the wizard screen that owns this answer. */
  onEdit: (target: number | string) => void;
  onSubmit: () => void;
  submitLabel: string;
  title: string;
  blurb: string;
  saving?: boolean;
  error?: string | null;
  /** Edit mode only — back to the portal without saving. */
  onCancel?: () => void;
}) {
  return (
    <div className="screen-enter flex w-full flex-col items-center">
      <div className="mb-6 text-center">
        <h2 className="text-2xl font-bold leading-snug text-brand-navy sm:text-3xl">{title}</h2>
        <p className="mt-2 text-sm text-gray-400">{blurb}</p>
      </div>

      <ul data-testid="intake-review" className="w-full max-w-sm space-y-2">
        {rows.map((row) => (
          <li key={row.key}>
            <button
              type="button"
              onClick={() => onEdit(row.target)}
              aria-label={`Change ${row.label}`}
              className="group flex w-full items-center gap-3 rounded-xl bg-gray-50 px-4 py-3 text-left transition-colors hover:bg-gray-100 active:scale-[0.99]"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  {row.label}
                </span>
                <span
                  className={[
                    "mt-0.5 block break-words text-sm font-semibold",
                    row.answered ? "text-brand-navy" : "italic text-gray-400",
                  ].join(" ")}
                >
                  {row.value}
                </span>
              </span>
              <span className="flex flex-shrink-0 items-center gap-1 text-xs font-bold text-brand-navy/50 group-hover:text-brand-navy">
                <Pencil size={13} /> Change
              </span>
            </button>
          </li>
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="mt-4 w-full max-w-sm rounded-xl bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
        >
          {error}
        </p>
      )}

      <div className="w-full max-w-sm">
        <button
          type="button"
          onClick={onSubmit}
          disabled={saving}
          className={[
            "mt-6 flex w-full items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition-all",
            saving
              ? "cursor-not-allowed bg-gray-100 text-gray-300"
              : "bg-brand-navy text-white hover:bg-brand-navy/80 active:scale-[0.98]",
          ].join(" ")}
        >
          {saving ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="mt-3 w-full text-center text-sm text-gray-400 transition-colors hover:text-gray-600"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
