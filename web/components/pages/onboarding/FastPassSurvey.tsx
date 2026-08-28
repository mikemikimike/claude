"use client";

import { useState } from 'react';
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { CheckCircle2, ChevronRight, ChevronLeft, Check } from 'lucide-react';
import {
  FastPassUpsellId,
  FAST_PASS_UPSELLS,
  calcFastPassTotal,
  FAST_PASS_BASE_PRICE,
} from "@/lib/fast-pass-display";
// Single source of truth for enrollment pricing (#280) — the server prices
// enrollments from this same helper, so the basket we show is the basket that
// gets persisted. (The +15% "pay at closing" premium no longer applies here:
// the survey chooses no payment option — #439.)
import { computeFastPassTotalCents } from "@/lib/fast-pass-catalog";
import { api } from "@/lib/api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

type SurveyData = {
  currentSituation: string;
  targetMoveDate: string;
  dateFlexibility: string;
  moveSize: string;
  moverPreference: string;
  packingPreference: string;
  utilities: string[];
  notes: string;
};

const EMPTY: SurveyData = {
  currentSituation: '',
  targetMoveDate: '',
  dateFlexibility: '',
  moveSize: '',
  moverPreference: '',
  packingPreference: '',
  utilities: [],
  notes: '',
};

// FastPassDetail stashes its payload in sessionStorage before router.push —
// Next.js has no react-router `{ state }` second arg. Read it once on mount;
// cleared only after a successful enrollment submit.
export const HANDOFF_KEY = 'fastPassSurveyState';

type SurveyHandoff = {
  dealId?: string | null;
  selectedUpsells?: FastPassUpsellId[];
  total?: number;
};

function readHandoff(): SurveyHandoff | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    return raw ? (JSON.parse(raw) as SurveyHandoff) : null;
  } catch {
    return null;
  }
}

// A 400 that mentions the promo code means the server rejected the code (#281):
// unknown / expired / wrong product / past max_uses. Pull that human reason out
// of the thrown ApiError (duck-typed by shape — `status` + `message` — so it
// stays robust even when the api-client module is mocked) and show it inline
// instead of the generic submit error.
function promoReasonFromError(err: unknown): string | null {
  if (
    err &&
    typeof err === 'object' &&
    (err as { status?: unknown }).status === 400 &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    const msg = (err as { message: string }).message;
    const idx = msg.toLowerCase().indexOf('promo code');
    if (idx >= 0) {
      const reason = msg.slice(idx).trim();
      return reason.charAt(0).toUpperCase() + reason.slice(1);
    }
  }
  return null;
}

const UTILITY_OPTIONS = [
  'Electric',
  'Natural Gas',
  'Water / Sewer',
  'Internet',
  'Cable / Streaming',
  'Trash & Recycling',
  'Home Security',
];

const TOTAL_SCREENS = 5;

// ─── Shared UI ────────────────────────────────────────────────────────────────

// Money for display. Whole-dollar amounts stay clean ("$3,074"); the +15%
// "pay at closing" premium introduces cents, which we then show to the penny
// ("$3,423.55") so the figure on screen matches what the server charges (#280).
function formatDollars(amount: number): string {
  return amount.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function Question({ text, note }: { text: string; note?: string }) {
  return (
    <div className="mb-7 text-center">
      <h2 className="text-2xl font-bold leading-snug text-brand-navy">{text}</h2>
      {note && <p className="mt-2 text-sm text-gray-400">{note}</p>}
    </div>
  );
}

function OptionBtn({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub?: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full rounded-xl py-3.5 px-4 text-left transition-all active:scale-[0.98]',
        selected
          ? 'bg-brand-navy text-white'
          : 'bg-gray-100 text-brand-navy hover:bg-gray-200',
      ].join(' ')}
    >
      <div className="font-bold text-sm">{label}</div>
      {sub && (
        <div
          className={[
            'text-xs mt-0.5',
            selected ? 'text-white/60' : 'text-gray-400',
          ].join(' ')}
        >
          {sub}
        </div>
      )}
    </button>
  );
}

