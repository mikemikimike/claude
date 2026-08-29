"use client";

import { useState, useEffect, useRef } from 'react';
import Image from "next/image";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuthStore } from "@/lib/store/authStore";
import { api } from "@/lib/api-client";
import { CheckCircle2, ChevronRight, ArrowRight } from 'lucide-react';
import OnboardingLayout from './OnboardingLayout';
import PitchPage, { LenderChoice } from './PitchPage';
import IntakeReviewScreen from './IntakeReviewScreen';
import { CASH_SKIP, buildBuyerReview } from '@/lib/intake-review';

// ─── Types ───────────────────────────────────────────────────────────────────

type BuyerData = {
  cashOrLoan: '' | 'cash' | 'loan';
  firstTimeBuyer: string;
  bedrooms: string;
  bathrooms: string;
  areas: string;
  propertyType: string;
  garage: string;
  pool: string;
  schools: string;
  basement: string;
  notes: string;
  military: string;
  employment: string;
  journeyStage: string;
  creditScore: string;
  monthlyIncome: string;
  minBudget: number;
  maxBudget: number;
  lenderChoice: LenderChoice | '';
  trackingAddress: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

const EMPTY: BuyerData = {
  cashOrLoan: '',
  firstTimeBuyer: '', bedrooms: '', bathrooms: '', areas: '', propertyType: '',
  garage: '', pool: '', schools: '', basement: '', notes: '', military: '',
  employment: '', journeyStage: '', creditScore: '', monthlyIncome: '',
  minBudget: 200000, maxBudget: 400000, lenderChoice: '', trackingAddress: '',
  contactName: '', contactPhone: '', contactEmail: '',
};

// ─── Screen definitions (0–14) ────────────────────────────────────────────────

type ScreenType = 'yes_no' | 'options' | 'text' | 'textarea' | 'number';

type ScreenDef = {
  field: keyof BuyerData;
  question: string;
  type: ScreenType;
  options?: string[];
  placeholder?: string;
  note?: string;
};

/**
 * Screens 1–15, in order: screen `n` renders `SCREENS[n - 1]`.
 *
 * Exported for `tests/components/buyer-onboarding.test.tsx`, which pins that
 * mapping against `BUYER_REVIEW_FIELDS` (#427) — a reordered question then
 * breaks a test instead of silently pointing a review row's "Change" button at
 * the wrong screen.
 */
export const SCREENS: ScreenDef[] = [
  { field: 'firstTimeBuyer', question: 'Is this your first time buying a home?', type: 'yes_no' },
  { field: 'bedrooms', question: 'How many bedrooms do you need?', type: 'options', options: ['1', '2', '3', '4+'] },
  { field: 'bathrooms', question: 'How many bathrooms?', type: 'options', options: ['1', '2', '3+'] },
  { field: 'areas', question: 'What areas are you interested in?', type: 'text', placeholder: 'e.g. Hoover, Vestavia Hills, Homewood', note: 'Enter one or more neighborhoods or cities' },
  { field: 'propertyType', question: 'What type of property are you looking for?', type: 'options', options: ['Single Family', 'Condominium', 'Townhome', 'Multi-Family'] },
  { field: 'garage', question: 'Do you need a garage?', type: 'options', options: ['Yes – Attached', 'Yes – Detached', 'Either works', 'Not important'] },
  { field: 'pool', question: 'Pool preference?', type: 'options', options: ['Yes – must have', 'Nice to have', 'Not important'] },
  { field: 'schools', question: 'Any school district preferences?', type: 'text', placeholder: 'e.g. Vestavia Hills City Schools, Oak Mountain', note: 'Leave blank if not a priority' },
  { field: 'basement', question: 'Do you want a basement?', type: 'options', options: ['Yes – must have', 'Nice to have', 'Not important'] },
  { field: 'notes', question: 'Anything else we should know?', type: 'textarea', placeholder: 'Other must-haves, deal-breakers, or priorities…' },
  { field: 'military', question: 'Have you or your spouse served in the military?', type: 'yes_no', note: 'This may qualify you for VA loan benefits' },
  { field: 'employment', question: 'What best describes your employment?', type: 'options', options: ['W-2 Employee', 'Self-Employed', 'Both', 'Other'] },
  { field: 'journeyStage', question: 'Where are you in your home buying journey?', type: 'options', options: ['Already under contract', 'Actively searching now', 'Planning for next year', 'Found a house I love'] },
  { field: 'creditScore', question: 'How would you describe your credit score?', type: 'options', options: ['Good (720+)', 'Solid (660–719)', 'Needs Some Work'] },
  { field: 'monthlyIncome', question: 'What is your gross monthly income?', type: 'number', placeholder: '6,000', note: 'Before taxes · used to estimate your buying power' },
];

// 0 = cash/loan, 1–15 = questions, 16 = budget, 17 = buying power, 18 = pitch,
// 19 = address, 20 = mtn CTA, 21 = contact info, 22 = review (#427), 23 = done
const TOTAL = 24;
/**
 * "Here's what you told us" (#427) — the last step before the questionnaire is
 * sent, and the screen the portal's *Your preferences* link reopens.
 */
export const REVIEW_SCREEN = 22;
// The loan-only screen set now lives in lib/intake-review, because the review
// has to skip exactly the questions this navigation skipped. Two copies would
// let a cash buyer's review list a question they were never asked.
// screen 20 (MTN CTA) is shown only when lenderChoice is 'mountain' or 'fastpass'
const MM_URL = 'https://mountainmortgage-paul.my1003app.com/2233772/register?time=1755484352205';

function shouldSkipScreen(n: number, useCash: boolean, lc: string): boolean {
  if (useCash && CASH_SKIP.has(n)) return true;
  if (n === 20 && lc !== 'mountain' && lc !== 'fastpass') return true;
  return false;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  return `$${(n / 1_000).toFixed(0)}K`;
}

function calcPower(income: string, credit: string) {
  const monthly = parseFloat(income.replace(/,/g, '')) || 0;
  const annual = monthly * 12;
  const map: Record<string, [number, number]> = {
    'Good (720+)': [4.0, 5.0],
    'Solid (660–719)': [3.5, 4.5],
    'Needs Some Work': [2.5, 3.5],
  };
  const [lo, hi] = map[credit] ?? [3.5, 4.5];
  return {
    low: Math.round((annual * lo) / 10000) * 10000,
    high: Math.round((annual * hi) / 10000) * 10000,
  };
}

// ─── Reusable UI ─────────────────────────────────────────────────────────────

function Question({ text, note }: { text: string; note?: string }) {
  return (
    <div className="mb-8 text-center">
      <h2 className="text-2xl font-bold leading-snug text-brand-navy sm:text-3xl">{text}</h2>
      {note && <p className="mt-2 text-sm text-gray-400">{note}</p>}
    </div>
  );
}

function OptionBtn({ label, selected, onClick }: { label: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full rounded-xl py-4 text-center text-base font-bold transition-all active:scale-[0.98]',
        selected
          ? 'bg-brand-navy text-white'
          : 'bg-gray-100 text-brand-navy hover:bg-gray-200',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function ContinueBtn({ onClick, disabled, label = 'Continue' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={[
        'mt-6 flex w-full items-center justify-center gap-2 rounded-xl py-4 text-base font-bold transition-all',
        disabled
          ? 'cursor-not-allowed bg-gray-100 text-gray-300'
          : 'bg-brand-navy text-white hover:bg-brand-navy/80 active:scale-[0.98]',
      ].join(' ')}
    >
      {label} <ChevronRight size={18} />
    </button>
  );
}

// ─── Screen renderers ─────────────────────────────────────────────────────────

function YesNoScreen({ question, note, onSelect }: {
  question: string; note?: string; onSelect: (v: string) => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-xs space-y-3">
        <OptionBtn label="Yes" onClick={() => onSelect('yes')} />
        <OptionBtn label="No" onClick={() => onSelect('no')} />
      </div>
    </div>
  );
}

function OptionsScreen({ question, note, options, onSelect }: {
  question: string; note?: string; options: string[]; onSelect: (v: string) => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-xs space-y-3">
        {options.map((opt) => (
          <OptionBtn key={opt} label={opt} onClick={() => onSelect(opt)} />
        ))}
      </div>
    </div>
  );
}

function TextScreen({ question, note, value, onChange, onContinue, placeholder, multiline }: {
  question: string; note?: string; value: string; onChange: (v: string) => void;
  onContinue: () => void; placeholder?: string; multiline?: boolean;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-sm">
        {multiline ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={4}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
          />
        ) : (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
          />
        )}
        <ContinueBtn onClick={onContinue} />
      </div>
    </div>
  );
}

function NumberScreen({ question, note, value, onChange, onContinue, placeholder }: {
  question: string; note?: string; value: string; onChange: (v: string) => void;
  onContinue: () => void; placeholder?: string;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-sm">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-semibold">$</span>
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 py-3 pl-8 pr-4 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
          />
        </div>
        <ContinueBtn onClick={onContinue} disabled={!value} />
        <button
          onClick={onContinue}
          className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ─── Special screens ──────────────────────────────────────────────────────────

function BudgetScreen({ minBudget, maxBudget, onChange, onContinue }: {
  minBudget: number; maxBudget: number;
  onChange: (field: 'minBudget' | 'maxBudget', val: number) => void;
  onContinue: () => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text="What's your budget range?" note="Drag the sliders to set your min and max" />
      <div className="w-full max-w-sm space-y-8">
        {/* Min */}
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>Minimum</span>
            <span className="text-lg font-black text-brand-navy">{fmt(minBudget)}</span>
          </div>
          <input
            type="range" min={50000} max={900000} step={25000}
            value={minBudget}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChange('minBudget', v);
              if (v >= maxBudget) onChange('maxBudget', v + 50000);
            }}
          />
          <div className="mt-1 flex justify-between text-[11px] text-gray-300">
            <span>$50K</span><span>$900K</span>
          </div>
        </div>
        {/* Max */}
        <div>
          <div className="mb-1 flex justify-between text-xs text-gray-400">
            <span>Maximum</span>
            <span className="text-lg font-black text-brand-navy">{fmt(maxBudget)}</span>
          </div>
          <input
            type="range" min={100000} max={1500000} step={25000}
            value={maxBudget}
            onChange={(e) => {
              const v = Number(e.target.value);
              onChange('maxBudget', v);
              if (v <= minBudget) onChange('minBudget', v - 50000);
            }}
          />
          <div className="mt-1 flex justify-between text-[11px] text-gray-300">
            <span>$100K</span><span>$1.5M</span>
          </div>
        </div>
        <ContinueBtn onClick={onContinue} />
      </div>
    </div>
  );
}

function BuyingPowerScreen({ income, credit, military, onContinue }: {
  income: string; credit: string; military: string; onContinue: () => void;
}) {
  const { low, high } = calcPower(income, credit);
  const hasVA = military === 'yes';

  return (
    <div className="screen-enter flex flex-col items-center text-center">
      <p className="mb-2 text-sm font-semibold uppercase tracking-widest text-gray-400">Your Estimated Buying Power</p>
      <div className="my-4 text-5xl font-black text-brand-navy">
        {low > 0 ? (
          <>{fmt(low)} <span className="text-3xl text-gray-300">–</span> {fmt(high)}</>
        ) : (
          <span className="text-2xl text-gray-400">Enter your income to calculate</span>
        )}
      </div>
      {low > 0 && (
        <p className="mb-2 text-sm text-gray-400">
          Based on your income and <span className="font-medium text-brand-navy">{credit}</span> credit profile
        </p>
      )}
      {hasVA && (
        <div className="mb-4 rounded-lg bg-blue-50 border border-blue-100 px-4 py-2 text-sm text-blue-700 font-medium">
          You may qualify for a VA loan — often with no down payment required.
        </div>
      )}
      <p className="mb-8 text-xs text-gray-300">This is an estimate. Your lender will provide an exact number.</p>
      <div className="w-full max-w-sm">
        <ContinueBtn onClick={onContinue} label="See Financing Options" />
      </div>
    </div>
  );
}

function AddressScreen({ value, onChange, onContinue }: {
  value: string; onChange: (v: string) => void; onContinue: () => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question
        text="What's the first property you want to track?"
        note="Enter an address — or skip and add one later"
      />
      <div className="w-full max-w-sm">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="123 Main St, Birmingham, AL"
          className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
        />
        <ContinueBtn onClick={onContinue} label="Start Home Shopping" />
      </div>
    </div>
  );
}

function CashLoanScreen({ onSelect }: { onSelect: (v: 'cash' | 'loan') => void }) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text="How are you planning to purchase?" />
      <div className="w-full max-w-xs space-y-3">
        <OptionBtn label="💰  Cash purchase" onClick={() => onSelect('cash')} />
        <OptionBtn label="🏦  Getting a loan" onClick={() => onSelect('loan')} />
      </div>
    </div>
  );
}

