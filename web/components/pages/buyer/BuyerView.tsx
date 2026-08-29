"use client";

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { Deal, DealStage, Task } from "@/lib/types";
import { formatMoney } from "@/lib/deal-money";
import { STAGE_ORDER, openTaskCountsByStage } from "@/lib/stages";
import { useMyDeals } from "@/hooks/useMyDeals";
import { useTasks } from "@/hooks/useTasks";
import { useTaskCompletion } from "@/hooks/useTaskCompletion";
import { useMessages, postMessage } from "@/hooks/useMessages";
import {
  CheckCircle2, Circle, AlertCircle, Loader2,
  MapPin, Calendar, MessageSquare, FileText,
  ChevronRight, Phone, Mail, Home, Zap,
  ClipboardList, Building2, Star, ExternalLink,
  Plus, X, Link as LinkIcon, MessageCircle, Pencil, Send, Upload,
} from 'lucide-react';
import MetroMap from "@/components/MetroMap";
import VendorDirectory from "@/components/VendorDirectory";
import { useProperties, TrackedProperty, PropertyStatus } from "@/hooks/useProperties";
import { useMLSListings, MLSListing } from "@/hooks/useMLS";
import PortalDealDocuments from "@/components/portal/PortalDealDocuments";
import ClientIntakeCard from "@/components/portal/ClientIntakeCard";
import ClientPreferencesCard from "@/components/portal/ClientPreferencesCard";
// #422 — the orienting frame. The stage header answers "where am I" and "who
// moves this on"; PortalSection groups the cards under a heading that says
// whose job they are.
import PortalStageHeader from "@/components/portal/PortalStageHeader";
import PortalSection from "@/components/portal/PortalSection";
// #423 — inside the list: whose task is this, and when does it belong to. The
// decisions are pure functions in lib/portal-tasks; the read-only "handled for
// you" disclosure is shared with the seller portal.
import PortalHandledForYou from "@/components/portal/PortalHandledForYou";
import { groupTasksByStage, sortTasksByUrgency, stageGroupHeading } from "@/lib/portal-tasks";
import { useDocuments, getSigningUrl, requestUploadUrl, confirmUpload } from "@/hooks/useDocuments";
import { uploadFileToStorage } from "@/lib/direct-upload";
import ClientNotifications from "@/components/ClientNotifications";
import { useNotifications } from "@/hooks/useNotifications";
import { FAST_PASS_BASE_PRICE, FAST_PASS_UPSELLS, FastPassUpsellId } from "@/lib/fast-pass-display";
// #440 — the payment card prices every option through the SAME helper the
// /fastpass/pay route charges from, so the buyer is never shown a figure that
// differs from what Stripe takes. The +15% premium math stays in the catalog.
import {
  fastPassTotalForPaymentOption,
  type FastPassPaymentOptionId,
} from "@/lib/fast-pass-payment";
import { api } from "@/lib/api-client";
// #435 — the lender hand-off's URL and phone number live in ONE module so a
// lender swap is a one-line change, not a grep across the portal.
import {
  MOUNTAIN_MORTGAGE_APPLICATION_URL,
  MOUNTAIN_MORTGAGE_LOAN_OFFICER,
  MOUNTAIN_MORTGAGE_PHONE_DISPLAY,
  MOUNTAIN_MORTGAGE_PHONE_HREF,
} from "@/lib/lender";

// ─── Constants ────────────────────────────────────────────────────────────────

const BUYER_STAGE_LABELS: Record<DealStage, string> = {
  intake:         'Getting Started',
  active_search:  'Home Search',
  offer_active:   'Offer Submitted',
  under_contract: 'Under Contract',
  pre_close:      'Pre-Close',
  closing:        'Closing Day',
  post_close:     'Closed!',
};

/**
 * The pre-approval task's identity (#460), client-side.
 *
 * The server writes it as `source = 'preapproval'` (PRE_APPROVAL_TASK_SOURCE in
 * lib/stage-task-seed.ts — not imported here because that module pulls in
 * Prisma). Typed as `Task['source']`, so a typo is a compile error rather than
 * a card that silently never renders. Never match on the task's TITLE: #460
 * removed the copy from every structural position precisely so it could change.
 */
const PRE_APPROVAL_SOURCE: Task['source'] = 'preapproval';

const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  completed:   <CheckCircle2 size={18} className="text-green-500 flex-shrink-0" />,
  in_progress: <Loader2 size={18} className="text-blue-500 flex-shrink-0 animate-spin" />,
  overdue:     <AlertCircle size={18} className="text-red-500 flex-shrink-0" />,
  pending:     <Circle size={18} className="text-gray-300 flex-shrink-0" />,
  blocked:     <AlertCircle size={18} className="text-orange-400 flex-shrink-0" />,
};

// ─── Shared: Task card ────────────────────────────────────────────────────────