// ─── Screen 0: Move Basics ────────────────────────────────────────────────────

function MoveSituationScreen({
  data,
  onChange,
  onNext,
}: {
  data: SurveyData;
  onChange: (k: keyof SurveyData, v: string) => void;
  onNext: () => void;
}) {
  const situations = [
    { value: 'renting', label: 'Currently renting', sub: "I'll move out of a rental" },
    { value: 'selling', label: 'Selling my current home', sub: 'Coordinating two transactions' },
    { value: 'relocating', label: 'Relocating from out of state', sub: 'Long-distance move' },
    { value: 'other', label: 'Other situation', sub: "My concierge will ask me more" },
  ];
  const flexOptions = [
    { value: 'firm', label: 'Hard deadline — must hit it' },
    { value: 'somewhat', label: "Somewhat flexible (±2 weeks)" },
    { value: 'flexible', label: 'Very flexible' },
  ];

  const canContinue = data.currentSituation && data.targetMoveDate && data.dateFlexibility;

  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text="Tell us about your move" note="We'll use this to start coordinating right away" />
      <div className="w-full max-w-sm space-y-5">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Current situation
          </div>
          <div className="space-y-2">
            {situations.map((s) => (
              <OptionBtn
                key={s.value}
                label={s.label}
                sub={s.sub}
                selected={data.currentSituation === s.value}
                onClick={() => onChange('currentSituation', s.value)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            When do you want to move in?
          </div>
          <div className="space-y-2">
            {[
              { value: 'day_of_closing', label: 'Day of closing' },
              { value: 'after_closing', label: 'After closing' },
            ].map((opt) => (
              <OptionBtn
                key={opt.value}
                label={opt.label}
                selected={data.targetMoveDate === opt.value}
                onClick={() => onChange('targetMoveDate', opt.value)}
              />
            ))}
          </div>
          <textarea
            value={['day_of_closing', 'after_closing'].includes(data.targetMoveDate) ? '' : data.targetMoveDate}
            onChange={(e) => onChange('targetMoveDate', e.target.value)}
            placeholder="Please give us details if those answers don't fit what you're looking for"
            rows={3}
            className="mt-2 w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Date flexibility
          </div>
          <div className="space-y-2">
            {flexOptions.map((f) => (
              <OptionBtn
                key={f.value}
                label={f.label}
                selected={data.dateFlexibility === f.value}
                onClick={() => onChange('dateFlexibility', f.value)}
              />
            ))}
          </div>
        </div>

        <button
          onClick={onNext}
          disabled={!canContinue}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition-all',
            canContinue
              ? 'bg-brand-navy text-white hover:bg-brand-navy/80 active:scale-[0.98]'
              : 'cursor-not-allowed bg-gray-100 text-gray-300',
          ].join(' ')}
        >
          Continue <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Screen 1: Moving Preferences ────────────────────────────────────────────

function MovingPreferencesScreen({
  data,
  onChange,
  onNext,
}: {
  data: SurveyData;
  onChange: (k: keyof SurveyData, v: string) => void;
  onNext: () => void;
}) {
  const sizes = [
    { value: 'studio', label: 'Studio / 1 bed' },
    { value: '2bed', label: '2 bedrooms' },
    { value: '3bed', label: '3 bedrooms' },
    { value: '4plus', label: '4+ bedrooms' },
  ];
  const movers = [
    { value: 'coordinate', label: 'Coordinate movers for me', sub: 'Included in Fast Pass' },
    { value: 'booked', label: "I've already booked movers" },
    { value: 'self', label: "I'm handling it myself" },
  ];
  const packing = [
    { value: 'full', label: 'Full service — they pack everything' },
    { value: 'partial', label: 'Partial — I pack valuables, they do the rest' },
    { value: 'self', label: "Self-pack — I'll handle all packing" },
  ];

  const canContinue = data.moveSize && data.moverPreference && data.packingPreference;

  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text="How are you moving?" />
      <div className="w-full max-w-sm space-y-5">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Home size
          </div>
          <div className="grid grid-cols-2 gap-2">
            {sizes.map((s) => (
              <OptionBtn
                key={s.value}
                label={s.label}
                selected={data.moveSize === s.value}
                onClick={() => onChange('moveSize', s.value)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Moving company
          </div>
          <div className="space-y-2">
            {movers.map((m) => (
              <OptionBtn
                key={m.value}
                label={m.label}
                sub={m.sub}
                selected={data.moverPreference === m.value}
                onClick={() => onChange('moverPreference', m.value)}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Packing preference
          </div>
          <div className="space-y-2">
            {packing.map((p) => (
              <OptionBtn
                key={p.value}
                label={p.label}
                selected={data.packingPreference === p.value}
                onClick={() => onChange('packingPreference', p.value)}
              />
            ))}
          </div>
        </div>

        <button
          onClick={onNext}
          disabled={!canContinue}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition-all',
            canContinue
              ? 'bg-brand-navy text-white hover:bg-brand-navy/80 active:scale-[0.98]'
              : 'cursor-not-allowed bg-gray-100 text-gray-300',
          ].join(' ')}
        >
          Continue <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Screen 2: Utilities ──────────────────────────────────────────────────────

function UtilitiesScreen({
  data,
  onChange,
  onNext,
}: {
  data: SurveyData;
  onChange: (k: keyof SurveyData, v: string[]) => void;
  onNext: () => void;
}) {
  function toggle(util: string) {
    const prev = data.utilities;
    onChange(
      'utilities',
      prev.includes(util) ? prev.filter((u) => u !== util) : [...prev, util]
    );
  }

  return (
    <div className="screen-enter flex flex-col items-center">
      <Question
        text="Which utilities need to be set up?"
        note="We'll contact providers and schedule start dates for the ones you select"
      />
      <div className="w-full max-w-sm space-y-4">
        <div className="space-y-2">
          {UTILITY_OPTIONS.map((util) => {
            const selected = data.utilities.includes(util);
            return (
              <button
                key={util}
                onClick={() => toggle(util)}
                className={[
                  'flex w-full items-center gap-3 rounded-xl px-4 py-3.5 transition-all active:scale-[0.98]',
                  selected
                    ? 'bg-brand-navy text-white'
                    : 'bg-gray-100 text-brand-navy hover:bg-gray-200',
                ].join(' ')}
              >
                <div
                  className={[
                    'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded border-2 transition-all',
                    selected
                      ? 'border-white bg-white'
                      : 'border-gray-300 bg-white',
                  ].join(' ')}
                >
                  {selected && <Check size={11} className="text-brand-navy" strokeWidth={3} />}
                </div>
                <span className="text-sm font-semibold">{util}</span>
              </button>
            );
          })}
        </div>

        <p className="text-center text-xs text-gray-400">
          Select all that apply — or skip if you&apos;re handling utilities yourself
        </p>

        <button
          onClick={onNext}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-4 text-base font-bold text-white hover:bg-brand-navy/80 transition-all active:scale-[0.98]"
        >
          Continue <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Screen 3: Notes ─────────────────────────────────────────────────────────

function NotesScreen({
  data,
  onChange,
  onNext,
}: {
  data: SurveyData;
  onChange: (k: keyof SurveyData, v: string) => void;
  onNext: () => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question
        text="Anything else we should know?"
        note="Special access requirements, tight deadlines, or anything unique about your situation"
      />
      <div className="w-full max-w-sm">
        <textarea
          value={data.notes}
          onChange={(e) => onChange('notes', e.target.value)}
          placeholder="e.g. Need elevator access at the new building. Closing date may shift by a week..."
          rows={5}
          className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
        />
        <button
          onClick={onNext}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-4 text-base font-bold text-white hover:bg-brand-navy/80 transition-all active:scale-[0.98]"
        >
          Review & Submit <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Screen 4: Confirmation ───────────────────────────────────────────────────

// #439 — this screen used to end in a payment-option picker (pay now / at
// closing / seller concession) that took a card at the end of a questionnaire.
// Payment moved to the buyer's dashboard (#440); the review below is where the
// survey now stops. Nothing here charges anything.
function ConfirmationScreen({
  data,
  selectedUpsells,
  total,
  submitting,
  submitError,
  promoError,
  onSubmit,
}: {
  data: SurveyData;
  selectedUpsells: FastPassUpsellId[];
  total: number;
  submitting?: boolean;
  submitError?: boolean;
  promoError?: string | null;
  onSubmit: (promoCode: string) => void;
}) {
  // Promo code (#281) is validated SERVER-SIDE on submit — this input is UX
  // only; the server is the boundary and recomputes any discount from the code.
  const [promoCode, setPromoCode] = useState('');
  const upsellItems = FAST_PASS_UPSELLS.filter((u) => selectedUpsells.includes(u.id));
  const situationLabels: Record<string, string> = {
    renting: 'Currently renting',
    selling: 'Selling current home',
    relocating: 'Relocating from out of state',
    other: 'Other',
  };

  return (
    <div className="screen-enter flex flex-col items-center">
      <Question
        text="Review & confirm"
        note="Nothing is charged here — you'll choose how to pay from your dashboard"
      />
      <div className="w-full max-w-sm space-y-4">
        {/* Move summary */}
        <div className="rounded-2xl bg-white shadow-sm divide-y divide-gray-50">
          <div className="px-4 py-3">
            <div className="text-xs text-gray-400 font-medium">Situation</div>
            <div className="text-sm font-semibold text-brand-navy mt-0.5">
              {situationLabels[data.currentSituation] ?? data.currentSituation}
            </div>
          </div>
          {data.targetMoveDate && (
            <div className="px-4 py-3">
              <div className="text-xs text-gray-400 font-medium">Target move-in</div>
              <div className="text-sm font-semibold text-brand-navy mt-0.5">
                {({ day_of_closing: 'Day of closing', after_closing: 'After closing' } as Record<string, string>)[data.targetMoveDate] ?? data.targetMoveDate}
                {data.dateFlexibility === 'firm' && (
                  <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    Hard deadline
                  </span>
                )}
              </div>
            </div>
          )}
          {data.utilities.length > 0 && (
            <div className="px-4 py-3">
              <div className="text-xs text-gray-400 font-medium">
                Utilities ({data.utilities.length})
              </div>
              <div className="text-sm text-brand-navy mt-0.5">{data.utilities.join(', ')}</div>
            </div>
          )}
        </div>

        {/* Pricing breakdown */}
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-50">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Fast Pass base</span>
              <span className="text-sm font-semibold text-brand-navy">${FAST_PASS_BASE_PRICE.toLocaleString()}</span>
            </div>
          </div>
          {upsellItems.map((u) => (
            <div key={u.id} className="flex items-center justify-between px-4 py-2.5 border-b border-gray-50">
              <span className="text-sm text-gray-600">{u.name}</span>
              <span className="text-sm font-semibold text-brand-navy">+${u.price}</span>
            </div>
          ))}
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50">
            <span className="text-sm font-bold text-brand-navy">Total</span>
            <span className="text-base font-black text-brand-navy">${total.toLocaleString()}</span>
          </div>
        </div>

        {/* Promo code (#281) — optional; validated server-side on submit */}
        <div>
          <label htmlFor="promo-code" className="mb-2 block text-xs font-bold uppercase tracking-wider text-gray-400">
            Promo code (optional)
          </label>
          <input
            id="promo-code"
            type="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={promoCode}
            onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
            placeholder="Enter code"
            className={[
              'w-full rounded-xl border-2 bg-white px-4 py-3 text-sm font-semibold uppercase tracking-wide text-brand-navy placeholder:font-normal placeholder:normal-case placeholder:tracking-normal placeholder:text-gray-300 focus:outline-none',
              promoError ? 'border-red-300 focus:border-red-400' : 'border-gray-100 focus:border-brand-navy',
            ].join(' ')}
          />
          {promoError && <p className="mt-1.5 text-xs font-medium text-red-500">{promoError}</p>}
        </div>

        {submitError && (
          <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3">
            <p className="text-sm font-semibold text-red-700">We couldn&apos;t submit your enrollment.</p>
            <p className="text-xs text-red-400">Nothing was charged — please try again.</p>
          </div>
        )}

        <button
          onClick={() => !submitting && onSubmit(promoCode.trim())}
          disabled={submitting}
          className={[
            'flex w-full items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition-all',
            !submitting
              ? 'bg-green-500 text-white hover:bg-green-600 active:scale-[0.98]'
              : 'cursor-not-allowed bg-gray-100 text-gray-300',
          ].join(' ')}
        >
          {submitting ? 'Processing…' : 'Submit Request'} <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

// ─── Submitted ────────────────────────────────────────────────────────────────

// #439 — the survey takes no money, so this screen must not read like a
// receipt. It confirms the enrollment, states plainly that nothing was
// charged, and points at the dashboard where FF17 (#440) collects payment.
function SubmittedScreen({ total }: { total: number }) {
  const router = useRouter();
  const activeUser = useAuthStore((s) => s.activeUser);
  function goToDashboard() {
    // Real identity only — never a mock id. Logged-in buyers land on their own
    // dashboard; anyone else (or no session) goes to the app root to re-route.
    if (activeUser?.groupId === 'buyer') {
      router.push(`/buyer/${activeUser.id}`);
    } else {
      router.push('/');
    }
  }

  return (
    <div className="screen-enter flex flex-col items-center py-8 text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100">
        <CheckCircle2 size={34} className="text-green-500" />
      </div>
      <h2 className="text-3xl font-black text-brand-navy">You&apos;re in!</h2>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-gray-500">
        Your Fast Pass details are saved and your concierge has what they need to
        start. Nothing has been charged yet — you&apos;ll pick how to pay from your
        dashboard.
      </p>
      <div className="mt-4 rounded-xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800">
        <span className="font-semibold">Your Fast Pass total:</span>{' '}
        <span className="font-black">${formatDollars(total)}</span>
      </div>
      <p className="mt-3 text-xs text-gray-300">
        Payment options are waiting on your dashboard.
      </p>
      <button
        onClick={goToDashboard}
        className="mt-8 flex items-center gap-2 rounded-xl bg-brand-navy px-8 py-4 text-base font-bold text-white hover:bg-brand-navy/80 transition-all active:scale-[0.98]"
      >
        Go to my dashboard <ChevronRight size={18} />
      </button>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function FastPassSurvey() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromOnboarding = searchParams.get('fromOnboarding') === 'true';
  const [handoff] = useState(readHandoff);
  // A query dealId marks a direct entry point that skips FastPassDetail's
  // upsell picker (e.g. agent DealDetail or Stripe's ?deal_id= cancel-return).
  // Detail's own push carries no query param, so its fresh stash wins there.
  const queryDealId = searchParams.get('dealId') ?? searchParams.get('deal_id');
  const dealId = queryDealId ?? handoff?.dealId ?? null;
  // Only trust the stash's add-ons when it belongs to the deal being enrolled.
  // A query dealId that disagrees means a stale stash from a prior visit; the
  // ConfirmationScreen never re-shows those add-ons, so charging for them would
  // be a silent upsell. Fall the total back to the base price in that case.
  const stashMatches =
    handoff != null && (queryDealId == null || handoff.dealId === queryDealId);
  const selectedUpsells: FastPassUpsellId[] = stashMatches ? handoff?.selectedUpsells ?? [] : [];
  const total = stashMatches ? handoff?.total ?? calcFastPassTotal(selectedUpsells) : calcFastPassTotal([]);

  const [screen, setScreen] = useState(0);
  const [data, setData] = useState<SurveyData>(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  // Server-side promo rejection (#281), surfaced inline next to the code input.
  const [promoError, setPromoError] = useState<string | null>(null);

  const progress = Math.min(((screen + 1) / TOTAL_SCREENS) * 100, 100);

  function set<K extends keyof SurveyData>(key: K, val: SurveyData[K]) {
    setData((d) => ({ ...d, [key]: val }));
  }

  function next() {
    setScreen((s) => Math.min(s + 1, TOTAL_SCREENS - 1));
  }

  function back() {
    if (screen === 0) {
      router.back();
    } else {
      setScreen((s) => Math.max(s - 1, 0));
    }
  }

  if (submitted) {
    return (
      <div className="flex min-h-screen flex-col bg-white px-4 py-8">
        <SubmittedScreen total={total} />
      </div>
    );
  }

  function renderScreen() {
    switch (screen) {
      case 0:
        return (
          <MoveSituationScreen
            data={data}
            onChange={(k, v) => set(k, v as SurveyData[typeof k])}
            onNext={next}
          />
        );
      case 1:
        return (
          <MovingPreferencesScreen
            data={data}
            onChange={(k, v) => set(k, v as SurveyData[typeof k])}
            onNext={next}
          />
        );
      case 2:
        return (
          <UtilitiesScreen
            data={data}
            onChange={(k, v) => set(k, v as SurveyData[typeof k])}
            onNext={next}
          />
        );
      case 3:
        return (
          <NotesScreen
            data={data}
            onChange={(k, v) => set(k, v as SurveyData[typeof k])}
            onNext={next}
          />
        );
      case 4:
        return (
          <ConfirmationScreen
            data={data}
            selectedUpsells={selectedUpsells}
            total={total}
            submitting={submitting}
            submitError={submitError}
            promoError={promoError}
            onSubmit={async (promoCode) => {
              if (dealId) {
                setSubmitting(true);
                setSubmitError(false);
                setPromoError(null);
                try {
                  // No payment_option (#439): the server persists this as
                  // `pending_payment` and charges nothing. There is therefore
                  // no checkout_url to follow and no Stripe hop from here —
                  // the buyer pays from their dashboard (#440).
                  //
                  // total_cents is priced server-side and ignored on the wire
                  // (#78); send the same shared-helper value so a client/server
                  // disagreement shows up rather than hiding.
                  const totalCents = computeFastPassTotalCents(selectedUpsells);
                  await api.post<{ ok?: boolean; status?: string }>(
                    `/deals/${dealId}/fastpass`,
                    {
                      selected_upsells: selectedUpsells,
                      // Server validates + prices the code; this is a hint only.
                      promo_code: promoCode || undefined,
                      total_cents: totalCents,
                      survey_answers: data,
                    },
                  );
                  sessionStorage.removeItem(HANDOFF_KEY);
                } catch (err) {
                  // Enrollment did not persist — show the error, never the
                  // success screen, and keep the handoff so retry works. A
                  // rejected promo code (#281) gets a specific inline message
                  // so the buyer can fix or drop the code; anything else is the
                  // generic failure.
                  const promoReason = promoReasonFromError(err);
                  if (promoReason) {
                    setPromoError(promoReason);
                  } else {
                    setSubmitError(true);
                  }
                  setSubmitting(false);
                  return;
                }
                setSubmitting(false);
              }
              if (fromOnboarding && !dealId) {
                router.push('/onboard/buyer?resume=true');
              } else {
                setSubmitted(true);
              }
            }}
          />
        );
      default:
        return null;
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-white">
      {/* Progress bar */}
      <div className="sticky top-0 z-10 bg-white">
        <div className="h-1 w-full bg-gray-100">
          <div
            className="h-1 bg-brand-navy transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <button
            onClick={back}
            className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            <ChevronLeft size={16} />
            Back
          </button>
          <span className="text-xs font-medium text-gray-400">
            {screen + 1} of {TOTAL_SCREENS}
          </span>
          <div className="w-12" />
        </div>
      </div>

      {/* Screen content */}
      <div className="flex-1 overflow-y-auto px-4 py-6">{renderScreen()}</div>
    </div>
  );
}
