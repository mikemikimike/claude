"use client";

import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from "@tanstack/react-query";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { Deal, DealStage, Task } from "@/lib/types";
import { STAGE_ORDER } from "@/lib/stages";
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
import { useDocuments, getSigningUrl, requestUploadUrl, confirmUpload } from "@/hooks/useDocuments";
import { uploadFileToStorage } from "@/lib/direct-upload";
import ClientNotifications from "@/components/ClientNotifications";
import { useNotifications } from "@/hooks/useNotifications";
import { FAST_PASS_BASE_PRICE, FAST_PASS_UPSELLS, FastPassUpsellId } from "@/lib/fast-pass-display";

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

const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  completed:   <CheckCircle2 size={18} className="text-green-500 flex-shrink-0" />,
  in_progress: <Loader2 size={18} className="text-blue-500 flex-shrink-0 animate-spin" />,
  overdue:     <AlertCircle size={18} className="text-red-500 flex-shrink-0" />,
  pending:     <Circle size={18} className="text-gray-300 flex-shrink-0" />,
  blocked:     <AlertCircle size={18} className="text-orange-400 flex-shrink-0" />,
};

// ─── Shared: Task card ────────────────────────────────────────────────────────

function TaskCard({ task, onComplete, onUploaded }: { task: Task; onComplete?: (id: string) => void; onUploaded?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const isOverdue = task.status === 'overdue';
  const isDone = task.status === 'completed';
  const actionType = task.actionType ?? 'confirm';

  function handleConfirm() {
    onComplete?.(task.id);
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
      <button
        onClick={() => !isDone && setExpanded((p) => !p)}
        disabled={isDone}
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
          {isDone && <p className="mt-0.5 text-[11px] text-green-600">Marked complete</p>}
        </div>
        {!isDone && (
          <ChevronRight size={14} className={`flex-shrink-0 text-gray-300 mt-0.5 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
        )}
      </button>

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
            <div className={`max-w-[78%] flex flex-col gap-1 ${isAgent ? 'items-start' : 'items-end'}`}>
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

function JourneyTracker({ deal }: { deal: Deal }) {
  const currentIdx = STAGE_ORDER.indexOf(deal.stage);

  return (
    <div className="rounded-2xl overflow-hidden shadow-sm bg-white">
      {STAGE_ORDER.map((stage, i) => {
        const isPast     = i < currentIdx;
        const isCurrent  = i === currentIdx;

        if (isCurrent) {
          return (
            <div key={stage} className="px-5 py-4 bg-brand-navy">
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
          return (
            <div key={stage} className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-50">
              <CheckCircle2 size={13} className="text-green-400 flex-shrink-0" />
              <span className="text-xs font-medium text-green-600">{BUYER_STAGE_LABELS[stage]}</span>
            </div>
          );
        }

        return (
          <div key={stage} className="flex items-center gap-3 px-5 py-2 border-b border-gray-50 last:border-0">
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
        <div className="h-20 w-24 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
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
  const { listings, loading, error, search } = useMLSListings(deal.id);

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

      {open && (
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

          {error && (
            <p className="mt-3 text-xs text-red-500">{error === 'agent has not connected MLS' ? 'Your agent hasn\'t connected their MLS yet.' : error}</p>
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

function ActiveSearchCard({ deal }: { deal: Deal }) {
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
          {!canOffer && (isMountainMortgage ? (
            <div className="flex gap-2">
              <a href="tel:+12054019076"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-navy py-2.5 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors">
                <Phone size={12} /> Call Paul Leara
              </a>
              <a href="https://apply.mountainmortgage.com" target="_blank" rel="noopener noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border-2 border-brand-navy py-2.5 text-xs font-bold text-brand-navy hover:bg-brand-navy/5 transition-colors">
                <ExternalLink size={12} /> Apply Now →
              </a>
            </div>
          ) : letterUploaded ? (
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
            ${deal.property.price.toLocaleString()}
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

type FPStatus = 'pending' | 'scheduled' | 'in_progress' | 'complete';

const FP_STATUS_CFG: Record<FPStatus, { label: string; dotCls: string; textCls: string; badgeCls: string }> = {
  pending:     { label: 'Pending',     dotCls: 'bg-gray-300',  textCls: 'text-gray-400',   badgeCls: 'bg-gray-100 text-gray-500' },
  scheduled:   { label: 'Scheduled',   dotCls: 'bg-amber-400', textCls: 'text-amber-700',  badgeCls: 'bg-amber-100 text-amber-700' },
  in_progress: { label: 'In Progress', dotCls: 'bg-blue-400',  textCls: 'text-blue-700',   badgeCls: 'bg-blue-100 text-blue-700' },
  complete:    { label: 'Complete',    dotCls: 'bg-green-400', textCls: 'text-green-700',  badgeCls: 'bg-green-100 text-green-700' },
};

const FP_STAGE_IDX: Record<DealStage, number> = {
  intake: 0, active_search: 1, offer_active: 2,
  under_contract: 3, pre_close: 4, closing: 5, post_close: 6,
};

function fpStatusAt(stage: DealStage, thresholds: {
  scheduled?: DealStage; in_progress?: DealStage; complete?: DealStage;
}): FPStatus {
  const i = FP_STAGE_IDX[stage];
  if (thresholds.complete   && i >= FP_STAGE_IDX[thresholds.complete])   return 'complete';
  if (thresholds.in_progress && i >= FP_STAGE_IDX[thresholds.in_progress]) return 'in_progress';
  if (thresholds.scheduled  && i >= FP_STAGE_IDX[thresholds.scheduled])  return 'scheduled';
  return 'pending';
}

// Base services included with every Fast Pass, with stage-threshold rules
const FP_BASE_SERVICES: { name: string; thresholds: Parameters<typeof fpStatusAt>[1] }[] = [
  { name: 'Dedicated concierge assigned',           thresholds: { in_progress: 'active_search', complete: 'under_contract' } },
  { name: 'Title & insurance admin coordination',   thresholds: { in_progress: 'under_contract', complete: 'closing' } },
  { name: 'Move-in timeline & scheduling',          thresholds: { scheduled: 'pre_close', in_progress: 'closing', complete: 'post_close' } },
  { name: 'Interior designer move-in consult',      thresholds: { scheduled: 'pre_close', in_progress: 'closing', complete: 'post_close' } },
  { name: '2% refi credit — active post-close',     thresholds: { scheduled: 'pre_close', complete: 'post_close' } },
];

// Per-upsell stage thresholds
const FP_UPSELL_THRESHOLDS: Record<FastPassUpsellId, Parameters<typeof fpStatusAt>[1]> = {
  utility_setup:       { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
  deep_clean:          { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
  moving_coordination: { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
  refi_monitoring:     { scheduled: 'closing',   in_progress: 'post_close', complete: 'post_close' },
  home_warranty:       { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
  inspection_followup: { in_progress: 'under_contract', complete: 'pre_close' },
  address_change:      { scheduled: 'closing',   in_progress: 'post_close', complete: 'post_close' },
  storage_research:    { in_progress: 'pre_close', complete: 'closing' },
  new_construction:    { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
  staging_consult:     { scheduled: 'pre_close', in_progress: 'closing',  complete: 'post_close' },
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

  const doneCount = allServices.filter((s) => s.status === 'complete').length;

  return (
    <div className="rounded-2xl overflow-hidden border border-green-200 bg-white">
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
        <div className="mt-2.5 flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-green-600 overflow-hidden">
            <div
              className="h-full rounded-full bg-green-300 transition-all"
              style={{ width: `${Math.round((doneCount / allServices.length) * 100)}%` }}
            />
          </div>
          <span className="text-[11px] font-bold text-green-200">
            {doneCount}/{allServices.length} done
          </span>
        </div>
      </div>

      {/* Service list */}
      <div className="divide-y divide-gray-50">
        {allServices.map((svc, i) => {
          const cfg = FP_STATUS_CFG[svc.status];
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <div className={`h-2 w-2 flex-shrink-0 rounded-full ${cfg.dotCls}`} />
              <span className={`flex-1 text-sm ${svc.status === 'complete' ? 'line-through text-gray-300' : 'text-gray-700'}`}>
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

function StageCard({ deal, firstName }: { deal: Deal; firstName: string; onRefresh?: () => void }) {
  switch (deal.stage) {
    case 'intake':         return <IntakeCard deal={deal} firstName={firstName} />;
    case 'active_search':  return <ActiveSearchCard deal={deal} />;
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
  const { completedIds, error: completeError, complete: handleComplete } = useTaskCompletion(refreshTasks);
  // After a TaskCard upload confirms, refresh the deal's Documents tab in-session.
  const invalidateDocuments = useCallback(() => {
    if (deal) void queryClient.invalidateQueries({ queryKey: ['documents', deal.id] });
  }, [queryClient, deal]);
  const buyerTasks = tasks.filter((t) => t.assignedTo === 'buyer');
  const openTasks = buyerTasks.filter((t) => t.status !== 'completed' && !completedIds.has(t.id));
  // Union real + optimistic ids so a refetched 'completed' task isn't counted twice.
  const completedCount = new Set(
    buyerTasks.filter((t) => t.status === 'completed').map((t) => t.id).concat([...completedIds]),
  ).size;

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

  return (
    <div className="mx-auto max-w-lg space-y-4 pb-10">
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
              <p className="font-bold text-brand-navy text-lg">${deal.property.price.toLocaleString()}</p>
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

      {/* Overdue alert — right after header, before journey */}
      {buyerTasks.some((t) => t.status === 'overdue') && (
        <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-100 px-4 py-3">
          <AlertCircle size={18} className="text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-red-700">You have overdue tasks</p>
            <p className="text-xs text-red-400">Your agent is waiting — take a look below</p>
          </div>
        </div>
      )}

      {/* Journey tracker */}
      <div className={buyerTasks.some((t) => t.status === 'overdue') ? 'pt-6' : ''}>
        <JourneyTracker deal={deal} />
      </div>

      {/* Stage-specific card */}
      <StageCard deal={deal} firstName={firstName} onRefresh={refreshDeals} />

      {/* Fast Pass tracker (enrolled) or pitch (unenrolled) */}
      {deal.stage !== 'intake' && (
        deal.fastPass?.status === 'active'
          ? <FastPassTracker deal={deal} />
          : deal.stage !== 'post_close' && <FastPassPitch dealId={deal.id} />
      )}

      {/* Tabs (hidden on post-close to keep it clean) */}
      {deal.stage !== 'post_close' && (
        <>
          <div className="pt-6" />
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
                  <p className="text-sm font-medium text-gray-500">All caught up — great work!</p>
                </div>
              )}
              {openTasks.filter((t) => t.status === 'overdue').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} onUploaded={invalidateDocuments} />)}
              {openTasks.filter((t) => t.status === 'in_progress').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} onUploaded={invalidateDocuments} />)}
              {openTasks.filter((t) => t.status === 'pending').map((t) => <TaskCard key={t.id} task={t} onComplete={handleComplete} onUploaded={invalidateDocuments} />)}
              {completedCount > 0 && (
                <p className="text-center text-xs text-gray-300 pt-1">
                  {completedCount} task{completedCount !== 1 ? 's' : ''} completed
                </p>
              )}
            </div>
          )}
          {activeTab === 'messages' && <MessagesTab dealId={deal.id} />}
          {activeTab === 'documents' && <PortalDealDocuments dealId={deal.id} />}
        </>
      )}

      {/* Lender card */}
      <div className="pt-14">
        <LenderCard deal={deal} />
      </div>

      {/* Agent's preferred vendor directory */}
      <VendorDirectory dealId={deal.id} />

      {/* Agent card */}
      <AgentCard agentName={deal.agentName} agentEmail={deal.agentEmail} agentPhone={deal.agentPhone} />
    </div>
  );
}