function MtnMortgageCTAScreen({ lenderChoice, onContinue }: {
  lenderChoice: string; onContinue: () => void;
}) {
  const [appStarted, setAppStarted] = useState(false);
  const isFastPass = lenderChoice === 'fastpass';

  return (
    <div className="screen-enter flex flex-col items-center text-center">
      {isFastPass && (
        <div className="mb-5 w-full max-w-xs rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-700">
          ⚡ Fast Pass enrollment received — we&apos;ll be in touch!
        </div>
      )}

      <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-navy text-white font-black text-xl shadow-md">
        M
      </div>
      <h2 className="text-2xl font-black text-brand-navy">Start your application</h2>
      <p className="mt-2 mb-7 max-w-xs text-sm leading-relaxed text-gray-400">
        Mountain Mortgage gets you pre-approved fast. Most applications take under 10 minutes.
      </p>

      <div className="w-full max-w-xs space-y-3">
        {/* Start Application — opens portal, then shows confirm button */}
        {!appStarted ? (
          <button
            onClick={() => {
              window.open(MM_URL, '_blank', 'noopener,noreferrer');
              setAppStarted(true);
            }}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-navy py-4 text-base font-bold text-white transition-all hover:bg-brand-navy/80 active:scale-[0.98]"
          >
            Start My Application →
          </button>
        ) : (
          <button
            onClick={onContinue}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-500 py-4 text-base font-bold text-white transition-all hover:bg-green-600 active:scale-[0.98]"
          >
            ✓ Application started — Continue to my dashboard
          </button>
        )}

        <div className="flex items-center gap-2 py-1">
          <div className="h-px flex-1 bg-gray-100" />
          <span className="flex-shrink-0 text-xs text-gray-300">or prefer to talk first?</span>
          <div className="h-px flex-1 bg-gray-100" />
        </div>

        {/* Call Paul — tapping also completes onboarding */}
        <a
          href="tel:+12054019076"
          onClick={onContinue}
          className="flex w-full items-center gap-4 rounded-xl bg-gray-50 px-4 py-4 text-left transition-all hover:bg-gray-100 active:scale-[0.99]"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-blue-100 text-xl">
            📞
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-brand-navy">Call Paul Leara</p>
            <p className="text-sm text-blue-600">(205) 401-9076</p>
            <p className="text-xs text-gray-400">Mountain Mortgage · Loan Officer</p>
          </div>
          <ChevronRight size={16} className="flex-shrink-0 text-gray-300" />
        </a>

        <button
          onClick={onContinue}
          className="mt-1 w-full text-center text-sm text-gray-400 transition-colors hover:text-gray-600"
        >
          I&apos;ll do this later →
        </button>
      </div>
    </div>
  );
}

