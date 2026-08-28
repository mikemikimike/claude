"use client";

/**
 * Shared constants + helpers for the DealDetail tab/modal modules (#87).
 *
 * These were module-level in DealDetail.tsx before the god-component was split.
 * They live here because they're referenced by more than one of the extracted
 * files (or, like ClosingDaysBadge / STAGE_GATE, were defined in one cluster but
 * consumed by another). Pure cut-paste — no behavior change.
 */

import { useState } from "react";
import { CheckCircle2, Loader2, AlertCircle, Circle } from "lucide-react";
import { Deal, DealStage } from "@/lib/types";

// Stage constants live in lib/stages.ts (#89); re-exported here for the
// deal tab/modal modules that already import them from this file.
export { AGENT_STAGE_LABELS as STAGE_LABELS, STAGE_ORDER } from "@/lib/stages";

export const STAGE_DRAFT_MESSAGE: Partial<Record<DealStage, (deal: Deal) => string>> = {
  active_search: (d) => d.type === 'buy'
    ? `Hi ${d.clientName.split(' ')[0]}! Your home search portal is officially open. I'm setting up a custom property search for you now and will start sending listings your way. Your first step is completing the intake questionnaire in your portal — it only takes a few minutes!`
    : `Hi ${d.clientName.split(' ')[0]}! I've opened your seller portal and we're moving into listing prep. I'll be in touch shortly to schedule your listing strategy call. In the meantime, take a look at the prep checklist in your portal!`,
  offer_active: (d) => d.type === 'buy'
    ? `Great news, ${d.clientName.split(' ')[0]}! Your offer on ${d.property.address} has been submitted. Keep your phone nearby — the seller typically responds within 24–48 hours and I may need a quick answer from you if they counter.`
    : `${d.clientName.split(' ')[0]}, you have an offer on the table! I'm reviewing the details now and will call you shortly to walk through everything.`,
  under_contract: (d) => d.type === 'buy'
    ? `Congratulations, ${d.clientName.split(' ')[0]}! You're officially under contract on ${d.property.address}. I've kicked off the inspection scheduling and your loan team has been notified. Track every milestone in your portal — I'll keep it updated in real time.`
    : `${d.clientName.split(' ')[0]}, you have an accepted offer! The buyer's inspection, financing, and appraisal are all being tracked in your portal. I'll keep you posted as each milestone is hit.`,
  pre_close: (d) =>
    `${d.clientName.split(' ')[0]}, we're almost there! I'll be reaching out this week to schedule your final walkthrough. Closing is coming up fast — let me know if you have any questions before the big day.`,
  closing: (d) =>
    `${d.clientName.split(' ')[0]}, it's closing day! Everything is confirmed. Don't forget to bring a government-issued photo ID. I'll see you there!`,
  post_close: (d) => d.type === 'buy'
    ? `Congratulations, ${d.clientName.split(' ')[0]}! You're officially a homeowner! 🏡 It was such a pleasure helping you through this. Check your portal for your move-in checklist. When you get a moment, a quick review would mean the world to us!`
    : `Congratulations, ${d.clientName.split(' ')[0]}! Your home has officially sold! 🎉 Your net proceeds summary is in your portal. It was a pleasure working with you — if you know anyone buying or selling, send them our way and we'll pay you $50!`,
};

export const HEALTH_BORDER: Record<string, string> = {
  green: 'border-green-400',
  yellow: 'border-amber-400',
  red: 'border-red-400',
};

export const HEALTH_BADGE: Record<string, string> = {
  green: 'bg-green-100 text-green-700',
  yellow: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
};

/**
 * The completion-icon convention, for the whole app (#420).
 *
 * A **green check means the thing actually happened.** Nothing else earns one:
 *
 *   - not done yet          → an open `Circle`
 *   - underway              → its own visual (the spinner below, a status pill)
 *   - merely *forecast*     → an arrow / bullet, never a check
 *     (the stage-advance modal's "will run automatically" list)
 *   - merely *positionally past* → not a completion signal at all
 *     (the portals' journey rails: a stage the deal has walked past with tasks
 *     still open renders an open circle plus an "N tasks open" note)
 *   - merely *implied by the deal's stage* → not a completion signal either
 *     (the Fast Pass tracker: a paid service is never reported Complete
 *     without a real completion signal — see `fpStatusAt` in BuyerView)
 *
 * This map is the canonical statement of it: `pending` is grey and open,
 * `completed` — and only `completed` — is a green check.
 */
export const TASK_STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 size={16} className="text-green-500" />,
  in_progress: <Loader2 size={16} className="text-blue-500 animate-spin" />,
  overdue: <AlertCircle size={16} className="text-red-500" />,
  pending: <Circle size={16} className="text-gray-300" />,
  blocked: <AlertCircle size={16} className="text-orange-500" />,
};

export const FLAG_LABELS: Record<string, string> = {
  fast_pass: 'Fast Pass',
  repair_request: 'Repair Request',
  mountain_mortgage: 'Mtn Mortgage',
  asap_timeline: 'ASAP Timeline',
  also_buying: 'Also Buying',
};

export function formatTimestamp(ts: string) {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export const STAGE_GATE: Partial<Record<DealStage, { name: string; note: string }>> = {
  active_search: { name: 'Buyer Agency Agreement', note: 'Required before showing properties' },
  under_contract: { name: 'Purchase Agreement', note: 'Must be signed to enter contract' },
  closing: { name: 'Wire / Cashier\'s Check Confirmation', note: 'Confirm funds before closing' },
};

// Reads Date.now() once per mount via useState's lazy initializer — keeps
// the parent render pure (react-hooks/purity rule).
export function ClosingDaysBadge({ closingDate }: { closingDate: string }) {
  const [days] = useState(() =>
    Math.max(0, Math.round((new Date(closingDate).getTime() - Date.now()) / 86_400_000))
  );
  return <span className="font-bold text-brand-navy">({days}d)</span>;
}
