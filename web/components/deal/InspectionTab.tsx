"use client";

import { useState } from "react";
import { Deal } from "@/lib/types";
import { useDocuments } from "@/hooks/useDocuments";
import {
  useInspectionItems,
  type InspectionItem,
  type InspectionItemInput,
  type InspectionItemPatch,
} from "@/hooks/useInspectionItems";
import {
  INSPECTION_ITEM_OWNERS,
  INSPECTION_ITEM_SEVERITIES,
  INSPECTION_ITEM_STATUSES,
  isClosedInspectionStatus,
  summarizeInspectionItems,
  type InspectionItemOwner,
  type InspectionItemSeverity,
  type InspectionItemStatus,
} from "@/lib/inspection-items";
import { ClipboardList, FileText, Plus, Trash2, X } from "lucide-react";

const STATUS_LABEL: Record<InspectionItemStatus, string> = {
  open: "Open",
  requested: "Repair requested",
  scheduled: "Scheduled",
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

const OWNER_LABEL: Record<InspectionItemOwner, string> = {
  seller: "Seller",
  buyer: "Buyer",
  agent: "Agent",
  tc: "TC",
  third_party: "Third party",
};

const SELECT_CLASS =
  "rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-brand-navy outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10";

const INPUT_CLASS =
  "w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-brand-navy outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10";

type DocOption = { id: string; name: string };

// ── Add form ────────────────────────────────────────────────────────────────

const EMPTY_DRAFT = {
  description: "",
  category: "",
  severity: "moderate" as InspectionItemSeverity,
  owner: "seller" as InspectionItemOwner,
  documentId: "",
};

function AddItemForm({
  docs,
  busy,
  onAdd,
}: {
  docs: DocOption[];
  busy: boolean;
  onAdd: (input: InspectionItemInput) => void;
}) {
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const canSubmit = draft.description.trim().length > 0 && !busy;

  function submit() {
    if (!canSubmit) return;
    onAdd({
      description: draft.description.trim(),
      category: draft.category.trim() || undefined,
      severity: draft.severity,
      owner: draft.owner,
      document_id: draft.documentId || null,
    });
    // Keep category / severity / owner: a report's findings arrive in runs
    // ("Roof", "Roof", "Roof"), so re-picking them per item is pure friction.
    setDraft((p) => ({ ...p, description: "" }));
  }

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <Plus size={14} className="text-brand-navy" />
        <h3 className="text-sm font-bold text-brand-navy">Add a finding</h3>
      </div>

      <div>
        <label
          htmlFor="inspection-description"
          className="block text-xs font-semibold text-gray-500 mb-1"
        >
          What the report found
        </label>
        <input
          id="inspection-description"
          value={draft.description}
          onChange={(e) =>
            setDraft((p) => ({ ...p, description: e.target.value }))
          }
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="e.g. Cracked flashing above the chimney"
          className={INPUT_CLASS}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label
            htmlFor="inspection-category"
            className="block text-xs font-semibold text-gray-500 mb-1"
          >
            Area / location
          </label>
          <input
            id="inspection-category"
            value={draft.category}
            onChange={(e) =>
              setDraft((p) => ({ ...p, category: e.target.value }))
            }
            placeholder="Roof, Kitchen, Electrical…"
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label
            htmlFor="inspection-severity"
            className="block text-xs font-semibold text-gray-500 mb-1"
          >
            Severity
          </label>
          <select
            id="inspection-severity"
            value={draft.severity}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                severity: e.target.value as InspectionItemSeverity,
              }))
            }
            className={`${INPUT_CLASS} bg-white`}
          >
            {INSPECTION_ITEM_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="inspection-owner"
            className="block text-xs font-semibold text-gray-500 mb-1"
          >
            Who owns it
          </label>
          <select
            id="inspection-owner"
            value={draft.owner}
            onChange={(e) =>
              setDraft((p) => ({
                ...p,
                owner: e.target.value as InspectionItemOwner,
              }))
            }
            className={`${INPUT_CLASS} bg-white`}
          >
            {INSPECTION_ITEM_OWNERS.map((o) => (
              <option key={o} value={o}>
                {OWNER_LABEL[o]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label
            htmlFor="inspection-document"
            className="block text-xs font-semibold text-gray-500 mb-1"
          >
            Source report (optional)
          </label>
          <select
            id="inspection-document"
            value={draft.documentId}
            onChange={(e) =>
              setDraft((p) => ({ ...p, documentId: e.target.value }))
            }
            className={`${INPUT_CLASS} bg-white`}
          >
            <option value="">Not linked</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <button
        onClick={submit}
        disabled={!canSubmit}
        className="rounded-lg bg-brand-navy px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-navy/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Add item
      </button>
    </div>
  );
}

// ── One row ─────────────────────────────────────────────────────────────────

type RowCtx = {
  docNames: Record<string, string>;
  onPatch: (id: string, patch: InspectionItemPatch) => void;
  onDelete: (id: string) => void;
};

function InspectionRow({ item, ctx }: { item: InspectionItem; ctx: RowCtx }) {
  const [notesDraft, setNotesDraft] = useState(item.notes ?? "");
  const [editingNotes, setEditingNotes] = useState(false);
  const closed = isClosedInspectionStatus(item.status);

  return (
    <div
      className={`rounded-lg border border-gray-100 px-3 py-3 transition-colors ${
        closed ? "bg-gray-50/60 opacity-70" : "hover:bg-brand-bg"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p
            className={`text-sm font-medium ${
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
            {item.document_id && ctx.docNames[item.document_id] && (
              <span className="flex items-center gap-1 text-[10px] text-gray-400">
                <FileText size={10} />
                {ctx.docNames[item.document_id]}
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => ctx.onDelete(item.id)}
          aria-label={`Delete finding: ${item.description}`}
          title="Delete finding"
          className="flex-shrink-0 rounded-lg p-1.5 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`status-${item.id}`}>
          Status for {item.description}
        </label>
        <select
          id={`status-${item.id}`}
          value={item.status}
          onChange={(e) =>
            ctx.onPatch(item.id, {
              status: e.target.value as InspectionItemStatus,
            })
          }
          className={SELECT_CLASS}
        >
          {INSPECTION_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={`owner-${item.id}`}>
          Owner for {item.description}
        </label>
        <select
          id={`owner-${item.id}`}
          value={item.owner}
          onChange={(e) =>
            ctx.onPatch(item.id, {
              owner: e.target.value as InspectionItemOwner,
            })
          }
          className={SELECT_CLASS}
        >
          {INSPECTION_ITEM_OWNERS.map((o) => (
            <option key={o} value={o}>
              {OWNER_LABEL[o]}
            </option>
          ))}
        </select>

        {!editingNotes && (
          <button
            onClick={() => setEditingNotes(true)}
            className="text-xs font-semibold text-gray-400 transition-colors hover:text-brand-navy"
          >
            {item.notes ? "Edit note" : "Add note"}
          </button>
        )}
      </div>

      {item.notes && !editingNotes && (
        <p className="mt-2 text-xs leading-relaxed text-gray-500">
          {item.notes}
        </p>
      )}

      {editingNotes && (
        <div className="mt-2 space-y-2">
          <label className="sr-only" htmlFor={`notes-${item.id}`}>
            Note for {item.description}
          </label>
          <textarea
            id={`notes-${item.id}`}
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={2}
            placeholder="Who was called, what was agreed, receipts…"
            className={INPUT_CLASS}
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                ctx.onPatch(item.id, { notes: notesDraft });
                setEditingNotes(false);
              }}
              className="rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-navy/90"
            >
              Save note
            </button>
            <button
              onClick={() => {
                setNotesDraft(item.notes ?? "");
                setEditingNotes(false);
              }}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-400 transition-colors hover:text-brand-navy"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab ─────────────────────────────────────────────────────────────────────

/**
 * Agent entry + work-through surface for inspection findings (#429, slice b).
 *
 * Its own tab rather than a card on Overview: a real report yields twenty to
 * sixty findings, each needing a status, an owner and a note — a list that long
 * with per-row controls would swamp the Overview summary cards. Tasks and
 * Vendors already establish "a per-deal working list gets a tab".
 *
 * Shown on every deal, not just Fast Pass ones with the inspection_followup
 * add-on: inspections happen on essentially every purchase, and gating the
 * agent's own workspace on a buyer's upsell would leave the other deals with
 * nowhere to track repairs. What the add-on buys is the buyer-facing view of
 * this data, which is slice (c).
 */
export function InspectionTab({ deal }: { deal: Deal }) {
  const dealId = deal.id;
  const { items, loading, error, addItem, updateItem, deleteItem } =
    useInspectionItems(dealId);
  const { docs } = useDocuments(dealId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(true);

  const summary = summarizeInspectionItems(items);
  const docNames: Record<string, string> = {};
  for (const d of docs) docNames[d.id] = d.name;

  async function run(fn: () => Promise<unknown>, what: string) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch {
      setActionError(`Couldn't ${what}. Check your connection and try again.`);
    } finally {
      setBusy(false);
    }
  }

  const rowCtx: RowCtx = {
    docNames,
    onPatch: (id, patch) => void run(() => updateItem(id, patch), "save that change"),
    onDelete: (id) => void run(() => deleteItem(id), "delete that item"),
  };

  const visible = showResolved
    ? items
    : items.filter((i) => !isClosedInspectionStatus(i.status));

  return (
    <div className="space-y-4">
      {/* Progress */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ClipboardList size={16} className="text-brand-navy" />
            <h2 className="text-sm font-bold text-brand-navy">
              Inspection follow-up
            </h2>
          </div>
          <span className="text-xs font-semibold text-gray-500">
            {summary.total === 0
              ? "No findings entered yet"
              : `${summary.closed} of ${summary.total} closed out`}
          </span>
        </div>
        {summary.total > 0 && (
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-green-500 transition-all"
              style={{
                width: `${Math.round((summary.closed / summary.total) * 100)}%`,
              }}
            />
          </div>
        )}
        {summary.total > 0 && (
          <label className="mt-3 flex items-center gap-2 text-xs text-gray-500">
            <input
              type="checkbox"
              checked={showResolved}
              onChange={(e) => setShowResolved(e.target.checked)}
              className="rounded border-gray-300"
            />
            Show closed-out items
          </label>
        )}
      </div>

      {actionError && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">{actionError}</p>
          <button
            onClick={() => setActionError(null)}
            aria-label="Dismiss error"
            className="flex-shrink-0 text-red-400 transition-colors hover:text-red-700"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <AddItemForm
        docs={docs.map((d) => ({ id: d.id, name: d.name }))}
        busy={busy}
        onAdd={(input) => void run(() => addItem(input), "add that item")}
      />

      {/* List */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        {loading ? (
          <p className="py-6 text-center text-sm text-gray-400">
            Loading findings…
          </p>
        ) : error ? (
          <p className="py-6 text-center text-sm text-gray-500">
            We couldn&apos;t load the inspection findings for this deal.
          </p>
        ) : items.length === 0 ? (
          <div className="py-8 text-center">
            <ClipboardList size={22} className="mx-auto text-gray-300" />
            <p className="mt-2 text-sm font-semibold text-brand-navy">
              Nothing tracked yet
            </p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-gray-400">
              Enter each finding from the inspection report above. Work them to
              Resolved or Waived and the buyer can see exactly what is left.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-400">
            Everything is closed out. Tick &ldquo;Show closed-out items&rdquo;
            to see them.
          </p>
        ) : (
          <div className="space-y-2">
            {visible.map((item) => (
              <InspectionRow key={item.id} item={item} ctx={rowCtx} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