function WelcomeScreen({ agentName, agentAvatar, onStart }: {
  agentName: string; agentAvatar?: string; onStart: () => void;
}) {
  const steps = [
    { icon: '🏠', label: 'What you\'re looking for' },
    { icon: '💰', label: 'Your buying power' },
    { icon: '📋', label: 'Your personal deal portal' },
  ];
  return (
    <div className="flex flex-col items-center text-center">

      {/* Headline */}
      <h1 className="text-2xl font-black text-brand-navy leading-snug">
        Welcome to your home buying journey.
      </h1>
      <p className="mt-1.5 mb-6 text-sm text-gray-400">Your agent has invited you to get started.</p>

      {/* Agent — hero */}
      <div className="mb-3">
        {agentAvatar ? (
          <Image
            src={agentAvatar}
            alt={agentName}
            width={80}
            height={80}
            unoptimized
            className="h-20 w-20 rounded-2xl object-cover shadow-md ring-4 ring-brand-navy/10"
          />
        ) : (
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-brand-navy text-white text-3xl font-black shadow-md">
            {/^[A-Za-z]/.test(agentName) ? agentName[0] : 'A'}
          </div>
        )}
      </div>
      <h1 className="text-2xl font-black text-brand-navy">{agentName}</h1>
      <p className="mt-0.5 text-sm text-gray-400">Your RealTour Flow Agent</p>

      {/* Divider */}
      <div className="my-5 h-px w-16 bg-gray-200" />

      {/* Personal note */}
      <p className="max-w-xs text-sm text-gray-600 leading-relaxed">
        I&apos;ve set up your home buying portal. A few quick questions and your search is personalized — takes about 3 minutes.
      </p>

      {/* Steps */}
      <div className="mt-5 w-full max-w-xs rounded-2xl bg-gray-50 px-5 py-4 text-left">
        <p className="mb-2.5 text-[10px] font-bold uppercase tracking-widest text-gray-300">We&apos;ll cover</p>
        <div className="space-y-2.5">
          {steps.map(({ icon, label }) => (
            <div key={label} className="flex items-center gap-3 text-sm text-gray-600">
              <span className="text-base">{icon}</span>
              {label}
            </div>
          ))}
        </div>
      </div>

      <button
        onClick={onStart}
        className="mt-6 flex w-full max-w-xs items-center justify-center gap-2 rounded-xl bg-brand-navy py-4 text-base font-bold text-white hover:bg-brand-navy/80 active:scale-[0.98] transition-all"
      >
        Let&apos;s get started <ArrowRight size={18} />
      </button>
    </div>
  );
}

