'use client';

/**
 * The client portal's "Getting Started" stage card (#407).
 *
 * Previously duplicated as a local `IntakeCard` in BuyerView and SellerView,
 * each of which rendered the "Begin my onboarding →" CTA unconditionally for
 * any deal in stage `intake`. Because submitting the questionnaire never moved
 * the deal off `intake`, every invited client was returned to this card and
 * asked to redo the onboarding they had just finished.
 *
 * The server side now advances the deal (lib/intake.ts). This component is the
 * belt-and-braces half: once an intake is on file the CTA is gone regardless of
 * stage, which also un-sticks the deals that were already stranded in `intake`
 * before the fix.
 *
 * Shared by both portals so the rule lives in ONE place — the role only picks
 * the palette and the copy.
 */

import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';

type ClientRole = 'buyer' | 'seller';

const ROLE_COPY: Record<
  ClientRole,
  { gradient: string; blurb: string; bullets: string[] }
> = {
  buyer: {
    gradient: 'from-brand-navy to-blue-800',
    blurb:
      'Your agent has set up your home buying portal. Answer a few quick questions to personalize your search — takes about 3 minutes.',
    bullets: [
      "🏠  What you're looking for",
      '💰  Your buying power',
      '📋  Your personal deal portal',
    ],
  },
  seller: {
    gradient: 'from-purple-700 to-indigo-800',
    blurb:
      'Your agent has set up your home selling portal. Answer a few quick questions so we can personalize your experience — takes about 3 minutes.',
    bullets: [
      '🏠  About your property',
      '📋  Your selling timeline',
      '📱  Your personal deal portal',
    ],
  },
};

export default function ClientIntakeCard({
  role,
  firstName,
  intakeSubmitted,
  onboardHref,
}: {
  role: ClientRole;
  firstName: string;
  /** True once `deals.intake` is populated — suppresses the onboarding CTA. */
  intakeSubmitted?: boolean;
  /** Where the CTA sends the client (`/onboard/buyer?agent=…` | `/onboard/seller`). */
  onboardHref: string;
}) {
  const router = useRouter();
  const copy = ROLE_COPY[role];

  // Already onboarded: never re-prompt. Editing the answers later is a separate
  // opt-in entry point (#427), deliberately not offered here.
  if (intakeSubmitted) {
    return (
      <div className={`rounded-2xl bg-gradient-to-br ${copy.gradient} p-5 text-white`}>
        <p className="text-xs font-bold uppercase tracking-widest text-white/50 mb-1">
          Getting Started
        </p>
        <p className="text-xl font-black mb-2">Thanks, {firstName}!</p>
        <p className="text-sm text-white/70 leading-relaxed">
          We got your answers. Your agent is reviewing your answers now and will be in
          touch shortly — nothing else for you to do right here.
        </p>
        <div className="mt-4 flex items-center gap-2 rounded-xl bg-white/10 px-4 py-3 text-sm font-semibold text-white/90">
          <CheckCircle2 size={16} className="flex-shrink-0" />
          Onboarding complete
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-2xl bg-gradient-to-br ${copy.gradient} p-5 text-white`}>
      <p className="text-xs font-bold uppercase tracking-widest text-white/50 mb-1">
        Getting Started
      </p>
      <p className="text-xl font-black mb-2">Welcome, {firstName}!</p>
      <p className="text-sm text-white/70 mb-5 leading-relaxed">{copy.blurb}</p>
      <div className="space-y-2 mb-5">
        {copy.bullets.map((item) => (
          <div key={item} className="flex items-center gap-2 text-sm text-white/75">
            {item}
          </div>
        ))}
      </div>
      <button
        onClick={() => router.push(onboardHref)}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-gold py-3.5 text-sm font-bold text-brand-navy hover:bg-brand-gold/90 transition-colors"
      >
        Begin my onboarding →
      </button>
    </div>
  );
}
