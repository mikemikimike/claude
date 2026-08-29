'use client';

/**
 * The orienting frame at the top of a client portal (#422).
 *
 * A tester opening the buyer portal cold said "I don't even know what I'm
 * looking at" — the portal was a stack of stage-specific cards with nothing
 * saying where the client was or what moved them on. This card is the answer to
 * the first and third of the three questions the top of the portal has to
 * answer immediately:
 *
 *   1. Where am I?          → the stage label + its plain-language description
 *   3. Who moves this on?   → AGENT_GUIDANCE_LINE, on EVERY stage
 *
 * (Question 2 — "what do I need to do" — is the labelled actions section
 * underneath, in each portal.)
 *
 * Shared by the buyer and seller portals so the guidance line exists once. The
 * stage vocabulary differs per role, so the label and description are passed
 * in; only the palette is switched here.
 */

import { UserCheck } from 'lucide-react';

/**
 * The line Paul asked for near-verbatim: the client should never be left
 * wondering what triggers the next step. It renders at every stage, in both
 * portals — a test asserts exactly that, so keep it as one exported constant
 * rather than re-typing the copy per portal.
 */
export const AGENT_GUIDANCE_LINE =
  "Your agent will move you along this process — you'll get a notification when something needs you.";

export default function PortalStageHeader({
  stageLabel,
  description,
  accent = 'navy',
}: {
  /** e.g. "Home Search" — the role's own label for the current stage. */
  stageLabel: string;
  /** One plain sentence saying what that stage actually means. */
  description: string;
  accent?: 'navy' | 'purple';
}) {
  const purple = accent === 'purple';

  return (
    <section
      data-testid="portal-stage-header"
      aria-label="Where you are"
      className={`rounded-2xl border bg-white p-5 shadow-sm ${
        purple ? 'border-purple-200' : 'border-brand-navy/15'
      }`}
    >
      <p
        className={`text-[11px] font-bold uppercase tracking-widest ${
          purple ? 'text-purple-500' : 'text-brand-navy/50'
        }`}
      >
        Where you are
      </p>
      <h2 className="mt-1 text-xl font-black leading-snug text-brand-navy">{stageLabel}</h2>
      <p className="mt-1 text-sm leading-relaxed text-gray-500">{description}</p>

      <div
        className={`mt-3.5 flex items-start gap-2.5 rounded-xl px-3.5 py-3 ${
          purple ? 'bg-purple-50 text-purple-900' : 'bg-brand-navy/5 text-brand-navy/80'
        }`}
      >
        <UserCheck
          size={15}
          className={`mt-0.5 flex-shrink-0 ${purple ? 'text-purple-500' : 'text-brand-navy/60'}`}
        />
        <p className="text-xs font-medium leading-relaxed">{AGENT_GUIDANCE_LINE}</p>
      </div>
    </section>
  );
}