function ContactInfoScreen({ initial, onContinue }: {
  /** #427 — reopened from the review, the form starts on what they already gave. */
  initial?: { name: string; phone: string; email: string };
  onContinue: (name: string, phone: string, email: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const valid = name.trim() && phone.trim() && email.trim();
  const inputCls = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10';

  return (
    <div className="screen-enter flex flex-col items-center">
      <Question
        text="How can your agent reach you?"
        note="Your agent uses this to schedule your buyer strategy call"
      />
      <div className="w-full max-w-sm space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Full name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Alex Chen" className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Phone</label>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(205) 555-0100" className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className={inputCls} />
        </div>
        <ContinueBtn onClick={() => onContinue(name.trim(), phone.trim(), email.trim())} disabled={!valid} />
      </div>
    </div>
  );
}

function DoneScreen({ agentName }: { agentName: string }) {
  const router = useRouter();
  const activeUser = useAuthStore((s) => s.activeUser);
  function goToDashboard() {
    if (activeUser?.id) {
      router.push(`/buyer/${activeUser.id}`);
    } else {
      router.push('/');
    }
  }
  return (
    <div className="screen-enter flex flex-col items-center py-4 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-green-100">
        <CheckCircle2 size={34} className="text-green-500" />
      </div>
      <h2 className="text-3xl font-black text-brand-navy">You&apos;re all set!</h2>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-gray-500">
        {agentName} has been notified. Your dashboard is live — you can start tracking properties right away.
      </p>
      <div className="mt-4 rounded-xl border border-brand-gold/40 bg-brand-gold/10 px-5 py-3 text-sm text-brand-navy">
        <span className="font-semibold">Next:</span> {agentName} will reach out to schedule your buyer strategy call. Additional tasks unlock after that meeting.
      </div>
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

export default function BuyerOnboarding() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const activeUser = useAuthStore((s) => s.activeUser);
  const markOnboardingComplete = useAuthStore((s) => s.markOnboardingComplete);

  // Never seed from the raw `agent` param — it's a UUID. Start generic and
  // resolve the agent's real name below.
  const [agentName, setAgentName] = useState('Your Agent');

  // Lazy initializers read sessionStorage once at mount. This satisfies the
  // React 19 set-state-in-effect rule — the "resume after Fast Pass" branch
  // used to happen in a mount-only useEffect, but the cleaner pattern is to
  // bake the restored state into the initial useState() call.
  const [resumeState] = useState<{ lenderChoice?: LenderChoice | '' } | null>(() => {
    if (typeof window === 'undefined') return null;
    if (searchParams.get('resume') !== 'true') return null;
    try {
      const saved = JSON.parse(sessionStorage.getItem('rtf_onboarding_resume') ?? '{}');
      sessionStorage.removeItem('rtf_onboarding_resume');
      return saved;
    } catch {
      return null;
    }
  });

  /**
   * #427 — `?review=true` reopens the finished questionnaire from the portal's
   * *Your preferences* link. It is an OPT-IN entry point: nothing routes a
   * client here on its own, and nothing in the portal prompts for it (#407).
   * In this mode the wizard boots straight onto the review screen with the
   * saved answers loaded, and "Save changes" posts and returns to the portal —
   * the welcome, pitch, Fast Pass and done screens are never reached.
   */
  const editMode = searchParams.get('review') === 'true';

  const [screen, setScreen] = useState(() =>
    editMode ? REVIEW_SCREEN : resumeState ? 20 : -1,
  );
  const [data, setData] = useState<BuyerData>(() =>
    resumeState?.lenderChoice ? { ...EMPTY, lenderChoice: resumeState.lenderChoice } : EMPTY,
  );

  // Review-screen navigation: an edit made FROM the review returns to it rather
  // than continuing forward through the questionnaire.
  const [reviewReturn, setReviewReturn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editLoaded, setEditLoaded] = useState(!editMode);
  const [editDealId, setEditDealId] = useState<string | null>(null);

  // Fetch invite details from token to get real agentName (+ the deal the
  // intake should land on, threaded into the /me/intake fallback below).
  const [inviteDealId, setInviteDealId] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.get<{ agent_name: string; deal_id: string }>(`/invites/${token}`)
      .then((inv) => {
        setAgentName(inv.agent_name);
        setInviteDealId(inv.deal_id ?? null);
      })
      .catch(() => {});
  }, [token]);

  // Resolve the agent's real NAME (never a raw UUID). Token links use the effect
  // above. Otherwise: an `?agent=<id>` link resolves via the public name lookup;
  // an already-authenticated buyer (account-first flow) resolves from their deal.
  useEffect(() => {
    if (token) return;
    const agentId = searchParams.get('agent');
    if (agentId) {
      // Public, unauthenticated-safe — plain fetch bypasses the Auth0 api client.
      fetch(`/api/agents/${agentId}/public`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { name?: string } | null) => { if (d?.name) setAgentName(d.name); })
        .catch(() => {});
    } else if (activeUser) {
      api.get<{ agent_name: string }[]>('/me/deals')
        .then((rows) => { if (rows[0]?.agent_name) setAgentName(rows[0].agent_name); })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeUser]);

  // #427 edit mode: pull the submitted questionnaire back so the review shows
  // what they actually answered. Loads exactly once — a re-run after the user
  // has started editing would silently revert their changes.
  const editLoadedRef = useRef(false);
  useEffect(() => {
    if (!editMode || !activeUser || editLoadedRef.current) return;
    editLoadedRef.current = true;
    api
      .get<{ deal_id: string | null; intake: { answers?: Record<string, unknown> } | null }>(
        '/me/intake?role=buyer',
      )
      .then((res) => {
        setEditDealId(res.deal_id ?? null);
        const saved = res.intake?.answers;
        if (saved) setData((d) => ({ ...d, ...(saved as Partial<BuyerData>) }));
        setEditLoaded(true);
      })
      .catch(() => {
        setEditLoaded(true);
        setSaveError("We couldn't load your saved answers. Try again in a moment.");
      });
  }, [editMode, activeUser]);

  // On done screen: persist contact info + the full questionnaire (#175) +
  // claim invite (which advances stage + creates task + notifies agent)
  const hasSubmittedRef = useRef(false);
  useEffect(() => {
    // Edit mode never reaches the done screen (the review saves and leaves), but
    // the guard is explicit: re-running the first-submission side effects would
    // re-mark onboarding complete and re-POST the invite claim.
    if (editMode || screen !== TOTAL - 1 || hasSubmittedRef.current) return;
    hasSubmittedRef.current = true;

    const name = data.contactName || activeUser?.name || '';
    const phone = data.contactPhone;
    const email = activeUser?.email || data.contactEmail;
    // The entire questionnaire — budget, areas, credit, lenderChoice, first
    // tracking address, … — persists onto the deal (deals.intake).
    const answers: Record<string, unknown> = { ...data };

    if (activeUser) {
      // Authenticated buyer finishing onboarding: persist any contact edits and
      // mark onboarding complete. The PATCH flips onboarding_complete
      // server-side so next login routes straight to their dashboard.
      api.patch('/me/profile', { name: name || undefined, phone: phone || undefined }).catch(() => {});
      markOnboardingComplete();
      // Account-first flow: the invite may already be claimed (AuthSetup
      // claims before sync), so write the intake to the participant deal
      // directly. Idempotent with the claim's own intake write below.
      api.post('/me/intake', {
        role: 'buyer',
        ...(inviteDealId ? { deal_id: inviteDealId } : {}),
        answers,
      }).catch(() => {});
    } else if (phone || name) {
      api.patch('/me/profile', { name: name || undefined, phone: phone || undefined }).catch(() => {});
    }

    if (token && email) {
      api.post(`/invites/${token}/claim`, { email, name, intake: { role: 'buyer', answers } }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  // Reset local input state when screen changes. React 19 pattern: compare to
  // previous screen during render rather than syncing in useEffect.
  const [textVal, setTextVal] = useState('');
  const [prevScreen, setPrevScreen] = useState(screen);
  if (screen !== prevScreen) {
    setPrevScreen(screen);
    const s = screen >= 1 && screen <= 15 ? SCREENS[screen - 1] : null;
    if (s) setTextVal((data[s.field] as string) ?? '');
  }

  const isCash = data.cashOrLoan === 'cash';

  const progress = editMode
    ? 100
    : screen < 0
      ? 3
      : screen >= TOTAL - 1
        ? 100
        : Math.round(((screen + 1) / TOTAL) * 100);

  function set<K extends keyof BuyerData>(key: K, val: BuyerData[K]) {
    setData((d) => ({ ...d, [key]: val }));
  }

  // Read the latest cash/lender state directly from `data`. React 19's
  // compiler memoizes function bodies, so we no longer need refs to capture
  // "the latest state" across renders — these closures already see the
  // current values, and setScreen's updater receives the latest screen.
  function advance(currentIsCash?: boolean) {
    // #427 — an answer being CHANGED from the review goes straight back to the
    // review; only a first pass walks on through the questionnaire.
    if (reviewReturn) {
      setReviewReturn(false);
      setScreen(REVIEW_SCREEN);
      return;
    }
    const useCash = typeof currentIsCash === 'boolean' ? currentIsCash : isCash;
    const lc = data.lenderChoice;
    setScreen((s) => {
      let next = s + 1;
      while (next < TOTAL - 1 && shouldSkipScreen(next, useCash, lc)) next++;
      return Math.min(next, TOTAL - 1);
    });
  }

  function back() {
    // Backing out of an edit is a cancel: it returns to the review, unchanged
    // answer and all, rather than dropping them into the middle of the wizard.
    if (reviewReturn) {
      setReviewReturn(false);
      setScreen(REVIEW_SCREEN);
      return;
    }
    const useCash = isCash;
    const lc = data.lenderChoice;
    setScreen((s) => {
      let prev = s - 1;
      while (prev > 0 && shouldSkipScreen(prev, useCash, lc)) prev--;
      return Math.max(prev, 0);
    });
  }

  /** Review row → the screen that asked for that answer. */
  function editAnswer(target: number | string) {
    const next = typeof target === 'number' ? target : Number(target);
    if (!Number.isFinite(next)) return;
    setReviewReturn(true);
    setScreen(next);
  }

  const portalHref = activeUser?.id ? `/buyer/${activeUser.id}` : '/';

  /** Edit mode's submit: overwrite the saved intake, then back to the portal. */
  async function saveEdits() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.post('/me/intake', {
        role: 'buyer',
        ...(editDealId ? { deal_id: editDealId } : {}),
        answers: { ...data },
      });
      router.push(portalHref);
    } catch {
      setSaveError("We couldn't save your changes. Please try again.");
      setSaving(false);
    }
  }

  function handleSelect(field: keyof BuyerData, val: string) {
    set(field, val as BuyerData[keyof BuyerData]);
    advance();
  }

  // In edit mode the review IS the top of the stack — there is nothing behind it
  // but the portal, which the review's own Cancel handles.
  const showBack = !editMode && screen >= 1 && screen < TOTAL - 1;

  function renderScreen() {
    // Screen 22: review — "here's what you told us", every row editable (#427).
    if (screen === REVIEW_SCREEN) {
      if (!editLoaded) {
        return (
          <div className="screen-enter flex flex-col items-center py-10 text-center">
            <p className="text-sm text-gray-400">
              {activeUser
                ? 'Loading your answers…'
                : 'Sign in to review your preferences.'}
            </p>
          </div>
        );
      }
      return (
        <IntakeReviewScreen
          key={REVIEW_SCREEN}
          rows={buildBuyerReview(data, isCash)}
          onEdit={editAnswer}
          onSubmit={editMode ? saveEdits : () => advance()}
          submitLabel={editMode ? 'Save changes' : 'Looks good — send to my agent'}
          title={editMode ? 'Your preferences' : "Here's what you told us"}
          blurb={
            editMode
              ? 'Tap anything to change it, then save.'
              : 'Tap anything to change it before we send this to your agent.'
          }
          saving={saving}
          error={saveError}
          onCancel={editMode ? () => router.push(portalHref) : undefined}
        />
      );
    }

    // Welcome
    if (screen < 0) {
      return <WelcomeScreen agentName={agentName} onStart={advance} />;
    }

    // Screen 0: cash or loan
    if (screen === 0) {
      return (
        <CashLoanScreen
          key={0}
          onSelect={(v) => {
            set('cashOrLoan', v);
            advance(v === 'cash');
          }}
        />
      );
    }

    // Screens 1–15: questions (SCREENS[screen-1])
    if (screen >= 1 && screen <= 15) {
      const def = SCREENS[screen - 1];
      const key = screen;

      if (def.type === 'yes_no') {
        return <YesNoScreen key={key} question={def.question} note={def.note} onSelect={(v) => handleSelect(def.field, v)} />;
      }
      if (def.type === 'options') {
        return <OptionsScreen key={key} question={def.question} note={def.note} options={def.options!} onSelect={(v) => handleSelect(def.field, v)} />;
      }
      if (def.type === 'text' || def.type === 'textarea') {
        return (
          <TextScreen
            key={key}
            question={def.question}
            note={def.note}
            placeholder={def.placeholder}
            multiline={def.type === 'textarea'}
            value={textVal}
            onChange={setTextVal}
            onContinue={() => { set(def.field, textVal as BuyerData[keyof BuyerData]); advance(); }}
          />
        );
      }
      if (def.type === 'number') {
        return (
          <NumberScreen
            key={key}
            question={def.question}
            note={def.note}
            placeholder={def.placeholder}
            value={textVal}
            onChange={setTextVal}
            onContinue={() => { set(def.field, textVal as BuyerData[keyof BuyerData]); advance(); }}
          />
        );
      }
    }

    // Screen 16: budget sliders
    if (screen === 16) {
      return (
        <BudgetScreen
          key={16}
          minBudget={data.minBudget}
          maxBudget={data.maxBudget}
          onChange={(f, v) => set(f, v)}
          onContinue={advance}
        />
      );
    }

    // Screen 17: buying power (loan only)
    if (screen === 17) {
      return (
        <BuyingPowerScreen
          key={17}
          income={data.monthlyIncome}
          credit={data.creditScore}
          military={data.military}
          onContinue={advance}
        />
      );
    }

    // Screen 18: pitch page (loan only)
    if (screen === 18) {
      return (
        <PitchPage
          key={18}
          onSelect={(choice) => { set('lenderChoice', choice); advance(); }}
        />
      );
    }

    // Screen 19: address — Fast Pass buyers detour to survey before returning to MTN CTA
    if (screen === 19) {
      return (
        <AddressScreen
          key={19}
          value={data.trackingAddress}
          onChange={(v) => set('trackingAddress', v)}
          onContinue={() => {
            // #427 — a buyer editing this from the review is not re-running
            // enrollment; only a first pass detours into the Fast Pass survey.
            if (!reviewReturn && data.lenderChoice === 'fastpass') {
              sessionStorage.setItem('rtf_onboarding_resume', JSON.stringify({ lenderChoice: 'fastpass' }));
              router.push('/fast-pass?fromOnboarding=true');
            } else {
              advance();
            }
          }}
        />
      );
    }

    // Screen 20: Mountain Mortgage CTA (mountain + fastpass only)
    if (screen === 20) {
      return (
        <MtnMortgageCTAScreen
          key={20}
          lenderChoice={data.lenderChoice}
          onContinue={() => advance()}
        />
      );
    }

    // Screen 21: contact info
    if (screen === 21) {
      return (
        <ContactInfoScreen
          key={21}
          initial={{
            name: data.contactName,
            phone: data.contactPhone,
            email: data.contactEmail,
          }}
          onContinue={(name, phone, email) => {
            set('contactName', name);
            set('contactPhone', phone);
            set('contactEmail', email);
            advance();
          }}
        />
      );
    }

    // Screen 23: done
    return <DoneScreen key={23} agentName={agentName} />;
  }

  return (
    <OnboardingLayout
      progress={progress}
      onBack={showBack ? back : undefined}
      label="Buyer"
    >
      {renderScreen()}
    </OnboardingLayout>
  );
}
