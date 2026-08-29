'use client';

/**
 * "Your preferences" — the client portal's opt-in way back into the
 * questionnaire (#427).
 *
 * ⚠️ Read this before changing it. #407 was the worst bug the app has shipped:
 * a client who had just finished onboarding was met with "Begin my onboarding"
 * forever. `ClientIntakeCard` owns the not-yet-submitted case and is the ONLY
 * thing allowed to ask a client to do onboarding.
 *
 * This card is the mirror image and must stay that way:
 *   - it renders ONLY when an intake is already on file (`intakeSubmitted`),
 *     which is exactly when the onboarding CTA is gone;
 *   - it is a reference entry point, not a task — no badge, no count, no
 *     "action needed", and it lives in the portal's secondary (reference) rail
 *     rather than the actions region;
 *   - the copy says the answers are saved and can be changed, never that
 *     anything is outstanding.
 *
 * If a future change would make this render for a client with no intake, that
 * is #407 coming back — fix the condition, don't soften the copy.
 */

import { useRouter } from 'next/navigation';
import { ChevronRight, ClipboardList } from 'lucide-react';

export default function ClientPreferencesCard({
  role,
  intakeSubmitted,
  reviewHref,
}: {
  role: 'buyer' | 'seller';
  /** True once `deals.intake` is populated. No intake → this card is not shown. */
  intakeSubmitted?: boolean;
  /** `/onboard/buyer?review=true` | `/onboard/seller?review=true`. */
  reviewHref: string;
}) {
  const router = useRouter();

  // Nothing to review yet — and never a second prompt to go and do onboarding.
  if (!intakeSubmitted) return null;

  const blurb =
    role === 'buyer'
      ? 'What you told us about the home you want — budget, areas, must-haves.'
      : 'What you told us about your property, your timeline, and your priorities.';

  return (
    <div
      data-testid="client-preferences"
      className="rounded-2xl border border-gray-200 bg-white p-5"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <ClipboardList size={16} className="flex-shrink-0 text-brand-navy" />
        <p className="text-sm font-bold text-brand-navy">Your preferences</p>
      </div>
      <p className="mb-4 text-sm leading-relaxed text-gray-500">
        {blurb} Saved and shared with your agent — change it any time.
      </p>
      <button
        onClick={() => router.push(reviewHref)}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-gray-100 py-3 text-sm font-bold text-brand-navy transition-colors hover:bg-gray-200"
      >
        Review my answers <ChevronRight size={15} />
      </button>
    </div>
  );
}