// `done` (#408) lets the caller override the server status: a task the buyer
// only just optimistically ticked is still `status: 'pending'` on the wire
// until the refetch lands, and one they just re-opened is still 'completed'.
function TaskCard({ task, done = false, onComplete, onUncomplete, onUploaded }: { task: Task; done?: boolean; onComplete?: (id: string) => void; onUncomplete?: (id: string) => void; onUploaded?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isOverdue = task.status === 'overdue';
  const isDone = done || task.status === 'completed';
  const actionType = task.actionType ?? 'confirm';
  // #423 — a card only opens when the panel behind it can actually do
  // something: an undo for a done card, a completion for an open one. Without
  // the handler it would expand onto a dead control, which is the same
  // "unexplained row that does nothing" this ticket exists to remove. Kept
  // character-for-character identical to SellerView's TaskCard so the rule
  // can't drift between the two portals.
  const canExpand = isDone ? !!onUncomplete : !!onComplete;

  function handleConfirm() {
    onComplete?.(task.id);
    setExpanded(false);
  }

  function handleReopen() {
    onUncomplete?.(task.id);
    setExpanded(false);
  }

  // Real presigned upload (same flow the agent Documents tab uses): request the
  // upload URLs, push the file to storage, then create the documents row so it
  // lands in the deal's Documents. No fake success — failures surface an inline
  // error. #189: when the server returns client_upload_url the bytes go
  // browser → Blob directly (a Vercel Function caps bodies at ~4.5MB, so
  // 4.5–25MB files can never pass through the proxy in prod).
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const mimeType = file.type || 'application/octet-stream';
      const { upload_url, client_upload_url, s3_key } = await requestUploadUrl(task.dealId, file.name, mimeType);
      const put = await uploadFileToStorage({
        uploadUrl: upload_url,
        clientUploadUrl: client_upload_url,
        key: s3_key,
        file,
        contentType: mimeType,
      });
      if (!put.ok) {
        setUploadError(put.tooLarge ? 'File too large (max 25MB). Upload failed.' : 'Upload failed. Please try again.');
        return;
      }
      await confirmUpload(task.dealId, file.name, s3_key, mimeType, file.size);
      setUploaded(true);
      // Surface the new doc in the Documents tab this session (invalidate the
      // ['documents', dealId] query useDocuments reads).
      onUploaded?.();
    } catch {
      setUploadError('Upload failed. Please try again.');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  return (
    <div className={`rounded-xl overflow-hidden transition-all ${
      isOverdue ? 'bg-red-50 border border-red-100' :
      isDone    ? 'bg-gray-50 border border-gray-100 opacity-60' :
      'bg-white border border-gray-100'
    }`}>
      {/* Header row */}
      {/* #408: a completed row is NOT disabled — it can be re-opened.
          `disabled={isDone}` made a mis-tapped "Yes, I'm done" permanent for
          the client, with no undo anywhere in the portal.

          #423: but the tap no longer re-opens it outright. #408 wired the undo
          to a single tap of the whole card while COMPLETING went through
          expand → "Yes, I'm done ✓" — so on a phone a stray thumb silently
          re-opened a task, and because open high-priority tasks gate the
          agent's forward advance that re-blocked a deal they had moved on
          from. Both directions now cost the same two deliberate taps; only the
          panel underneath differs. */}
      <button
        onClick={() => { if (canExpand) setExpanded((p) => !p); }}
        className="w-full text-left flex items-start gap-3 p-4 hover:bg-black/[0.02] transition-colors active:scale-[0.99]"
      >
        {isDone
          ? <CheckCircle2 size={18} className="text-green-500 flex-shrink-0" />
          : TASK_STATUS_ICON[task.status]}
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${isDone ? 'line-through text-gray-400' : 'text-brand-navy'}`}>
            {task.title}
          </p>
          {task.description && !isDone && (
            <p className="mt-0.5 text-xs text-gray-400 leading-relaxed">{task.description}</p>
          )}
          {task.dueDate && !isDone && (
            <p className={`mt-1 text-[11px] font-medium ${isOverdue ? 'text-red-500' : 'text-gray-400'}`}>
              {isOverdue ? 'Overdue — ' : 'Due '}
              {task.dueDate}
            </p>
          )}
          {isDone && (
            <p className="mt-0.5 text-[11px] text-green-600">
              Marked complete{onUncomplete ? ' — tap to re-open' : ''}
            </p>
          )}
        </div>
        {canExpand && (
          <ChevronRight size={14} className={`flex-shrink-0 text-gray-300 mt-0.5 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
        )}
      </button>

      {/* Re-open panel (#423) — the mirror image of the confirm panel below.
          It states the consequence, because re-opening is the destructive
          direction: the agent's deal picks the task back up as outstanding. */}
      {expanded && isDone && (
        <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-3 space-y-2">
          <p className="text-xs text-gray-500 leading-relaxed">
            Re-open this task? Your agent will see it as not done again.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleReopen}
              className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-xs font-bold text-brand-navy hover:bg-gray-50 transition-colors"
            >
              Yes, re-open
            </button>
            <button
              onClick={() => setExpanded(false)}
              className="rounded-lg bg-green-500 px-4 py-2.5 text-xs font-semibold text-white hover:bg-green-600 transition-colors"
            >
              Keep it done
            </button>
          </div>
        </div>
      )}

      {/* Action panel */}
      {expanded && !isDone && (
        <div className={`border-t px-4 py-3 space-y-2 ${isOverdue ? 'border-red-100 bg-red-50/40' : 'border-gray-100 bg-gray-50/60'}`}>

          {actionType === 'confirm' && (
            <>
              <p className="text-xs text-gray-500 leading-relaxed">Did you complete this outside the app?</p>
              <div className="flex gap-2">
                <button
                  onClick={handleConfirm}
                  className="flex-1 rounded-lg bg-green-500 py-2.5 text-xs font-bold text-white hover:bg-green-600 transition-colors"
                >
                  Yes, I&apos;m done ✓
                </button>
                <button
                  onClick={() => setExpanded(false)}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
                >
                  Not yet
                </button>
              </div>
            </>
          )}

          {actionType === 'upload' && (
            <>
              {!uploaded ? (
                <>
                  <p className="text-xs text-gray-500 leading-relaxed">Upload the document to complete this task.</p>
                  <label className={`flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed py-3 text-xs font-semibold transition-colors ${
                    uploading
                      ? 'border-blue-200 bg-blue-50 text-blue-400 pointer-events-none'
                      : 'border-gray-200 text-gray-400 hover:border-brand-navy/30 hover:text-brand-navy'
                  }`}>
                    {uploading
                      ? <><Loader2 size={13} className="animate-spin" /> Uploading…</>
                      : <><Upload size={13} /> Choose file to upload</>}
                    <input type="file" className="hidden" onChange={handleFileChange} disabled={uploading} />
                  </label>
                  {uploadError && (
                    <p role="alert" className="text-xs font-medium text-red-600">{uploadError}</p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-100 px-3 py-2">
                    <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
                    <p className="text-xs text-green-700 font-medium">File uploaded successfully</p>
                  </div>
                  <button
                    onClick={handleConfirm}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-green-500 py-2.5 text-xs font-bold text-white hover:bg-green-600 transition-colors"
                  >
                    Mark as complete ✓
                  </button>
                </>
              )}
              {!uploaded && (
                <button onClick={() => setExpanded(false)} className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors pt-0.5">
                  Close
                </button>
              )}
            </>
          )}

          {actionType === 'link' && (
            <>
              <p className="text-xs text-gray-500 leading-relaxed">Open the link to complete this task, then mark it done here.</p>
              {task.actionUrl && (
                <a
                  href={task.actionUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-navy py-2.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors"
                >
                  <ExternalLink size={12} /> Open Application →
                </a>
              )}
              <button
                onClick={handleConfirm}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-green-200 bg-green-50 py-2 text-xs font-bold text-green-700 hover:bg-green-100 transition-colors"
              >
                <CheckCircle2 size={12} /> I&apos;ve completed this
              </button>
              <button onClick={() => setExpanded(false)} className="w-full text-center text-xs text-gray-400 hover:text-gray-600 transition-colors pt-0.5">
                Close
              </button>
            </>
          )}

        </div>
      )}
    </div>
  );
}

// ─── Pre-approval task card (#435, FF12) ─────────────────────────────────────
//
// The buyer-facing half of the lender hand-off. #434/#460 create the task
// server-side when a Mountain Mortgage / Fast Pass buyer finishes onboarding;
// this is where they can actually act on it, at the top of the portal rather
// than as row four of the task list.
//
// Why this is not just `TaskCard` with `actionType: 'link'`: that branch exists
// (≈ 226) but nothing populates `actionType` — the wire contract in
// lib/schemas/task.ts has no `action_type`, and `apiTaskToFrontend` never sets
// one — so it is unreachable for a server task today. It also gives only the
// apply half, behind a tap-to-expand, with no way to call. The whole point of
// this ticket is that the ask is the first thing on the page with both actions
// already showing, so it is its own surface. Everything shared with the task
// list (title, description, completing it) still comes from the same task row.
//
// "I've already applied" (#437, FF14) is the third action. It posts to the
// participant-scoped POST /api/deals/[id]/pre-approval, which stamps
// `pre_approval_applied_at` and closes this task — and moves NO gate. The
// buyer's own word is worth clearing their to-do list; it is not worth
// unlocking "Make an Offer", which stays on `deals.pre_approved` and stays
// agent/admin-only server-side. Do not wire this button to the flags route.
function PreApprovalTaskCard({
  task,
  appliedAt,
  onApplied,
}: {
  task: Task;
  /** ISO timestamp from `deal.preApprovalAppliedAt`, or null/undefined. */
  appliedAt?: string | null;
  onApplied?: () => void;
}) {
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  // Optimistic, so the confirmation lands on the tap rather than a refetch
  // later. The card unmounts a moment afterwards anyway — the task it renders
  // is gone from `openTasks` — so this is only what they see in between.
  const [justApplied, setJustApplied] = useState(false);
  const applied = justApplied || !!appliedAt;

  async function handleApplied() {
    if (marking) return;
    setMarking(true);
    setMarkError(null);
    try {
      await api.post(`/deals/${task.dealId}/pre-approval`, {});
      setJustApplied(true);
      onApplied?.();
    } catch {
      setMarkError("Couldn't save that — please try again.");
    } finally {
      setMarking(false);
    }
  }

  return (
    <div
      data-testid="preapproval-card"
      className="overflow-hidden rounded-2xl border-2 border-amber-200 bg-white"
    >
      <div className="border-b border-amber-100 bg-amber-50 px-5 py-4">
        <div className="flex items-center gap-2">
          <AlertCircle size={15} className="text-amber-600" />
          {/* #460 left this task without the 'ai' source's "Auto" badge. It is
              not an AI suggestion, it is the one thing they have to do — so it
              gets this label instead of nothing. */}
          <span className="text-xs font-bold uppercase tracking-widest text-amber-600">
            Your next step
          </span>
        </div>
        <p className="mt-1.5 text-sm font-black text-brand-navy">{task.title}</p>
        {/* `||`, not `??`: an empty-string description survives the wire mapping
            as "" and would otherwise render an empty paragraph. */}
        <p className="mt-1 text-sm leading-relaxed text-amber-900/80">
          {task.description ||
            'Your pre-approval tells you exactly what you can spend — and lets you make an offer the moment you find the right home.'}
        </p>
      </div>

      <div className="space-y-2 px-5 py-4">
        <a
          href={MOUNTAIN_MORTGAGE_APPLICATION_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-3.5 text-sm font-bold text-white transition-colors hover:bg-brand-navy/90 active:scale-[0.99]"
        >
          <ExternalLink size={14} /> Start my application
        </a>
        <a
          href={MOUNTAIN_MORTGAGE_PHONE_HREF}
          className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-brand-navy py-3.5 text-sm font-bold text-brand-navy transition-colors hover:bg-brand-navy/5 active:scale-[0.99]"
        >
          <Phone size={14} /> Call {MOUNTAIN_MORTGAGE_LOAN_OFFICER} · {MOUNTAIN_MORTGAGE_PHONE_DISPLAY}
        </a>
        {/* The 1003 prefills nothing (#431) — say so rather than let them find
            out after they've clicked. */}
        <p className="pt-0.5 text-center text-[11px] leading-relaxed text-gray-400">
          Takes about 10 minutes. You&apos;ll re-enter a few basics — the application is
          your lender&apos;s, not ours.
        </p>

        {/* #437 — the way out for someone who already did this elsewhere (on
            the phone with Paul, or with a lender before they ever signed up).
            Deliberately the quietest control on the card: applying is the ask,
            this is the exception. */}
        <div className="border-t border-gray-100 pt-3">
          {applied ? (
            <p
              data-testid="preapproval-applied"
              className="flex items-center justify-center gap-1.5 text-center text-xs font-semibold text-green-700"
            >
              <CheckCircle2 size={13} />
              Thanks — we&apos;ve told your agent you applied
            </p>
          ) : (
            <>
              <button
                type="button"
                data-testid="preapproval-mark-applied"
                onClick={handleApplied}
                disabled={marking}
                // A real border and a 44px-tall target: at 375px this had no
                // hover state to lean on and read as a line of grey text
                // rather than something to tap. Still the quietest control on
                // the card — outlined grey against two filled navy CTAs.
                className="min-h-11 w-full rounded-xl border border-gray-200 px-3 py-3 text-center text-xs font-bold text-gray-500 transition-colors hover:bg-gray-50 hover:text-brand-navy active:scale-[0.99] disabled:opacity-50"
              >
                {marking ? 'Saving…' : "I've already applied"}
              </button>
              {markError && (
                <p role="alert" className="mt-1 text-center text-[11px] font-medium text-red-600">
                  {markError}
                </p>
              )}
            </>
          )}
          {/* Says out loud what the button does and does not do, so nobody
              reads it as "and now I can make offers". */}
          <p className="mt-1 text-center text-[11px] leading-relaxed text-gray-400">
            Your agent confirms your pre-approval once the letter is in — that&apos;s what
            unlocks making an offer.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Shared: Tab bar ──────────────────────────────────────────────────────────

type Tab = 'tasks' | 'messages' | 'documents';

function TabBar({ active, onChange, taskCount, msgCount }: {
  active: Tab; onChange: (t: Tab) => void; taskCount: number; msgCount: number;
}) {
  const tabs: { id: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: 'tasks',     label: 'Tasks',     icon: CheckCircle2, count: taskCount },
    { id: 'messages',  label: 'Messages',  icon: MessageSquare, count: msgCount },
    { id: 'documents', label: 'Documents', icon: FileText },
  ];
  return (
    <div className="flex gap-1 rounded-xl bg-white p-1 shadow-sm">
      {tabs.map(({ id, label, icon: Icon, count }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={[
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-sm font-semibold transition-colors',
            active === id ? 'bg-brand-navy text-white shadow-sm' : 'text-gray-400 hover:bg-gray-50',
          ].join(' ')}
        >
          <Icon size={14} />
          {label}
          {count !== undefined && count > 0 && (
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none ${
              active === id ? 'bg-white/20 text-white' : 'bg-brand-navy/10 text-brand-navy'
            }`}>{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Shared: Messages tab ─────────────────────────────────────────────────────

function MessagesTab({ dealId }: { dealId: string }) {
  const { messages, loading, refresh } = useMessages(dealId, 'client_thread');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSend() {
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await postMessage(dealId, 'client_thread', draft.trim());
      setDraft('');
      await refresh();
    } catch {}
    setSending(false);
  }

  return (
    <div className="space-y-3">
      {!loading && messages.length === 0 && (
        <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
          <MessageSquare size={28} className="mx-auto mb-2 text-gray-200" />
          <p className="text-sm text-gray-400">No messages yet</p>
        </div>
      )}
      {messages.map((msg) => {
        const isAgent = msg.senderRole === 'agent';
        return (
          <div key={msg.id} className={`flex gap-2.5 ${isAgent ? '' : 'flex-row-reverse'}`}>
            <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-white text-xs font-bold ${
              isAgent ? 'bg-brand-navy' : 'bg-green-500'
            }`}>
              {msg.senderName.charAt(0)}
            </div>
            <div className={`max-w-[78%] lg:max-w-md flex flex-col gap-1 ${isAgent ? 'items-start' : 'items-end'}`}>
              <div className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                isAgent ? 'bg-gray-100 text-gray-800 rounded-tl-sm' : 'bg-brand-navy text-white rounded-tr-sm'
              }`}>{msg.content}</div>
              <span className="text-[10px] text-gray-300">
                {new Date(msg.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            </div>
          </div>
        );
      })}
      <div className="pt-1 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          placeholder="Message your agent…"
          className="flex-1 rounded-full border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
        />
        <button
          onClick={handleSend}
          disabled={!draft.trim() || sending}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-brand-navy text-white hover:bg-brand-navy/80 transition-colors disabled:opacity-50"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}

// ─── Shared: Agent card ───────────────────────────────────────────────────────

function AgentCard({ compact = false, agentName, agentEmail, agentPhone }: {
  compact?: boolean;
  agentName: string;
  agentEmail: string;
  agentPhone: string | null;
}) {
  const initials = agentName.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="rounded-2xl bg-brand-navy p-5 text-white">
      <p className="mb-3 text-xs font-bold uppercase tracking-widest text-white/50">Your Agent</p>
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-gold/20 ring-2 ring-brand-gold/40 text-brand-gold font-bold text-sm flex-shrink-0">
          {initials}
        </div>
        <div>
          <p className="font-bold text-white">{agentName}</p>
          <p className="text-xs text-white/60">RealTour Flow Agent</p>
        </div>
      </div>
      {!compact && (
        <div className="space-y-2">
          {agentPhone && (
            <a href={`tel:${agentPhone}`} className="flex items-center gap-2.5 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20 transition-colors">
              <Phone size={14} /> {agentPhone}
            </a>
          )}
          <a href={`mailto:${agentEmail}`} className="flex items-center gap-2.5 rounded-lg bg-white/10 px-3 py-2 text-sm text-white/80 hover:bg-white/20 transition-colors">
            <Mail size={14} /> {agentEmail}
          </a>
        </div>
      )}
    </div>
  );
}

// ─── Journey tracker ──────────────────────────────────────────────────────────

const STAGE_DESCRIPTIONS: Record<DealStage, string> = {
  intake:         'Getting your file set up with your agent.',
  active_search:  'Finding homes that match your wish list.',
  offer_active:   'Offer submitted — waiting on the seller.',
  under_contract: 'Under contract and working through the details.',
  pre_close:      'Final checks before closing day.',
  closing:        'Signing day is here!',
  post_close:     'Keys are yours. Welcome home!',
};

/**
 * #422 — how the stage's own cards are introduced.
 *
 * The portal used to drop `UnderContractCard`, `ClosingCard` and friends onto
 * the page unannounced, so a first-time reader had no way to tell a card they
 * were supposed to act on from one that was just telling them something. Each
 * stage now gets a heading and one line saying who is driving it.
 *
 * Deliberately kept separate from STAGE_DESCRIPTIONS above: that one describes
 * the *stage* ("where am I", in the header at the top of the page); this one
 * describes the *cards underneath it* ("who owns this work").
 */
const STAGE_FOCUS: Record<DealStage, { title: string; blurb: string }> = {
  intake: {
    // NOT "Getting started": the stage header above and the intake card below
    // both already carry that label, and three of them in a row read as a bug.
    title: 'Your first step',
    blurb: "Answer a few questions about what you're looking for. Your agent sets everything else up from your answers.",
  },
  active_search: {
    title: 'Your home search',
    blurb: 'Track the homes you like and tell your agent which ones to pursue — they book the showings and write the offers.',
  },
  offer_active: {
    title: 'Your offer',
    blurb: "Your agent is negotiating with the seller's side. Nothing here needs you — just stay reachable.",
  },
  under_contract: {
    title: 'Your transaction',
    blurb: 'Your agent, lender and inspector are working through the contract steps. Anything that needs you shows up in your to-do list.',
  },
  pre_close: {
    title: 'Getting to the closing table',
    blurb: 'Your agent is booking the walkthrough and checking the final numbers with the title company.',
  },
  closing: {
    title: 'Closing day',
    blurb: "Here's what to bring. Your agent meets you at the table.",
  },
  post_close: {
    title: 'After closing',
    blurb: 'The deal is done. These are the loose ends you can tie up whenever suits you.',
  },
};

/**
 * #420 — a walked-past stage is not a finished stage.
 *
 * This rail checked every earlier stage off purely on position, so advancing a
 * deal retroactively told the buyer that work they had never done was done.
 * A past stage with the buyer's own tasks still open now gets an open circle
 * and an honest count instead of a green check.
 *
 * `openTasks` is the buyer's OWN open tasks (agent/TC work is deliberately not
 * counted — the buyer can't action it and shouldn't be shown a number they
 * can't move).
 */
function JourneyTracker({ deal, openTasks = [] }: { deal: Deal; openTasks?: Task[] }) {
  const currentIdx = STAGE_ORDER.indexOf(deal.stage);
  const openByStage = openTaskCountsByStage(openTasks);

  return (
    <div className="rounded-2xl overflow-hidden shadow-sm bg-white">
      {STAGE_ORDER.map((stage, i) => {
        const isPast     = i < currentIdx;
        const isCurrent  = i === currentIdx;

        if (isCurrent) {
          return (
            <div key={stage} data-testid={`stage-row-${stage}`} data-stage-state="current" className="px-5 py-4 bg-brand-navy">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand-gold">
                    <div className="h-2.5 w-2.5 rounded-full bg-brand-navy" />
                  </div>
                  <span className="text-base font-black text-white">{BUYER_STAGE_LABELS[stage]}</span>
                </div>
                <span className="flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide bg-brand-gold/20 text-brand-gold">
                  You&apos;re here
                </span>
              </div>
              <p className="mt-1.5 ml-[38px] text-xs text-white/60 leading-relaxed">
                {STAGE_DESCRIPTIONS[stage]}
              </p>
            </div>
          );
        }

        if (isPast) {
          const stillOpen = openByStage[stage] ?? 0;

          if (stillOpen > 0) {
            return (
              <div
                key={stage}
                data-testid={`stage-row-${stage}`}
                data-stage-state="open"
                className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50"
              >
                <Circle size={13} className="text-amber-400 flex-shrink-0" />
                <span className="text-xs font-medium text-amber-700">{BUYER_STAGE_LABELS[stage]}</span>
                <span className="ml-auto flex-shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                  {stillOpen} task{stillOpen !== 1 ? 's' : ''} open
                </span>
              </div>
            );
          }

          return (
            <div
              key={stage}
              data-testid={`stage-row-${stage}`}
              data-stage-state="complete"
              className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50"
            >
              <CheckCircle2 size={13} className="text-green-400 flex-shrink-0" />
              <span className="text-xs font-medium text-green-600">{BUYER_STAGE_LABELS[stage]}</span>
            </div>
          );
        }

        return (
          <div
            key={stage}
            data-testid={`stage-row-${stage}`}
            data-stage-state="upcoming"
            className="flex items-center gap-3 px-5 py-2 border-b border-gray-50 last:border-0"
          >
            <Circle size={11} className="text-gray-200 flex-shrink-0" />
            <span className="text-xs text-gray-300">{BUYER_STAGE_LABELS[stage]}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Stage-specific cards ─────────────────────────────────────────────────────

// #407 — the onboarding card now lives in components/portal/ClientIntakeCard so
// the buyer and seller portals share one rule: a client with an intake already
// on file is never asked to do the onboarding again, whatever stage the deal is
// parked in.
function IntakeCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  return (
    <ClientIntakeCard
      role="buyer"
      firstName={firstName}
      intakeSubmitted={deal.intakeSubmitted}
      onboardHref={`/onboard/buyer?agent=${deal.agentId}`}
    />
  );
}

const STATUS_CONFIG: Record<PropertyStatus, { label: string; style: string; next: PropertyStatus }> = {
  interested:       { label: 'Interested',       style: 'bg-blue-100 text-blue-700',    next: 'toured' },
  toured:           { label: 'Toured',           style: 'bg-purple-100 text-purple-700', next: 'not_for_me' },
  not_for_me:       { label: 'Not for me',       style: 'bg-gray-100 text-gray-400',    next: 'interested' },
  offer_submitted:  { label: 'Offer submitted',  style: 'bg-green-100 text-green-700',  next: 'offer_submitted' },
};

function PropertyCard({ property, onStatusChange, onRemove, onBuyerNote, onOfferRequest, canOffer = true }: {
  property: TrackedProperty;
  onStatusChange: (status: PropertyStatus) => void;
  onRemove: () => void;
  onBuyerNote: (note: string) => void;
  onOfferRequest: () => Promise<void>;
  canOffer?: boolean;
}) {
  const [imgError, setImgError] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDraft, setReviewDraft] = useState(property.buyerNote ?? '');
  const [offerSent, setOfferSent] = useState(property.offerRequested ?? false);
  const [offerSending, setOfferSending] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);

  const cfg = STATUS_CONFIG[property.status];
  const dimmed = property.status === 'not_for_me';
  const showReviewPrompt = property.status === 'toured' && !property.buyerNote && !reviewOpen;
  // Buyers can only remove their own additions — the agent's picks stay
  // (the server enforces this too; cycle to "Not for me" to pass on a pick).
  const canRemove = property.addedBy !== 'agent';

  function submitReview() {
    const note = reviewDraft.trim();
    if (!note) return;
    onBuyerNote(note);
    setReviewOpen(false);
  }

  // No fake success (#168): the confirmation only renders after the API call
  // actually resolves; a failure surfaces a real inline error.
  async function handleOfferRequest() {
    setOfferError(null);
    setOfferSending(true);
    try {
      await onOfferRequest();
      setOfferSent(true);
    } catch {
      setOfferError("Couldn't send your offer request — please try again.");
    } finally {
      setOfferSending(false);
    }
  }

  return (
    <div className={`rounded-xl border bg-white overflow-hidden transition-all ${dimmed ? 'opacity-50 border-gray-100' : 'border-gray-200 shadow-sm'}`}>
      <div className="flex gap-3 p-3">
        {/* Thumbnail */}
        <div className="h-20 w-24 lg:h-24 lg:w-32 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
          {property.thumbnailUrl && !imgError ? (
            <Image
              src={property.thumbnailUrl}
              alt={property.address}
              width={96}
              height={80}
              unoptimized
              className="h-full w-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Home size={22} className="text-gray-300" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-1">
            <div className="min-w-0">
              <p className="text-sm font-bold text-brand-navy leading-tight truncate">{property.address}</p>
              <p className="text-xs text-gray-400">{property.city}{property.state ? `, ${property.state}` : ''}</p>
            </div>
            {canRemove && (
              <button onClick={onRemove} aria-label="Remove property" className="flex-shrink-0 text-gray-300 hover:text-gray-500 transition-colors mt-0.5">
                <X size={13} />
              </button>
            )}
          </div>

          {property.price > 0 && (
            <p className="mt-0.5 text-sm font-black text-brand-navy">${property.price.toLocaleString()}</p>
          )}

          {(property.beds > 0 || property.sqft > 0) && (
            <p className="text-xs text-gray-400">
              {property.beds > 0 && `${property.beds} bd · ${property.baths} ba`}
              {property.sqft > 0 && ` · ${property.sqft.toLocaleString()} sqft`}
            </p>
          )}

          {/* Agent note */}
          {property.addedBy === 'agent' && property.agentNote && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-brand-navy/5 px-2 py-1.5">
              <Star size={10} className="text-brand-gold flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-brand-navy/80 leading-snug">{property.agentNote}</p>
            </div>
          )}
          {property.addedBy === 'agent' && !property.agentNote && (
            <span className="mt-1 inline-block text-[10px] font-bold uppercase tracking-wide text-brand-gold">Agent&apos;s pick</span>
          )}

          {/* Buyer's own note (after review) */}
          {property.buyerNote && !reviewOpen && (
            <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-purple-50 px-2 py-1.5">
              <MessageCircle size={10} className="text-purple-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-purple-700 leading-snug flex-1">{property.buyerNote}</p>
              <button onClick={() => { setReviewDraft(property.buyerNote ?? ''); setReviewOpen(true); }}
                className="flex-shrink-0 text-gray-300 hover:text-purple-400 transition-colors">
                <Pencil size={10} />
              </button>
            </div>
          )}

          {/* Status + external link row */}
          <div className="mt-2 flex items-center gap-2">
            {property.status !== 'offer_submitted' ? (
              <button
                onClick={() => onStatusChange(cfg.next)}
                className={`rounded-full px-2.5 py-0.5 text-xs font-bold transition-all hover:opacity-80 ${cfg.style}`}
              >
                {cfg.label} ↻
              </button>
            ) : (
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${cfg.style}`}>{cfg.label}</span>
            )}
            {property.sourceUrl && (
              <a href={property.sourceUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-navy transition-colors">
                <ExternalLink size={11} /> View listing
              </a>
            )}
          </div>

          {/* Make an Offer button */}
          {property.status !== 'not_for_me' && (
            <div className="mt-2">
              {!canOffer ? (
                <div className="flex items-center gap-1.5 rounded-lg border border-dashed border-gray-200 bg-gray-50 px-3 py-2">
                  <AlertCircle size={11} className="text-gray-300 flex-shrink-0" />
                  <p className="text-xs text-gray-400">Pre-approval required to make an offer</p>
                </div>
              ) : offerSent ? (
                <div className="flex items-center gap-1.5 rounded-lg bg-green-50 border border-green-100 px-3 py-2">
                  <CheckCircle2 size={13} className="text-green-500 flex-shrink-0" />
                  <p className="text-xs text-green-700 leading-snug">
                    Your agent has been notified. They&apos;ll reach out to discuss details.
                  </p>
                </div>
              ) : (
                <>
                  <button
                    onClick={handleOfferRequest}
                    disabled={offerSending}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-gold/90 py-2 text-xs font-bold text-brand-navy hover:bg-brand-gold transition-colors disabled:opacity-50"
                  >
                    <Send size={11} /> {offerSending ? 'Sending…' : 'Make an Offer'}
                  </button>
                  {offerError && (
                    <p className="mt-1.5 text-[11px] font-medium text-red-500">{offerError}</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Review prompt — inline below card body */}
      {showReviewPrompt && (
        <div className="border-t border-purple-100 bg-purple-50/60 px-3 py-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <MessageCircle size={13} className="text-purple-400 flex-shrink-0" />
            <p className="text-xs font-medium text-purple-700">How did it go? Share your thoughts on this home.</p>
          </div>
          <button
            onClick={() => setReviewOpen(true)}
            className="flex-shrink-0 rounded-lg bg-purple-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-600 transition-colors"
          >
            Add thoughts
          </button>
        </div>
      )}

      {/* Review input */}
      {reviewOpen && (
        <div className="border-t border-purple-100 bg-purple-50/60 px-3 py-3 space-y-2">
          <p className="text-xs font-bold text-purple-700">Your thoughts on {property.address}</p>
          <textarea
            autoFocus
            value={reviewDraft}
            onChange={(e) => setReviewDraft(e.target.value)}
            placeholder="What did you think? Layout, neighborhood, deal-breakers…"
            rows={3}
            className="w-full rounded-lg border border-purple-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-purple-400 resize-none leading-relaxed"
          />
          <div className="flex gap-2">
            <button
              onClick={submitReview}
              disabled={!reviewDraft.trim()}
              className="flex-1 rounded-lg bg-purple-500 py-2 text-xs font-bold text-white disabled:opacity-40 hover:bg-purple-600 transition-colors"
            >
              Save thoughts
            </button>
            <button
              onClick={() => { setReviewOpen(false); setReviewDraft(property.buyerNote ?? ''); }}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-500 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MLS Browser ─────────────────────────────────────────────────────────────

function MLSListingCard({ listing, onAdd }: { listing: MLSListing; onAdd: (l: MLSListing) => void }) {
  const photo = listing.photos?.[0];
  const price = listing.listPrice > 0
    ? `$${listing.listPrice.toLocaleString()}`
    : 'Price unavailable';
  const beds = listing.property.bedrooms;
  const baths = listing.property.bathsFull;
  const sqft = listing.property.area > 0 ? Math.round(listing.property.area).toLocaleString() : null;
  const dom = listing.mls.daysOnMarket;

  return (
    <div className="rounded-xl border border-gray-100 bg-white overflow-hidden shadow-sm">
      {photo ? (
        <Image src={photo} alt={listing.address.full} width={400} height={144} unoptimized className="w-full h-36 object-cover" />
      ) : (
        <div className="w-full h-36 bg-gray-100 flex items-center justify-center">
          <Home size={24} className="text-gray-300" />
        </div>
      )}
      <div className="p-3">
        <div className="flex items-start justify-between gap-1">
          <div>
            <p className="font-black text-brand-navy text-sm leading-tight">{price}</p>
            <p className="text-xs text-gray-500 mt-0.5 leading-tight truncate">{listing.address.full}</p>
            <p className="text-xs text-gray-400">{listing.address.city}, {listing.address.state}</p>
          </div>
          {dom <= 7 && (
            <span className="flex-shrink-0 rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-bold text-green-700 uppercase">
              New
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-2 text-[11px] text-gray-500">
          {beds > 0 && <span>{beds} bd</span>}
          {baths > 0 && <span>· {baths} ba</span>}
          {sqft && <span>· {sqft} sqft</span>}
          <span className="ml-auto text-gray-300">{dom}d</span>
        </div>
        <button
          onClick={() => onAdd(listing)}
          className="mt-2 w-full rounded-lg bg-brand-navy/5 py-1.5 text-xs font-semibold text-brand-navy hover:bg-brand-navy/10 transition-colors"
        >
          + Add to my list
        </button>
      </div>
    </div>
  );
}

function MLSBrowser({ deal, onAddProperty }: {
  deal: Deal;
  onAddProperty: (address: string, city: string, price: number, sourceUrl?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [cityInput, setCityInput] = useState(deal.property.city ?? '');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minBeds, setMinBeds] = useState('');
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());
  const [addError, setAddError] = useState<string | null>(null);
  const { listings, loading, error, errorKind, search } = useMLSListings(deal.id);

  // #428 — the portal now knows up front whether the agent has MLS wired up
  // (`agent_mls_connected` on /api/me/deals), so a buyer is never invited to
  // fill in a search that is guaranteed to fail.
  //
  // Only an explicit `false` closes the form. `undefined` means the payload
  // didn't carry the flag — an older cached response — and fails OPEN to the
  // live form, exactly as this behaved before. The server-side 503 in
  // /deals/:id/listings/search is still the real enforcement; this is UX.
  const notConnected = deal.agentMlsConnected === false;

  function handleSearch() {
    search({
      cities: cityInput.trim() ? [cityInput.trim()] : undefined,
      minPrice: minPrice ? parseInt(minPrice.replace(/\D/g, ''), 10) : undefined,
      maxPrice: maxPrice ? parseInt(maxPrice.replace(/\D/g, ''), 10) : undefined,
      minBeds: minBeds ? parseInt(minBeds, 10) : undefined,
    });
  }

  // The "Added" chip only appears once the API call actually succeeds (#168).
  async function handleAdd(l: MLSListing) {
    setAddError(null);
    try {
      await onAddProperty(l.address.full, l.address.city, l.listPrice);
      setAddedIds((prev) => new Set(prev).add(l.mlsId));
    } catch {
      setAddError("Couldn't add that listing — please try again.");
    }
  }

  return (
    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3"
      >
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-brand-navy" />
          <span className="text-sm font-bold text-brand-navy">Browse live MLS listings</span>
        </div>
        <span className="text-xs text-gray-400">{open ? '▲' : '▼'}</span>
      </button>

      {/*
        Not connected (#428): explain it, don't render a form. No inputs and no
        Search button, so there is no wall left to walk into. This is the
        "waiting on a person" state — distinct from the outage copy below.
      */}
      {open && notConnected && (
        <div
          data-testid="mls-not-connected"
          className="border-t border-gray-50 px-4 pb-4 pt-3"
        >
          <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-3 py-4 text-center">
            <Building2 size={20} className="mx-auto text-gray-300" />
            <p className="mt-2 text-xs font-bold text-gray-600">
              Your agent hasn&apos;t connected their MLS yet.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">
              We&apos;ve prompted them to connect it. Live listings will show up here
              as soon as they do.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-gray-400">
              In the meantime you can still track any home you find — use
              <span className="font-semibold"> Add a property</span> above.
            </p>
          </div>
        </div>
      )}

      {open && !notConnected && (
        <div className="border-t border-gray-50 px-4 pb-4">
          {/* Search filters */}
          <div className="pt-3 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                value={cityInput}
                onChange={(e) => setCityInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="City"
                className="col-span-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30"
              />
              <input
                value={minPrice}
                onChange={(e) => setMinPrice(e.target.value)}
                placeholder="Min price"
                className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30"
              />
              <input
                value={maxPrice}
                onChange={(e) => setMaxPrice(e.target.value)}
                placeholder="Max price"
                className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30"
              />
              <select
                value={minBeds}
                onChange={(e) => setMinBeds(e.target.value)}
                className="col-span-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30"
              >
                <option value="">Any bedrooms</option>
                <option value="1">1+ bed</option>
                <option value="2">2+ beds</option>
                <option value="3">3+ beds</option>
                <option value="4">4+ beds</option>
              </select>
            </div>
            <button
              onClick={handleSearch}
              disabled={loading}
              className="w-full rounded-lg bg-brand-navy py-2 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-50"
            >
              {loading ? 'Searching…' : 'Search listings'}
            </button>
          </div>

          {/*
            The search still failed, so say WHY — and keep the two causes apart
            (#428, guarding closed #309). `errorKind` is classified from the
            HTTP status in useMLSListings; the old check compared `error` to the
            bare server string, which an ApiError message never equals.
          */}

          {/* Waiting on a person: the agent disconnected mid-session. */}
          {errorKind === 'not_connected' && (
            <p className="mt-3 text-xs text-amber-600">
              Your agent hasn&apos;t connected their MLS yet.
            </p>
          )}

          {/* Waiting on a service: their credentials are fine, retrying may work. */}
          {errorKind === 'unavailable' && (
            <p data-testid="mls-unavailable" className="mt-3 text-xs text-amber-600">
              We couldn&apos;t reach the MLS just now — this is on our end, not your
              agent&apos;s. Please try that search again in a moment.
            </p>
          )}

          {errorKind === 'other' && (
            <p className="mt-3 text-xs text-red-500">{error}</p>
          )}

          {addError && (
            <p className="mt-3 text-xs text-red-500">{addError}</p>
          )}

          {listings.length > 0 && (
            <div className="mt-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">
                {listings.length} listing{listings.length !== 1 ? 's' : ''} found
              </p>
              <div className="grid grid-cols-2 gap-3">
                {listings.map((l) => (
                  addedIds.has(l.mlsId) ? (
                    <div key={l.mlsId} className="rounded-xl border border-green-200 bg-green-50 p-3 flex items-center justify-center">
                      <span className="flex items-center gap-1 text-xs font-semibold text-green-700">
                        <CheckCircle2 size={13} /> Added
                      </span>
                    </div>
                  ) : (
                    <MLSListingCard key={l.mlsId} listing={l} onAdd={handleAdd} />
                  )
                ))}
              </div>
            </div>
          )}

          {!loading && !error && listings.length === 0 && (
            <p className="mt-3 text-center text-xs text-gray-300">Search above to see live listings</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Active Search Card ───────────────────────────────────────────────────────

// `lenderCtaHandledAbove` (#435): the pre-approval card at the top of the
// portal already offers Apply + Call. When it is on screen this banner drops
// its own copy of those two buttons rather than showing the buyer the same
// pair twice. Everything else here — the gate copy, the BAA prompts, the
// outside-lender letter upload — is untouched.
function ActiveSearchCard({ deal, lenderCtaHandledAbove = false }: { deal: Deal; lenderCtaHandledAbove?: boolean }) {
  const queryClient = useQueryClient();
  const { properties, addProperty, updateStatus, removeProperty, updateBuyerNote, setOfferRequested } = useProperties(deal.id);
  const preApproved = deal.preApproved ?? false;
  // #409 — a cash buyer has no lender and can never satisfy a pre-approval, so
  // the gate must not apply to them. Derived server-side from their onboarding
  // answer; anything other than an explicit 'cash' leaves the gate exactly as
  // it was (an unknown financing type is NOT an unlock).
  const isCashBuyer = deal.financingType === 'cash';
  const canOffer = preApproved || isCashBuyer;
  const baaSigned = deal.baaSigned ?? false;
  // The BAA is a real DocuSign envelope now (Stage 1: signed via the secure
  // email link; deals.baa_signed flips when the envelope completes). The
  // portal just reflects where it stands.
  const { docs: dealDocs } = useDocuments(deal.id);
  const baaDoc = dealDocs.find(
    (d) =>
      d.purpose === 'baa' &&
      !['completed', 'voided', 'declined'].includes(d.docusignStatus ?? ''),
  );
  const baaPending = !!baaDoc;
  // Stage 2: portal buyers sign embedded — straight into DocuSign from here.
  const baaSignable = !!baaDoc?.myRecipientStatus &&
    ['sent', 'delivered'].includes(baaDoc.myRecipientStatus);
  const [baaSigning, setBaaSigning] = useState(false);
  async function handleSignBaa() {
    if (!baaDoc) return;
    setBaaSigning(true);
    try {
      const url = await getSigningUrl(deal.id, baaDoc.id);
      window.location.assign(url);
    } catch {
      setBaaSigning(false);
    }
  }

  const isMountainMortgage = deal.flags.includes('mountain_mortgage');

  const [showForm, setShowForm] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [addressInput, setAddressInput] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  // Real errors, not fake success (#168): failed writes used to be swallowed
  // with .catch(() => {}) while the UI reported success.
  const [actionError, setActionError] = useState<string | null>(null);

  function runAction(promise: Promise<unknown>) {
    setActionError(null);
    promise.catch(() =>
      setActionError("Couldn't update your home search — please try again.")
    );
  }

  async function handleAdd() {
    const addr = addressInput.trim() || (urlInput.trim() ? 'Property from link' : '');
    if (!addr) return;
    setAddError(null);
    try {
      await addProperty({
        dealId: deal.id,
        address: addr,
        city: '', state: '',
        price: priceInput ? parseInt(priceInput.replace(/\D/g, ''), 10) : 0,
        beds: 0, baths: 0, sqft: 0,
        thumbnailUrl: '',
        sourceUrl: urlInput.trim(),
        status: 'interested',
        addedBy: 'buyer',
      });
      setUrlInput(''); setAddressInput(''); setPriceInput('');
      setShowForm(false);
    } catch {
      // Keep the form (and what they typed) so they can retry.
      setAddError("Couldn't add that property — please try again.");
    }
  }

  // Pre-approval letter CTAs (#266) — outside-lender buyers. These used to be
  // empty no-ops. The upload button now runs the SAME presigned flow the
  // TaskCard uploads use (request URL → push bytes → confirm the documents
  // row); the "send later" button posts a real client_thread message to the
  // agent. Neither flips pre_approved — that stays agent-set server-side.
  const preApprovalFileRef = useRef<HTMLInputElement>(null);
  const [uploadingLetter, setUploadingLetter] = useState(false);
  const [letterUploaded, setLetterUploaded] = useState(false);
  const [letterError, setLetterError] = useState<string | null>(null);
  const [sendingLater, setSendingLater] = useState(false);
  const [letterLaterSent, setLetterLaterSent] = useState(false);
  const [letterLaterError, setLetterLaterError] = useState<string | null>(null);

  function handleUploadLetter() {
    preApprovalFileRef.current?.click();
  }

  async function handleLetterFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingLetter(true);
    setLetterError(null);
    try {
      const mimeType = file.type || 'application/octet-stream';
      const { upload_url, client_upload_url, s3_key } = await requestUploadUrl(deal.id, file.name, mimeType);
      const put = await uploadFileToStorage({
        uploadUrl: upload_url,
        clientUploadUrl: client_upload_url,
        key: s3_key,
        file,
        contentType: mimeType,
      });
      if (!put.ok) {
        setLetterError(put.tooLarge ? 'File too large (max 25MB). Upload failed.' : 'Upload failed. Please try again.');
        return;
      }
      await confirmUpload(deal.id, file.name, s3_key, mimeType, file.size);
      setLetterUploaded(true);
      // Surface the new doc in the Documents tab this session.
      void queryClient.invalidateQueries({ queryKey: ['documents', deal.id] });
    } catch {
      setLetterError('Upload failed. Please try again.');
    } finally {
      setUploadingLetter(false);
      e.target.value = '';
    }
  }

  async function handleLetterLater() {
    if (sendingLater) return;
    setSendingLater(true);
    setLetterLaterError(null);
    try {
      await postMessage(
        deal.id,
        'client_thread',
        "I have a pre-approval letter — I'll send it over.",
      );
      setLetterLaterSent(true);
    } catch {
      setLetterLaterError("Couldn't reach your agent — please try again.");
    } finally {
      setSendingLater(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* Header + add form */}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-4">
        <div className="mb-3">
          <h3 className="text-base font-black text-brand-navy">Your Home Search</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            {properties.length === 0
              ? 'No properties tracked yet'
              : `${properties.length} propert${properties.length === 1 ? 'y' : 'ies'} tracked`}
          </p>
        </div>

        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-3 text-sm font-semibold text-gray-400 hover:border-brand-navy/30 hover:text-brand-navy transition-all"
          >
            <Plus size={15} /> Add a property
          </button>
        ) : (
          <div className="rounded-xl border border-brand-navy/20 bg-brand-navy/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <LinkIcon size={13} className="text-gray-400 flex-shrink-0" />
              <input autoFocus type="text" value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Paste a Zillow or MLS link (optional)"
                className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30" />
            </div>
            <input type="text" value={addressInput} onChange={(e) => setAddressInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Address  e.g. 123 Oak St, Hoover, AL"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30" />
            <input type="text" value={priceInput} onChange={(e) => setPriceInput(e.target.value)}
              placeholder="List price (optional)"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-800 outline-none focus:border-brand-navy/30" />
            {addError && (
              <p className="text-xs font-medium text-red-500">{addError}</p>
            )}
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={!addressInput.trim() && !urlInput.trim()}
                className="flex-1 rounded-lg bg-brand-navy py-2 text-xs font-bold text-white disabled:opacity-40 hover:bg-brand-navy/80 transition-colors">
                Add property
              </button>
              <button onClick={() => { setShowForm(false); setUrlInput(''); setAddressInput(''); setPriceInput(''); setAddError(null); }}
                className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Cash buyers get a proof-of-funds nudge instead of the lender track (#409) */}
      {isCashBuyer && !preApproved && (
        <div className="flex items-start gap-3 rounded-2xl border border-green-200 bg-green-50 px-4 py-3">
          <CheckCircle2 size={16} className="mt-0.5 flex-shrink-0 text-green-500" />
          <div>
            <p className="text-sm font-black text-green-900">You&apos;re buying with cash</p>
            <p className="mt-0.5 text-xs text-green-800 leading-relaxed">
              No pre-approval needed — you can request an offer on any home below. Your
              agent may ask for proof of funds when it&apos;s time to submit.
            </p>
          </div>
        </div>
      )}

      {/* Pre-approval banner — visible above the list, not blocking it.
          The buyer agency agreement prompts live in the same card, so it also
          renders for a buyer who is past the pre-approval gate but hasn't
          signed the BAA — including a cash buyer, who never sees the gate at
          all (#409). */}
      {(!canOffer || !baaSigned) && (
        <div
          className={`rounded-2xl border p-4 space-y-3 ${
            canOffer ? 'border-gray-200 bg-white' : 'border-amber-200 bg-amber-50'
          }`}
        >
          {!canOffer && (
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100">
                <AlertCircle size={16} className="text-amber-600" />
              </div>
              <div>
                <p className="text-sm font-black text-amber-900">Get pre-approved to make an offer</p>
                <p className="mt-0.5 text-xs text-amber-700 leading-relaxed">
                  Browse homes your agent has shared below. You&apos;ll need a pre-approval letter before we can submit an offer.
                </p>
              </div>
            </div>
          )}

          {!baaSigned && baaPending && baaSignable && (
            <button
              onClick={handleSignBaa}
              disabled={baaSigning}
              className="flex w-full items-center justify-between rounded-xl border border-amber-300 bg-white px-4 py-3 text-left hover:bg-amber-50 transition-colors disabled:opacity-50"
            >
              <div>
                <p className="text-sm font-bold text-brand-navy">Sign your buyer agency agreement</p>
                <p className="text-xs text-gray-400 mt-0.5">Takes about a minute — you&apos;ll sign right here, no email needed.</p>
              </div>
              <ChevronRight size={16} className="text-brand-navy flex-shrink-0" />
            </button>
          )}

          {!baaSigned && baaPending && !baaSignable && (
            <div className="flex w-full items-start gap-3 rounded-xl border border-amber-300 bg-white px-4 py-3">
              <div>
                <p className="text-sm font-bold text-brand-navy">Buyer agency agreement sent — check your email</p>
                <p className="text-xs text-gray-400 mt-0.5">Sign it via the secure DocuSign link in your inbox. Status updates here once everyone has signed.</p>
              </div>
            </div>
          )}

          {!baaSigned && !baaPending && (
            <div className="flex w-full items-start gap-3 rounded-xl border border-amber-200 bg-white/60 px-4 py-3">
              <div>
                <p className="text-sm font-bold text-brand-navy">Buyer agency agreement</p>
                <p className="text-xs text-gray-400 mt-0.5">Your agent will send it for signature — required before showings.</p>
              </div>
            </div>
          )}

          {baaSigned && (
            <div className="mb-1 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
              <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
              <p className="text-xs font-semibold text-green-800">Buyer agency agreement signed</p>
            </div>
          )}

          {/* Lender / pre-approval-letter CTAs — only for a buyer the gate
              actually applies to. A cash buyer has no letter to send (#409). */}
          {!canOffer && (isMountainMortgage ? (lenderCtaHandledAbove ? null : (
            <div className="flex gap-2">
              <a href={MOUNTAIN_MORTGAGE_PHONE_HREF}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-navy py-2.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors">
                <Phone size={12} /> Call {MOUNTAIN_MORTGAGE_LOAN_OFFICER}
              </a>
              {/* Was pointed at apply.mountainmortgage.com, which is not the
                  application. The real 1003 lives in lib/lender.ts (#431). */}
              <a href={MOUNTAIN_MORTGAGE_APPLICATION_URL} target="_blank" rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-brand-navy py-2.5 text-xs font-bold text-brand-navy hover:bg-brand-navy/5 transition-colors">
                <ExternalLink size={12} /> Apply Now →
              </a>
            </div>
          )) : letterUploaded ? (
            <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
              <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
              <p className="text-xs font-semibold text-green-800">Pre-approval letter uploaded — your agent will review it</p>
            </div>
          ) : letterLaterSent ? (
            <div className="flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
              <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
              <p className="text-xs font-semibold text-green-800">Got it — we let your agent know you have a pre-approval letter. They&apos;ll reach out.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button onClick={handleUploadLetter} disabled={uploadingLetter}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-navy py-2.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-50">
                  {uploadingLetter
                    ? <><Loader2 size={12} className="animate-spin" /> Uploading…</>
                    : <><Upload size={12} /> Upload pre-approval letter</>}
                </button>
                <button onClick={handleLetterLater} disabled={sendingLater}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-200 py-2.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50">
                  {sendingLater ? 'Sending…' : 'I have one — send later'}
                </button>
              </div>
              {letterError && (
                <p role="alert" className="text-xs font-medium text-red-600">{letterError}</p>
              )}
              {letterLaterError && (
                <p role="alert" className="text-xs font-medium text-red-600">{letterLaterError}</p>
              )}
              {/* Hidden input drives the "Upload pre-approval letter" button (#266). */}
              <input
                ref={preApprovalFileRef}
                type="file"
                className="hidden"
                onChange={handleLetterFileChange}
                disabled={uploadingLetter}
              />
            </div>
          ))}
        </div>
      )}

      {/* Property list — always visible */}
      <div className="space-y-3">
        {actionError && (
          <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5">
            <AlertCircle size={14} className="text-red-500 flex-shrink-0" />
            <p className="text-xs font-medium text-red-600">{actionError}</p>
          </div>
        )}
        {properties.length === 0 && !showForm && (
          <div className="rounded-2xl border border-dashed border-gray-200 px-5 py-8 text-center">
            <Home size={28} className="mx-auto mb-2 text-gray-200" />
            <p className="text-sm font-semibold text-gray-400">No properties yet</p>
            <p className="mt-1 text-xs text-gray-300">
              Paste a link or type an address above. Your agent can also push listings to your portal.
            </p>
          </div>
        )}
        {properties.map((prop) => (
          <PropertyCard key={prop.id} property={prop}
            canOffer={canOffer}
            onStatusChange={(status) => runAction(updateStatus(prop.id, status))}
            onRemove={() => runAction(removeProperty(prop.id))}
            onBuyerNote={(note) => runAction(updateBuyerNote(prop.id, note))}
            onOfferRequest={() => setOfferRequested(prop.id, true)} />
        ))}
      </div>

      {/* Live MLS listings browser */}
      <MLSBrowser
        deal={deal}
        onAddProperty={(address, city, price) =>
          addProperty({
            dealId: deal.id,
            address,
            city,
            state: '',
            price,
            beds: 0, baths: 0, sqft: 0,
            thumbnailUrl: '',
            sourceUrl: '',
            status: 'interested',
            addedBy: 'buyer',
          })
        }
      />

    </div>
  );
}

function OfferActiveCard({ deal }: { deal: Deal }) {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100">
          <ClipboardList size={18} className="text-amber-600" />
        </div>
        <div className="flex-1">
          <p className="font-bold text-amber-900 text-sm">Your offer is submitted</p>
          <p className="mt-0.5 text-xs text-amber-700">
            {deal.property.address}, {deal.property.city}
          </p>
          <p className="mt-2 text-lg font-black text-amber-900">
            {formatMoney(deal.property.price)}
          </p>
        </div>
        <span className="rounded-full bg-amber-200 px-2.5 py-1 text-[10px] font-bold text-amber-800 uppercase">
          Pending
        </span>
      </div>
      <div className="mt-4 rounded-xl bg-white/60 px-4 py-3">
        <p className="text-xs font-semibold text-amber-800">Stay available</p>
        <p className="mt-0.5 text-xs text-amber-600 leading-relaxed">
          Your agent may need a quick response if the seller counters. Keep your phone nearby.
        </p>
      </div>
    </div>
  );
}

const APPRAISAL_CONFIG: Record<
  NonNullable<NonNullable<Deal['loanMilestones']>['appraisal']>,
  { icon: string; label: string; cardCls: string; textCls: string; subCls: string; desc: string }
> = {
  pending: {
    icon: '⏳', label: 'Pending',
    cardCls: 'bg-gray-50 border-gray-200', textCls: 'text-gray-700', subCls: 'text-gray-500',
    desc: 'Your lender will order the appraisal shortly after going under contract.',
  },
  ordered: {
    icon: '📋', label: 'Ordered',
    cardCls: 'bg-blue-50 border-blue-100', textCls: 'text-blue-800', subCls: 'text-blue-600',
    desc: 'Appraisal has been ordered. The lender will reach out to coordinate property access.',
  },
  scheduled: {
    icon: '📅', label: 'Scheduled',
    cardCls: 'bg-amber-50 border-amber-200', textCls: 'text-amber-800', subCls: 'text-amber-600',
    desc: 'Appraisal is scheduled. Make sure the seller or agent can provide access on the agreed date.',
  },
  complete: {
    icon: '✅', label: 'Complete',
    cardCls: 'bg-green-50 border-green-200', textCls: 'text-green-800', subCls: 'text-green-600',
    desc: 'Appraisal is done and results have been submitted to your lender.',
  },
};

function UnderContractCard({ deal }: { deal: Deal }) {
  // disclosuresOut / disclosuresSignedSubmitted are the correct field names
  const hasDisclosureUrgent =
    deal.loanMilestones?.disclosuresOut === true &&
    deal.loanMilestones?.disclosuresSignedSubmitted === false;

  const lender    = deal.vendors?.lender;
  const inspector = deal.vendors?.inspector;
  const appraisal = deal.loanMilestones?.appraisal ?? null;
  const hasRepairRequest = deal.flags.includes('repair_request');

  return (
    <div className="space-y-3">
      {/* Urgent: disclosures */}
      {hasDisclosureUrgent && (
        <div className="flex items-start gap-3 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-bold text-red-700">Action required: Sign your disclosures</p>
            <p className="text-xs text-red-400 mt-0.5 leading-relaxed">
              {lender
                ? `${lender.company} sent disclosures to your email. Open their portal to sign — must be completed within 3 business days.`
                : 'Your lender sent disclosures to your email. Sign through their portal within 3 business days.'}
            </p>
            {lender?.portalUrl && (
              <a
                href={lender.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-700 transition-colors"
              >
                <ExternalLink size={11} /> Open {lender.company} Portal
              </a>
            )}
          </div>
        </div>
      )}

      {/* Closing countdown */}
      {deal.timeline.daysToClose !== undefined && (
        <div className="flex items-center justify-between rounded-xl bg-white border border-gray-100 shadow-sm px-5 py-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-400">
            <Calendar size={11} />
            <span>Target closing: {deal.timeline.closingDate}</span>
          </div>
          <div className="text-right">
            <span className="text-xl font-black text-brand-navy">{deal.timeline.daysToClose}</span>
            <span className="ml-1 text-xs text-gray-400">days to close</span>
          </div>
        </div>
      )}

      {/* Inspector card */}
      {inspector && (
        <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-4">
          <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Your Inspector</p>
          <div className="flex items-center gap-3 mb-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-teal-50">
              <ClipboardList size={18} className="text-teal-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-brand-navy">{inspector.company}</p>
              {inspector.contactName && (
                <p className="text-xs text-gray-400">{inspector.contactName}</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            {inspector.phone && (
              <a href={`tel:${inspector.phone}`}
                className="flex items-center gap-2.5 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                <Phone size={14} /> {inspector.phone}
              </a>
            )}
            {inspector.email && (
              <a href={`mailto:${inspector.email}`}
                className="flex items-center gap-2.5 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                <Mail size={14} /> {inspector.email}
              </a>
            )}
          </div>
          <div className="mt-3 rounded-lg bg-teal-50 border border-teal-100 px-3 py-2.5">
            <p className="text-xs font-semibold text-teal-700">💡 Attend your inspection</p>
            <p className="text-xs text-teal-600 mt-0.5 leading-relaxed">
              Being there in person lets you ask questions and understand the home&apos;s condition before you close — highly recommended.
            </p>
          </div>
        </div>
      )}

      {/* Appraisal status */}
      {appraisal && (() => {
        const cfg = APPRAISAL_CONFIG[appraisal];
        return (
          <div className={`rounded-xl border px-4 py-3.5 ${cfg.cardCls}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-base leading-none">{cfg.icon}</span>
                <p className={`text-sm font-bold ${cfg.textCls}`}>Appraisal: {cfg.label}</p>
              </div>
              <span className={`text-[11px] font-bold uppercase tracking-wide ${cfg.subCls}`}>{cfg.label}</span>
            </div>
            <p className={`mt-1.5 text-xs leading-relaxed ml-7 ${cfg.subCls}`}>{cfg.desc}</p>
          </div>
        );
      })()}

      {/* Repair request — buyer-facing explanation */}
      {hasRepairRequest && (
        <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3.5">
          <div className="flex items-start gap-2.5">
            <AlertCircle size={16} className="text-orange-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-bold text-orange-800">Repair request submitted</p>
              <p className="text-xs text-orange-600 mt-0.5 leading-relaxed">
                Your agent submitted a repair request to the seller after the inspection. The seller&apos;s agent is reviewing it — your agent will update you once they respond.
              </p>
              <p className="text-xs text-orange-500 mt-1.5 leading-relaxed italic">
                Typical response time: 3–5 business days. Stay available for questions.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Full metro map */}
      <MetroMap deal={deal} />
    </div>
  );
}

function PreCloseCard({ deal }: { deal: Deal }) {
  const items = [
    { label: 'Schedule final walkthrough',  done: false },
    { label: 'Review Closing Disclosure',   done: false },
    { label: 'Confirm wire instructions',   done: false },
    { label: 'Prepare ID + funds',          done: false },
  ];
  return (
    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm overflow-hidden">
      <div className="bg-blue-50 border-b border-blue-100 px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star size={15} className="text-blue-600" />
          <span className="text-sm font-bold text-blue-800">Almost there!</span>
        </div>
        {deal.timeline.daysToClose !== undefined && (
          <span className="text-sm font-black text-blue-700">{deal.timeline.daysToClose} days</span>
        )}
      </div>
      <div className="p-5 space-y-2.5">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className={`flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
              item.done ? 'bg-green-400' : 'border-2 border-gray-200'
            }`}>
              {item.done && <CheckCircle2 size={12} className="text-white" />}
            </div>
            <span className={`text-sm ${item.done ? 'line-through text-gray-300' : 'text-gray-700'}`}>
              {item.label}
            </span>
          </div>
        ))}
        <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2.5">
          <p className="text-[11px] font-semibold text-amber-700">Wire fraud warning</p>
          <p className="text-[11px] text-amber-600 mt-0.5 leading-relaxed">
            Never wire funds based on email instructions. Call your agent or title company directly to verify.
          </p>
        </div>
      </div>
    </div>
  );
}

function ClosingCard({ agentName }: { agentName?: string }) {
  const checklist = [
    'Government-issued photo ID',
    'Cashier\'s check or wire confirmation',
    'Any remaining documents requested',
    'Your phone (charged)',
  ];
  return (
    <div className="rounded-2xl overflow-hidden">
      <div className="bg-brand-gold px-5 py-4">
        <p className="text-xs font-bold uppercase tracking-widest text-brand-navy/60">Closing Day</p>
        <p className="text-xl font-black text-brand-navy mt-0.5">Today&apos;s the day!</p>
        <p className="text-sm text-brand-navy/70 mt-1">Here&apos;s what to bring to the closing table.</p>
      </div>
      <div className="bg-white border border-brand-gold/30 rounded-b-2xl p-5 space-y-2.5">
        {checklist.map((item, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-brand-gold/20">
              <span className="text-[10px] font-bold text-brand-navy">{i + 1}</span>
            </div>
            <span className="text-sm text-gray-700">{item}</span>
          </div>
        ))}
        <div className="pt-2 border-t border-gray-100 mt-2">
          <p className="text-xs text-gray-400 leading-relaxed">
            Your agent will be there with you. Questions? Call {agentName || 'your agent'} before you leave.
          </p>
        </div>
      </div>
    </div>
  );
}

function PostCloseCard({ deal, firstName }: { deal: Deal; firstName: string }) {
  const hasFastPass = deal.flags.includes('fast_pass');
  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 p-5 text-white">
        <div className="flex items-center gap-2 mb-2">
          <Home size={20} className="text-white" />
          <p className="text-xs font-bold uppercase tracking-widest text-white/70">You own it!</p>
        </div>
        <p className="text-xl font-black">Congratulations, {firstName}!</p>
        <p className="text-sm text-white/80 mt-1">{deal.property.address} is yours.</p>
      </div>
      {hasFastPass && (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-5 py-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap size={15} className="text-green-600" />
            <p className="text-sm font-bold text-green-800">Fast Pass team is on it</p>
          </div>
          <p className="text-xs text-green-600 leading-relaxed">
            Your concierge team is coordinating utilities, movers, and your welcome home package.
          </p>
        </div>
      )}
      <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-5">
        <p className="text-xs font-bold uppercase tracking-wide text-gray-400 mb-3">Next Steps</p>
        <div className="space-y-2.5">
          {[
            { icon: Building2, label: 'Transfer utilities into your name' },
            { icon: Mail,      label: 'Update your mailing address' },
            { icon: Home,      label: 'Check HOA welcome packet (if applicable)' },
            { icon: Star,      label: 'Leave a review for your agent' },
          ].map(({ icon: Icon, label }, i) => (
            <div key={i} className="flex items-center gap-3">
              <Icon size={14} className="text-gray-400 flex-shrink-0" />
              <span className="text-sm text-gray-600">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Lender card ─────────────────────────────────────────────────────────────

function LenderCard({ deal }: { deal: Deal }) {
  const lender = deal.vendors?.lender;
  if (!lender) return null;

  return (
    <div className="rounded-2xl bg-white border border-gray-100 shadow-sm p-5">
      <p className="mb-3 text-xs font-bold uppercase tracking-widest text-gray-400">Your Lender</p>
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50">
          <Building2 size={18} className="text-blue-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-bold text-brand-navy">{lender.company}</p>
          {lender.loanOfficer && (
            <p className="text-xs text-gray-400">LO: {lender.loanOfficer}</p>
          )}
        </div>
        {lender.isAriveIntegrated && (
          <span className="rounded-full bg-blue-50 border border-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-600 uppercase tracking-wide">
            ARIVE
          </span>
        )}
      </div>
      <div className="space-y-2">
        {lender.phone && (
          <a href={`tel:${lender.phone}`}
            className="flex items-center gap-2.5 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
            <Phone size={14} /> {lender.phone}
          </a>
        )}
        {lender.email && (
          <a href={`mailto:${lender.email}`}
            className="flex items-center gap-2.5 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 transition-colors">
            <Mail size={14} /> {lender.email}
          </a>
        )}
        {lender.portalUrl && (
          <a
            href={lender.portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 rounded-lg bg-brand-navy px-3 py-2.5 text-sm font-bold text-white hover:bg-brand-navy/80 transition-colors"
          >
            <ExternalLink size={14} /> Open {lender.company} Portal
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Fast Pass service tracker (enrolled buyers) ─────────────────────────────

/**
 * #420 — INTERIM FIX. There is deliberately no `complete` here.
 *
 * These are services the buyer PAID for — utility setup, deep clean, moving
 * coordination. The tracker used to derive a green "Complete" from nothing but
 * the deal's stage index, so a buyer at `post_close` was told every one of them
 * had been delivered whether or not anybody had lifted a finger. Telling a
 * client that paid work is finished, on a guess, is a trust problem before it
 * is a UI one.
 *
 * Nothing in the schema records per-service fulfilment today, so the top of the
 * stage-derived ladder is `unconfirmed`: the deal is past the point where the
 * work was due, and nobody has said it happened. That is exactly what the buyer
 * needs to know — and the "Call concierge" button below is the right next move
 * if it stays that way. Restoring a green "Complete" requires a REAL completion
 * signal — a per-service status the concierge sets (#429 builds exactly that
 * for `inspection_followup`). Until then, `complete` is not a value this union
 * can hold, on purpose.
 */
type FPStatus = 'pending' | 'scheduled' | 'in_progress' | 'unconfirmed';

// `textCls` was dropped here: nothing has ever read it (the row's own text
// colour is set inline), so adding a fourth dead entry to it was noise.
const FP_STATUS_CFG: Record<FPStatus, { label: string; dotCls: string; badgeCls: string }> = {
  pending:     { label: 'Pending',     dotCls: 'bg-gray-300',  badgeCls: 'bg-gray-100 text-gray-500' },
  scheduled:   { label: 'Scheduled',   dotCls: 'bg-amber-400', badgeCls: 'bg-amber-100 text-amber-700' },
  in_progress: { label: 'In Progress', dotCls: 'bg-blue-400',  badgeCls: 'bg-blue-100 text-blue-700' },
  unconfirmed: { label: 'Unconfirmed', dotCls: 'bg-slate-400', badgeCls: 'bg-slate-100 text-slate-600' },
};

const FP_STAGE_IDX: Record<DealStage, number> = {
  intake: 0, active_search: 1, offer_active: 2,
  under_contract: 3, pre_close: 4, closing: 5, post_close: 6,
};

/**
 * `expected` is the stage by which the service is *expected* to be finished —
 * not a claim that it was. Reaching it means "due, and nobody has confirmed it"
 * (see the FPStatus note above), never "done".
 */
function fpStatusAt(stage: DealStage, thresholds: {
  scheduled?: DealStage; in_progress?: DealStage; expected?: DealStage;
}): FPStatus {
  const i = FP_STAGE_IDX[stage];
  if (thresholds.expected   && i >= FP_STAGE_IDX[thresholds.expected])    return 'unconfirmed';
  if (thresholds.in_progress && i >= FP_STAGE_IDX[thresholds.in_progress]) return 'in_progress';
  if (thresholds.scheduled  && i >= FP_STAGE_IDX[thresholds.scheduled])  return 'scheduled';
  return 'pending';
}

// Base services included with every Fast Pass, with stage-threshold rules
const FP_BASE_SERVICES: { name: string; thresholds: Parameters<typeof fpStatusAt>[1] }[] = [
  { name: 'Dedicated concierge assigned',           thresholds: { in_progress: 'active_search', expected: 'under_contract' } },
  { name: 'Title & insurance admin coordination',   thresholds: { in_progress: 'under_contract', expected: 'closing' } },
  { name: 'Move-in timeline & scheduling',          thresholds: { scheduled: 'pre_close', in_progress: 'closing', expected: 'post_close' } },
  { name: 'Interior designer move-in consult',      thresholds: { scheduled: 'pre_close', in_progress: 'closing', expected: 'post_close' } },
  { name: '2% refi credit — active post-close',     thresholds: { scheduled: 'pre_close', expected: 'post_close' } },
];

// Per-upsell stage thresholds
const FP_UPSELL_THRESHOLDS: Record<FastPassUpsellId, Parameters<typeof fpStatusAt>[1]> = {
  utility_setup:       { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
  deep_clean:          { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
  moving_coordination: { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
  refi_monitoring:     { scheduled: 'closing',   in_progress: 'post_close', expected: 'post_close' },
  home_warranty:       { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
  inspection_followup: { in_progress: 'under_contract', expected: 'pre_close' },
  address_change:      { scheduled: 'closing',   in_progress: 'post_close', expected: 'post_close' },
  storage_research:    { in_progress: 'pre_close', expected: 'closing' },
  new_construction:    { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
  staging_consult:     { scheduled: 'pre_close', in_progress: 'closing',  expected: 'post_close' },
};

function FastPassTracker({ deal }: { deal: Deal }) {
  const fp = deal.fastPass;
  if (!fp) return null;

  const stage = deal.stage;
  const moveDate = fp.surveyAnswers?.targetMoveDate;
  const selectedUpsells = fp.selectedUpsells ?? [];
  const enrolledUpsells = FAST_PASS_UPSELLS.filter((u) => selectedUpsells.includes(u.id));

  const allServices = [
    ...FP_BASE_SERVICES.map((s) => ({
      name: s.name,
      status: fpStatusAt(stage, s.thresholds),
      isUpsell: false,
    })),
    ...enrolledUpsells.map((u) => ({
      name: u.name,
      status: fpStatusAt(stage, FP_UPSELL_THRESHOLDS[u.id]),
      isUpsell: true,
    })),
  ];

  return (
    <div data-testid="fp-tracker" className="rounded-2xl overflow-hidden border border-green-200 bg-white">
      {/* Header */}
      <div className="bg-green-700 px-5 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap size={16} className="text-green-200" />
            <span className="text-sm font-black text-white">Fast Pass</span>
          </div>
          <span className="rounded-full bg-green-600 px-2.5 py-0.5 text-[11px] font-bold text-green-100">
            Active
          </span>
        </div>
        <p className="mt-1.5 text-xs text-green-200/80 leading-relaxed">
          Your concierge is coordinating everything below.
          {moveDate && ` Target move-in: ${moveDate}.`}
        </p>
        {/*
          #420 — the "N/M done" bar counted the stage-derived "Complete"s, so it
          published a completion percentage nobody had confirmed. Until a real
          per-service completion signal exists there is no honest number to put
          here; say what the list is instead of inventing a score.
        */}
        <p className="mt-2 text-[11px] font-semibold text-green-200">
          {`${allServices.length} service${allServices.length !== 1 ? 's' : ''} on your plan · your concierge confirms each service as it's completed`}
        </p>
      </div>

      {/* Service list */}
      <div className="divide-y divide-gray-50">
        {allServices.map((svc, i) => {
          const cfg = FP_STATUS_CFG[svc.status];
          return (
            <div key={i} data-testid="fp-service" data-status={svc.status} className="flex items-center gap-3 px-4 py-3">
              <div className={`h-2 w-2 flex-shrink-0 rounded-full ${cfg.dotCls}`} />
              <span className="flex-1 text-sm text-gray-700">
                {svc.name}
                {svc.isUpsell && (
                  <span className="ml-1.5 text-[10px] font-bold text-green-600 uppercase tracking-wide">Add-on</span>
                )}
              </span>
              <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${cfg.badgeCls}`}>
                {cfg.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Footer CTA */}
      <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-400">Questions about your Fast Pass?</p>
        <a
          href="tel:+12054019076"
          className="flex items-center gap-1.5 rounded-lg bg-green-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-800 transition-colors"
        >
          <Phone size={11} /> Call concierge
        </a>
      </div>
    </div>
  );
}

// ─── Fast Pass payment card (enrolled, awaiting payment) ─────────────────────
//
// FF17 (#440). FF16 (#439) took payment out of the onboarding survey, so an
// enrollment now lands `pending_payment` with nothing collected — this card is
// the only place that gets settled, in context, next to what they bought.
//
// Two rules it exists to keep:
//   - Every figure comes from the SERVER's `fast_pass.total_cents` (via
//     fastPassTotalForPaymentOption, the same helper /fastpass/pay prices from),
//     never from a client-side stash or a local `* 1.15`.
//   - An unpaid enrollment never gets a success state. If Checkout can't be
//     started, the card stays put and shows a real, retryable error (#412).

/** Dollars for display, with cents only when a promo left some. */
function fpMoney(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

const FP_PAYMENT_CHOICES: {
  value: FastPassPaymentOptionId;
  title: string;
  badge: string;
  badgeCls: string;
  desc: string;
}[] = [
  {
    value: 'now',
    title: 'Pay now',
    badge: 'Best value',
    badgeCls: 'bg-green-500 text-white',
    desc: 'Secure card checkout. Your Fast Pass activates as soon as payment clears.',
  },
  {
    value: 'at_closing',
    title: 'Pay at closing',
    badge: '+15%',
    badgeCls: 'bg-gray-100 text-gray-500',
    desc: 'Nothing due today — the fee is added to your closing costs.',
  },
  {
    value: 'seller_concession',
    title: 'Seller concession',
    badge: '$0 out of pocket',
    badgeCls: 'bg-blue-100 text-blue-700',
    desc: 'Ask your agent to negotiate the fee into your offer. The seller pays at closing.',
  },
];

function FastPassPaymentCard({ deal, onSettled }: { deal: Deal; onSettled: () => void }) {
  const [choice, setChoice] = useState<FastPassPaymentOptionId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);
  // Double-submit guard. `disabled={submitting}` is not enough on its own —
  // setState is async, so two clicks landing in the same tick both see the old
  // value and both fire. This ref flips synchronously, and this action moves
  // money, so it gets the stricter guard.
  const inFlight = useRef(false);

  const fp = deal.fastPass;
  if (!fp) return null;

  const selectedUpsells = fp.selectedUpsells ?? [];
  const enrolledUpsells = FAST_PASS_UPSELLS.filter((u) => selectedUpsells.includes(u.id));
  // The authoritative, already-discounted total the server persisted at enroll.
  const enrolledCents = fp.totalCents;
  const totalFor = (option: FastPassPaymentOptionId) =>
    fastPassTotalForPaymentOption(enrolledCents, selectedUpsells, option);

  async function submit() {
    if (!choice || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setFailed(false);
    try {
      const res = await api.post<{ ok?: boolean; checkout_url?: string }>(
        `/deals/${deal.id}/fastpass/pay`,
        { payment_option: choice },
      );
      if (choice === 'now') {
        // No URL means Checkout never started, whatever the body claims — treat
        // it exactly like a thrown error rather than pretending it worked
        // (#412). Otherwise navigate and stay disabled; the page is unloading.
        if (!res?.checkout_url) throw new Error('checkout session was not created');
        window.location.href = res.checkout_url;
        return;
      }
      // Deferred: the enrollment is active now — refetch so this card gives way
      // to the service tracker.
      onSettled();
    } catch {
      setFailed(true);
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl overflow-hidden border-2 border-amber-200 bg-white">
      <div className="bg-amber-50 px-5 py-4 border-b border-amber-100">
        <div className="flex items-center gap-2">
          <Zap size={15} className="text-amber-600" />
          <span className="text-xs font-bold uppercase tracking-widest text-amber-600">
            Fast Pass · Payment needed
          </span>
        </div>
        <p className="mt-1.5 text-sm text-amber-900/80 leading-relaxed">
          You&apos;re enrolled and your concierge has your details. Pick how you&apos;d
          like to pay to activate it.
        </p>
      </div>

      {/* What they bought — itemised, so the total is never a mystery number */}
      <div className="divide-y divide-gray-50">
        <div className="flex items-center justify-between px-5 py-2.5">
          <span className="text-sm text-gray-700">Fast Pass concierge</span>
          <span className="text-sm text-gray-500">${FAST_PASS_BASE_PRICE.toLocaleString()}</span>
        </div>
        {enrolledUpsells.map((u) => (
          <div key={u.id} className="flex items-center justify-between px-5 py-2.5">
            <span className="text-sm text-gray-700">{u.name}</span>
            <span className="text-sm text-gray-500">${u.price.toLocaleString()}</span>
          </div>
        ))}
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50">
          <span className="text-sm font-bold text-brand-navy">Total</span>
          <span className="text-sm font-black text-brand-navy">
            ${fpMoney(totalFor('now'))}
          </span>
        </div>
      </div>

      {/* How to pay */}
      <div className="px-5 py-4 space-y-2">
        {FP_PAYMENT_CHOICES.map((opt) => {
          const isSelected = choice === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => setChoice(opt.value)}
              aria-pressed={isSelected}
              className={[
                'w-full rounded-xl border-2 p-4 text-left transition-all active:scale-[0.99]',
                isSelected
                  ? 'border-brand-navy bg-brand-navy/5'
                  : 'border-gray-100 bg-white hover:border-gray-200',
              ].join(' ')}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-brand-navy">{opt.title}</span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${opt.badgeCls}`}>
                    {opt.badge}
                  </span>
                </div>
                <span className="text-sm font-black text-brand-navy">
                  ${fpMoney(totalFor(opt.value))}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-gray-400">{opt.desc}</p>
            </button>
          );
        })}

        {failed && (
          <div role="alert" className="rounded-xl border border-red-100 bg-red-50 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">
              We couldn&apos;t start your payment.
            </p>
            <p className="text-xs text-red-400">
              Nothing was charged. Please try again, or call your concierge.
            </p>
          </div>
        )}

        <button
          onClick={submit}
          disabled={!choice || submitting}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-bold transition-all',
            choice && !submitting
              ? 'bg-green-500 text-white hover:bg-green-600 active:scale-[0.98]'
              : 'cursor-not-allowed bg-gray-100 text-gray-300',
          ].join(' ')}
        >
          {submitting && <Loader2 size={14} className="animate-spin" />}
          {choice === 'now' || choice === null ? 'Continue to payment' : 'Confirm choice'}
        </button>
      </div>
    </div>
  );
}

// ─── Fast Pass pitch card (unenrolled buyers) ─────────────────────────────────

function FastPassPitch({ dealId }: { dealId: string }) {
  const router = useRouter();
  return (
    <div className="rounded-2xl overflow-hidden border-2 border-green-200 bg-green-50">
      <div className="p-5">
        <div className="flex items-center gap-2 mb-2">
          <Zap size={15} className="text-green-600" />
          <span className="text-xs font-bold uppercase tracking-widest text-green-600">Buyer Concierge</span>
        </div>
        <div className="text-lg font-black text-green-900">Fast Pass</div>
        <p className="mt-1.5 text-sm text-green-800/80 leading-relaxed">
          We handle your move-in coordination — movers, utilities, deep clean, address changes, and more. Close on Thursday, wake up home on Saturday.
        </p>
        <div className="mt-3 inline-block rounded-lg bg-green-100 px-3 py-1.5 text-sm font-black text-green-800">
          ${FAST_PASS_BASE_PRICE.toLocaleString()} · pay now or at closing
        </div>
      </div>
      <div className="border-t border-green-200 px-5 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push(`/fast-pass?dealId=${dealId}`)}
          className="text-xs font-semibold text-green-700 hover:text-green-900 transition-colors"
        >
          Learn more →
        </button>
        <button
          onClick={() => router.push(`/fast-pass/survey?dealId=${dealId}`)}
          className="ml-auto rounded-xl bg-green-700 px-5 py-2 text-xs font-bold text-white hover:bg-green-800 transition-colors active:scale-[0.98]"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}

// ─── Stage card dispatcher ────────────────────────────────────────────────────

function StageCard({ deal, firstName, lenderCtaHandledAbove = false }: { deal: Deal; firstName: string; lenderCtaHandledAbove?: boolean; onRefresh?: () => void }) {
  switch (deal.stage) {
    case 'intake':         return <IntakeCard deal={deal} firstName={firstName} />;
    case 'active_search':  return <ActiveSearchCard deal={deal} lenderCtaHandledAbove={lenderCtaHandledAbove} />;
    case 'offer_active':   return <OfferActiveCard deal={deal} />;
    case 'under_contract': return <UnderContractCard deal={deal} />;
    case 'pre_close':      return <PreCloseCard deal={deal} />;
    case 'closing':        return <ClosingCard agentName={deal.agentName} />;
    case 'post_close':     return <PostCloseCard deal={deal} firstName={firstName} />;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function BuyerView() {
  const activeUser = useAuthStore((s) => s.activeUser);
  const [activeTab, setActiveTab] = useState<Tab>('tasks');
  const { notifications, markRead } = useNotifications();

  const queryClient = useQueryClient();
  const { deals, loading: dealsLoading, error: dealsError, refresh: refreshDeals } = useMyDeals();
  const deal = deals.find((d) => d.type === 'buy');
  const { tasks, refresh: refreshTasks } = useTasks(deal?.id ?? '');
  const { completedIds, error: completeError, complete: handleComplete, uncomplete: handleUncomplete } = useTaskCompletion(refreshTasks);
  // After a TaskCard upload confirms, refresh the deal's Documents tab in-session.
  const invalidateDocuments = useCallback(() => {
    if (deal) void queryClient.invalidateQueries({ queryKey: ['documents', deal.id] });
  }, [queryClient, deal]);
  const buyerTasks = tasks.filter((t) => t.assignedTo === 'buyer');
  // Real status ∪ the in-flight optimistic check. Partitioning the same array
  // two ways also de-dupes the count a refetched 'completed' task used to
  // inflate (it is in both `completedIds` and the server list).
  const isTaskDone = (t: Task) => t.status === 'completed' || completedIds.has(t.id);
  const openTasks = buyerTasks.filter((t) => !isTaskDone(t));
  // #408: completed tasks are RENDERED, not just counted — they were the
  // one-way door (the row disappeared and nothing could bring it back).
  const doneTasks = buyerTasks.filter(isTaskDone);
  const completedCount = doneTasks.length;
  // #423 — everything on the deal that is NOT the buyer's and is still open.
  // Shown read-only, collapsed, so "what is happening?" has an answer that
  // isn't a row they can't act on. A finished agent task is left out: it is
  // neither news nor something they can move.
  const handledForYou = tasks.filter((t) => t.assignedTo !== 'buyer' && !isTaskDone(t));
  // #435 — the open pre-approval ask, if there is one. Keyed on the task's
  // source, so a cash buyer (never seeded one) and a buyer who has closed it
  // both get nothing. `openTasks` already accounts for the optimistic tick, so
  // completing it in the list below makes this card go away in the same tick.
  const preApprovalTask = openTasks.find((t) => t.source === PRE_APPROVAL_SOURCE);

  if (dealsLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <Loader2 size={24} className="text-brand-navy animate-spin" />
      </div>
    );
  }

  if (dealsError) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
        <p className="text-sm text-gray-400">Unable to load your deal.</p>
        <button
          onClick={refreshDeals}
          className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-gray-400 text-sm">No active deal found.</p>
      </div>
    );
  }

  const firstName = activeUser?.name.split(' ')[0] ?? 'there';

  // Unread "new_message" notifications for THIS deal drive the Messages tab badge.
  const unreadMessageNotifications = notifications.filter(
    (n) => n.dealId === deal.id && n.type === 'new_message' && !n.read,
  );
  const handleTabChange = (t: Tab) => {
    setActiveTab(t);
    // Opening Messages clears the badge — mark this deal's unread messages read.
    if (t === 'messages') {
      unreadMessageNotifications.forEach((n) => { void markRead(n.id); });
    }
  };

  // ── #422: what goes in which section, and which section leads ──────────────
  const hasOverdue = buyerTasks.some((t) => t.status === 'overdue');
  const fastPassNeedsPayment = deal.fastPass?.status === 'pending_payment';
  const stageFocus = STAGE_FOCUS[deal.stage];
  // The tab bar (and with it the task list) is hidden at post_close, exactly as
  // before. Without it the actions section would be a heading over nothing —
  // so it only renders when it actually has something in it.
  const showTabs = deal.stage !== 'post_close';
  const showActions =
    showTabs || hasOverdue || !!preApprovalTask || fastPassNeedsPayment;
  // Anything genuinely waiting on the buyer puts their own section first. When
  // nothing is, an empty to-do list must not be the first thing they read —
  // the stage's own card leads instead (the intake CTA, most of all).
  const actionsFirst =
    hasOverdue || openTasks.length > 0 || !!preApprovalTask || fastPassNeedsPayment;

  // ── #423: the shape of the task list itself ────────────────────────────────
  // Open work leads with the stage the deal is in, so leftovers from a stage
  // the buyer has walked past read as catch-up rather than as today's job.
  // Completed work runs the other way — chronologically, as a history of what
  // they have already done.
  const openTaskGroups = groupTasksByStage(sortTasksByUrgency(openTasks), deal.stage);
  const doneTaskGroups = groupTasksByStage(doneTasks, deal.stage, 'chronological');

  const actionsSection = showActions ? (
    <PortalSection
      key="actions"
      testId="portal-actions"
      title="What you need to do"
      blurb="Your side of the deal — your to-do list, your messages, and your paperwork. Everything else is your agent's to handle."
    >
      {/* Overdue alert */}
      {hasOverdue && (
        <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">You have overdue tasks</p>
            <p className="text-xs text-red-400">Your agent is waiting — take a look below</p>
          </div>
        </div>
      )}

      {/* Pre-approval ask (#435) — first in the buyer's own section, because
          until it is done it IS the next step. It stays out of the task list so
          a buyer landing here straight out of onboarding sees one unambiguous
          thing to do. */}
      {preApprovalTask && (
        <PreApprovalTaskCard
          task={preApprovalTask}
          appliedAt={deal.preApprovalAppliedAt}
          // Both, and in this order: the task list behind the card has to lose
          // the row, and the deal payload has to pick up the applied date the
          // agent's side reads. Neither is optional — refreshing only tasks
          // would leave a stale `appliedAt` on a re-render.
          onApplied={() => {
            refreshTasks();
            refreshDeals();
          }}
        />
      )}

      {/* Fast Pass — awaiting payment (#440). Deliberately NOT gated on stage:
          the survey runs during onboarding, so the buyer who owes for it is
          usually still sitting at `intake`. It lives here rather than with the
          tracker below because paying is theirs to do. */}
      {fastPassNeedsPayment && (
        <FastPassPaymentCard deal={deal} onSettled={refreshDeals} />
      )}

      {/* Tasks / messages / documents (hidden on post-close to keep it clean) */}
      {showTabs && (
        <>
          <TabBar
            active={activeTab}
            onChange={handleTabChange}
            taskCount={openTasks.length}
            msgCount={unreadMessageNotifications.length}
          />
          {activeTab === 'tasks' && (
            <div className="space-y-2">
              {completeError && (
                <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
                  <AlertCircle size={16} className="text-red-500 flex-shrink-0" />
                  <p className="text-xs font-medium text-red-600">{completeError}</p>
                </div>
              )}
              {openTasks.length === 0 && (
                <div className="rounded-2xl bg-white p-8 text-center shadow-sm">
                  <CheckCircle2 size={32} className="mx-auto mb-2 text-green-400" />
                  <p className="text-sm font-medium text-gray-500">
                    {deal.stage === 'intake'
                      ? 'Nothing on your list yet — your agent adds your first steps once they have your answers.'
                      : 'All caught up — great work!'}
                  </p>
                </div>
              )}
              {/* The buyer's OWN open work, grouped by stage (#423). This used
                  to be three flat `filter(status === …)` passes, which both
                  lost the sense of when a task belonged to and silently drew
                  nothing for any status outside those three. */}
              {openTaskGroups.length > 0 && (
                <div data-testid="portal-tasks-yours" className="space-y-3">
                  <p className="px-0.5 text-xs font-black uppercase tracking-wide text-brand-navy">
                    Your tasks
                  </p>
                  {openTaskGroups.map((group) => (
                    <div key={group.stage} data-testid={`task-group-${group.stage}`} className="space-y-2">
                      <p className="px-0.5 text-[11px] font-semibold text-gray-400">
                        {stageGroupHeading(group.when, BUYER_STAGE_LABELS[group.stage])}
                      </p>
                      {group.tasks.map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} onUploaded={invalidateDocuments} />)}
                    </div>
                  ))}
                </div>
              )}

              {/* History. Still re-openable (#408) — now behind a confirmation
                  (#423) — but framed as things already behind them. */}
              {doneTaskGroups.length > 0 && (
                <div data-testid="portal-tasks-done" className="space-y-3 pt-2">
                  {/* gray-400, not gray-300: on the portal's off-white
                      background a 300 heading is effectively invisible, and
                      "history" must still be readable history. The rows below
                      carry the muting (opacity, strikethrough), not the labels. */}
                  <div className="px-0.5">
                    <p className="text-xs font-black uppercase tracking-wide text-gray-400">Already done</p>
                    <p className="mt-0.5 text-[11px] text-gray-400">
                      {completedCount} task{completedCount !== 1 ? 's' : ''} completed
                    </p>
                  </div>
                  {doneTaskGroups.map((group) => (
                    <div key={group.stage} data-testid={`task-history-${group.stage}`} className="space-y-2">
                      <p className="px-0.5 text-[11px] font-semibold text-gray-400">
                        {BUYER_STAGE_LABELS[group.stage]}
                      </p>
                      {group.tasks.map((t) => <TaskCard key={t.id} task={t} done onUncomplete={handleUncomplete} onUploaded={invalidateDocuments} />)}
                    </div>
                  ))}
                </div>
              )}

              {/* Everything else on the deal — read-only, collapsed, attributed. */}
              {handledForYou.length > 0 && (
                <div className="pt-2">
                  <PortalHandledForYou tasks={handledForYou} />
                </div>
              )}
            </div>
          )}
          {activeTab === 'messages' && <MessagesTab dealId={deal.id} />}
          {activeTab === 'documents' && <PortalDealDocuments dealId={deal.id} />}
        </>
      )}
    </PortalSection>
  ) : null;

  const stageSection = (
    <PortalSection
      key="stage"
      testId="portal-stage"
      title={stageFocus.title}
      blurb={stageFocus.blurb}
    >
      <StageCard deal={deal} firstName={firstName} lenderCtaHandledAbove={!!preApprovalTask} onRefresh={refreshDeals} />

      {/* Fast Pass tracker (enrolled) or pitch (unenrolled). An enrollment that
          still owes money is handled in the actions section above, so it never
          gets pitched something it already bought. */}
      {deal.stage !== 'intake' && !fastPassNeedsPayment && (
        deal.fastPass?.status === 'active'
          ? <FastPassTracker deal={deal} />
          : deal.stage !== 'post_close' && <FastPassPitch dealId={deal.id} />
      )}
    </PortalSection>
  );

  return (
    /*
     * Responsive shell (#421), with #422's content placement on top of it.
     * Below `lg` this is one narrow column; at `lg` it is a two-column grid.
     *
     * THE TRAP (#421, called out on #422): the columns are placed EXPLICITLY —
     * `lg:row-start-2` hard-codes the band as row 1. Adding a fourth top-level
     * wrapper would silently overlap rather than flow, so this stays at exactly
     * three grid children (band / primary / secondary) and everything #422 adds
     * goes INSIDE one of them. The band now carries its row and column
     * explicitly too, so the placement is stated rather than inferred.
     */
    <div
      data-testid="portal-root"
      className="mx-auto max-w-lg space-y-4 pb-10 md:max-w-2xl lg:grid lg:max-w-6xl lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start lg:gap-x-6 lg:gap-y-4 lg:space-y-0"
    >
      {/* Full-width band above the columns */}
      <div className="space-y-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
      <ClientNotifications />

      {/* Header */}
      <div>
        <h1 className="text-2xl font-black text-brand-navy">
          Hi, {firstName}!
        </h1>
        <div className={`mt-3 rounded-2xl bg-white shadow-sm p-4 ${
          deal.health === 'green' ? 'border-l-4 border-l-green-400' :
          deal.health === 'yellow' ? 'border-l-4 border-l-amber-400' :
          'border-l-4 border-l-red-400'
        }`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-0.5">
                <MapPin size={11} />
                <span className="truncate">{deal.property.address}, {deal.property.city}</span>
              </div>
              <p className="font-bold text-brand-navy text-lg">{formatMoney(deal.property.price)}</p>
              {deal.fastPass?.status === 'active' && (
                <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-green-100 border border-green-200 px-2 py-0.5 text-[11px] font-bold text-green-700">
                  <Zap size={10} /> Fast Pass Active
                </span>
              )}
            </div>
            <div className="text-right flex-shrink-0">
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${
                deal.health === 'green'  ? 'bg-green-100 text-green-700 border-green-200'
                  : deal.health === 'yellow' ? 'bg-amber-100 text-amber-700 border-amber-200'
                  :                            'bg-red-100 text-red-700 border-red-200'
              }`}>
                {BUYER_STAGE_LABELS[deal.stage]}
              </span>
              {deal.timeline.closingDate && (
                <div className="mt-1 flex items-center justify-end gap-1 text-[11px] text-gray-400">
                  <Calendar size={10} /> Closing {deal.timeline.closingDate}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Where you are + who moves this on (#422) — on every stage. */}
      <PortalStageHeader
        stageLabel={BUYER_STAGE_LABELS[deal.stage]}
        description={STAGE_DESCRIPTIONS[deal.stage]}
      />
      </div>

      {/* Primary column — the buyer's own work, and the stage's own cards. */}
      <div data-testid="portal-primary" className="space-y-6 lg:col-start-1 lg:row-start-2">
        {actionsFirst ? [actionsSection, stageSection] : [stageSection, actionsSection]}
      </div>

      {/* Secondary column — reference. Nothing here needs the buyer to act;
          #421 left it deliberately sparse for this ticket to fill, so the
          journey rail (context) and the people on the deal live here now. */}
      <div data-testid="portal-secondary" className="space-y-6 lg:col-start-2 lg:row-start-2">
        <PortalSection
          testId="portal-progress"
          title="Your progress"
          blurb="Every step of the deal, and where you are in it."
        >
          <JourneyTracker deal={deal} openTasks={openTasks} />
        </PortalSection>

        <PortalSection
          testId="portal-team"
          title="Your team"
          blurb="The people working your deal, and how to reach them."
        >
          <LenderCard deal={deal} />
          <VendorDirectory dealId={deal.id} />
          <AgentCard agentName={deal.agentName} agentEmail={deal.agentEmail} agentPhone={deal.agentPhone} />
        </PortalSection>

        {/* #427 — the opt-in way back into the questionnaire. Renders ONLY once
            an intake is on file, and lives in the reference rail rather than
            the actions region: it is something the buyer can look at, never
            something they are being asked to do (#407). */}
        <ClientPreferencesCard
          role="buyer"
          intakeSubmitted={deal.intakeSubmitted}
          reviewHref="/onboard/buyer?review=true"
        />
      </div>
    </div>
  );
}
