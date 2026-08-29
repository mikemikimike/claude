"use client";

import { useState, useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from "next/navigation";
import { CheckCircle2, ChevronRight, Circle } from 'lucide-react';
import OnboardingLayout from './OnboardingLayout';
import PitchPage, { LenderChoice } from './PitchPage';
import IntakeReviewScreen from './IntakeReviewScreen';
import { buildSellerReview } from '@/lib/intake-review';
import { useAuthStore } from "@/lib/store/authStore";
import { api } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────────────────────

type SellerData = {
  address: string;
  priceExpectation: string;
  whatMattersMost: string;
  desiredListDate: string;
  hardDeadline: string;
  timelineFlexibility: string;
  reasonsForSelling: string[];
  stressfulOrUrgent: string;
  stressNotes: string;
  hasMortgage: string;
  mortgageBalance: string;
  mortgageRate: string;
  mortgageAssumable: string;
  hasHeloc: string;
  propertyTax: string;
  propertyType: string;
  occupancy: string;
  yearBuilt: string;
  conditionRating: string;
  knownIssues: string[];
  majorUpgrades: string;
  upgradesList: string;
  hasHoa: string;
  hoaDues: string;
  preListingPrep: string[];
  preListingSpend: string;
  biggerFear: string;
  openToIncentives: string;
  alsoLookingToBuy: string;
  buyTiming: string;
  needSaleProceeds: string;
  lenderChoice: LenderChoice | '';
  contactName: string;
  contactPhone: string;
  contactEmail: string;
};

const EMPTY: SellerData = {
  address: '', priceExpectation: '', whatMattersMost: '', desiredListDate: '',
  hardDeadline: '', timelineFlexibility: '', reasonsForSelling: [],
  stressfulOrUrgent: '', stressNotes: '', hasMortgage: '', mortgageBalance: '',
  mortgageRate: '', mortgageAssumable: '', hasHeloc: '', propertyTax: '',
  propertyType: '', occupancy: '', yearBuilt: '', conditionRating: '',
  knownIssues: [], majorUpgrades: '', upgradesList: '', hasHoa: '', hoaDues: '',
  preListingPrep: [], preListingSpend: '', biggerFear: '', openToIncentives: '',
  alsoLookingToBuy: '', buyTiming: '', needSaleProceeds: '', lenderChoice: '',
  contactName: '', contactPhone: '', contactEmail: '',
};

// ─── Screen IDs + visibility logic ──────────────────────────────────────────

export type ScreenId =
  | 'address' | 'priceExpectation' | 'whatMattersMost' | 'desiredListDate'
  | 'hardDeadline' | 'timelineFlexibility' | 'reasonsForSelling' | 'stressfulOrUrgent'
  | 'hasMortgage' | 'mortgageBalance' | 'mortgageRate' | 'mortgageAssumable' | 'hasHeloc'
  | 'propertyTax' | 'propertyType' | 'occupancy' | 'yearBuilt' | 'conditionRating'
  | 'knownIssues' | 'majorUpgrades' | 'hasHoa' | 'preListingPrep' | 'preListingSpend'
  | 'biggerFear' | 'openToIncentives' | 'alsoLookingToBuy' | 'buyTiming'
  | 'needSaleProceeds' | 'pitchPage' | 'smoothExitPitch' | 'contactInfo'
  | 'review' | 'confirmation';

/**
 * The screens THIS seller is asked, in order — the wizard's own skip logic.
 *
 * Exported (#427) for two consumers: `buildSellerReview` takes this list rather
 * than restating the mortgage / also-buying branches, and
 * `tests/components/seller-onboarding-review.test.tsx` pins that the review
 * sits immediately before the confirmation on every branch.
 */
export function getVisibleScreens(data: SellerData): ScreenId[] {
  const s: ScreenId[] = [
    'address', 'priceExpectation', 'whatMattersMost', 'desiredListDate',
    'hardDeadline', 'timelineFlexibility', 'reasonsForSelling', 'stressfulOrUrgent',
    'hasMortgage',
  ];
  if (data.hasMortgage === 'yes') {
    s.push('mortgageBalance', 'mortgageRate', 'mortgageAssumable', 'hasHeloc');
  }
  s.push(
    'propertyTax', 'propertyType', 'occupancy', 'yearBuilt', 'conditionRating',
    'knownIssues', 'majorUpgrades', 'hasHoa', 'preListingPrep', 'preListingSpend',
    'biggerFear', 'openToIncentives', 'alsoLookingToBuy',
  );
  if (data.alsoLookingToBuy === 'yes') {
    s.push('buyTiming', 'needSaleProceeds', 'pitchPage');
  }
  // #427 — 'review' is the last thing before the questionnaire is sent: every
  // question this seller was actually asked, each one editable. It sits inside
  // getVisibleScreens (rather than beside it) so buildSellerReview can take
  // this list as THE answer to "which questions did they see", instead of
  // restating the mortgage / also-buying branches above and drifting from them.
  s.push('smoothExitPitch', 'contactInfo', 'review', 'confirmation');
  return s;
}

// ─── Shared UI atoms ─────────────────────────────────────────────────────────

function Question({ text, note }: { text: string; note?: string }) {
  return (
    <div className="mb-8 text-center">
      <h2 className="text-2xl font-bold leading-snug text-brand-navy sm:text-3xl">{text}</h2>
      {note && <p className="mt-2 text-sm text-gray-400">{note}</p>}
    </div>
  );
}

function Btn({ label, selected, onClick }: { label: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'w-full rounded-xl py-4 text-center text-base font-bold transition-all active:scale-[0.98]',
        selected ? 'bg-brand-navy text-white' : 'bg-gray-100 text-brand-navy hover:bg-gray-200',
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
        disabled ? 'cursor-not-allowed bg-gray-100 text-gray-300' : 'bg-brand-navy text-white hover:bg-brand-navy/80 active:scale-[0.98]',
      ].join(' ')}
    >
      {label} <ChevronRight size={18} />
    </button>
  );
}

function ToggleChip({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        'rounded-xl border-2 px-4 py-2.5 text-sm font-semibold transition-all',
        selected ? 'border-brand-navy bg-brand-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-brand-navy/30',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function TextInput({ value, onChange, placeholder, type = 'text' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
    />
  );
}

// ─── Screen components ───────────────────────────────────────────────────────

function YesNoScreen({ question, note, value, onSelect }: {
  question: string; note?: string; value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-xs space-y-3">
        <Btn label="Yes" selected={value === 'yes'} onClick={() => onSelect('yes')} />
        <Btn label="No" selected={value === 'no'} onClick={() => onSelect('no')} />
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
        {options.map((opt) => <Btn key={opt} label={opt} onClick={() => onSelect(opt)} />)}
      </div>
    </div>
  );
}

function MultiSelectScreen({ question, note, options, selected, onChange, onContinue, optional }: {
  question: string; note?: string; options: string[]; selected: string[];
  onChange: (v: string[]) => void; onContinue: () => void; optional?: boolean;
}) {
  function toggle(opt: string) {
    if (opt === 'None') { onChange(['None']); return; }
    const without = selected.filter((s) => s !== 'None');
    onChange(without.includes(opt) ? without.filter((s) => s !== opt) : [...without, opt]);
  }
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-sm flex flex-wrap gap-2 justify-center">
        {options.map((opt) => (
          <ToggleChip key={opt} label={opt} selected={selected.includes(opt)} onClick={() => toggle(opt)} />
        ))}
      </div>
      <div className="w-full max-w-sm">
        <ContinueBtn onClick={onContinue} disabled={!optional && selected.length === 0} />
      </div>
    </div>
  );
}

function TextScreen({ question, note, value, onChange, onContinue, placeholder, optional }: {
  question: string; note?: string; value: string; onChange: (v: string) => void;
  onContinue: () => void; placeholder?: string; optional?: boolean;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-sm">
        <TextInput value={value} onChange={onChange} placeholder={placeholder} />
        <ContinueBtn onClick={onContinue} disabled={!optional && !value.trim()} />
      </div>
    </div>
  );
}

function NumberScreen({ question, note, value, onChange, onContinue, placeholder, optional }: {
  question: string; note?: string; value: string; onChange: (v: string) => void;
  onContinue: () => void; placeholder?: string; optional?: boolean;
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
        <ContinueBtn onClick={onContinue} disabled={!optional && !value} />
      </div>
    </div>
  );
}

// Yes/No with optional follow-up text on same screen
function YesNoWithNotesScreen({ question, note, yesLabel = 'Yes', noLabel = 'No', notesPlaceholder, value, notesValue, onAnswer, onNotesChange, onContinue }: {
  question: string; note?: string; yesLabel?: string; noLabel?: string; notesPlaceholder?: string;
  value: string; notesValue: string; onAnswer: (v: string) => void; onNotesChange: (v: string) => void; onContinue: () => void;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-xs space-y-3">
        <Btn label={yesLabel} selected={value === 'yes'} onClick={() => onAnswer('yes')} />
        <Btn label={noLabel} selected={value === 'no'} onClick={() => onAnswer('no')} />
      </div>
      {value === 'yes' && (
        <div className="mt-4 w-full max-w-xs">
          <textarea
            value={notesValue}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder={notesPlaceholder ?? 'Optional — tell us more…'}
            rows={3}
            className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
          />
          <ContinueBtn onClick={onContinue} />
        </div>
      )}
    </div>
  );
}

// Yes/No with optional text input for extra field
function YesNoWithFieldScreen({ question, note, fieldLabel, fieldPlaceholder, value, fieldValue, onAnswer, onFieldChange, onContinue, fieldType = 'text' }: {
  question: string; note?: string; fieldLabel?: string; fieldPlaceholder?: string;
  value: string; fieldValue: string; onAnswer: (v: string) => void;
  onFieldChange: (v: string) => void; onContinue: () => void; fieldType?: string;
}) {
  return (
    <div className="screen-enter flex flex-col items-center">
      <Question text={question} note={note} />
      <div className="w-full max-w-xs space-y-3">
        <Btn label="Yes" selected={value === 'yes'} onClick={() => onAnswer('yes')} />
        <Btn label="No" selected={value === 'no'} onClick={() => onAnswer('no')} />
      </div>
      {value === 'yes' && (
        <div className="mt-4 w-full max-w-xs">
          {fieldLabel && <p className="mb-1.5 text-xs font-medium text-gray-500">{fieldLabel}</p>}
          <TextInput value={fieldValue} onChange={onFieldChange} placeholder={fieldPlaceholder} type={fieldType} />
          <ContinueBtn onClick={onContinue} />
        </div>
      )}
    </div>
  );
}

// Seller confirmation
function ConfirmationScreen({ data, agentName }: { data: SellerData; agentName: string }) {
  const router = useRouter();
  const activeUser = useAuthStore((s) => s.activeUser);
  const stages = [
    { label: 'Onboarding', done: true },
    { label: 'Strategy Consultation', done: false },
    { label: 'Prepare Property', done: false },
    { label: 'List & Market', done: false },
    { label: 'Under Contract → Close', done: false },
  ];
  return (
    <div className="screen-enter flex flex-col items-center text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-purple-100">
        <CheckCircle2 size={34} className="text-purple-500" />
      </div>
      <h2 className="text-2xl font-black text-brand-navy">You&apos;re on your way!</h2>
      <p className="mt-2 text-sm text-gray-500">Here&apos;s what you shared. Your agent has been notified.</p>

      {/* Summary */}
      <div className="mt-5 w-full max-w-sm rounded-xl bg-gray-50 border border-gray-200 px-5 py-4 text-left space-y-2">
        {data.address && (
          <div><span className="text-xs font-bold uppercase text-gray-400">Property</span><p className="text-sm font-medium text-brand-navy mt-0.5">{data.address}</p></div>
        )}
        {data.desiredListDate && (
          <div><span className="text-xs font-bold uppercase text-gray-400">Target List Date</span><p className="text-sm font-medium text-brand-navy mt-0.5">{data.desiredListDate}</p></div>
        )}
        {data.whatMattersMost && (
          <div><span className="text-xs font-bold uppercase text-gray-400">Priority</span><p className="text-sm font-medium text-brand-navy mt-0.5">{data.whatMattersMost}</p></div>
        )}
      </div>

      {/* Stage map */}
      <div className="mt-5 w-full max-w-sm space-y-2">
        {stages.map((st, i) => (
          <div key={i} className={`flex items-center gap-3 rounded-xl px-4 py-2.5 text-sm font-medium ${st.done ? 'bg-purple-50 text-purple-700' : 'bg-gray-50 text-gray-400'}`}>
            {st.done ? <CheckCircle2 size={16} className="text-purple-500 flex-shrink-0" /> : <Circle size={16} className="flex-shrink-0" />}
            {st.label}
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-gray-400">Agent: {agentName}</p>
      <button
        onClick={() => {
          if (activeUser?.id) router.push(`/seller/${activeUser.id}`);
          else router.push('/');
        }}
        className="mt-6 flex items-center gap-2 rounded-xl bg-purple-600 px-8 py-4 text-base font-bold text-white hover:bg-purple-700 transition-all active:scale-[0.98]"
      >
        Schedule Consultation <ChevronRight size={18} />
      </button>
    </div>
  );
}

/**
 * The [localText, localText2, localAnswer] a screen should open with (#427).
 *
 * Only screens with a free-text / yes-no local input appear here; everything
 * else opens blank, exactly as before. Kept beside the renderer it mirrors — if
 * a screen starts reading a different answer, both halves are on this page.
 */
function seedLocalInputs(id: ScreenId | undefined, d: SellerData): [string, string, string] {
  switch (id) {
    case 'address':          return [d.address, '', ''];
    case 'stressfulOrUrgent': return [d.stressNotes, '', d.stressfulOrUrgent];
    case 'hasMortgage':      return ['', '', d.hasMortgage];
    case 'mortgageBalance':  return [d.mortgageBalance, '', ''];
    case 'mortgageRate':     return [d.mortgageRate, '', ''];
    case 'hasHeloc':         return ['', '', d.hasHeloc];
    case 'propertyTax':      return [d.propertyTax, '', ''];
    case 'yearBuilt':        return [d.yearBuilt, '', ''];
    case 'majorUpgrades':    return [d.upgradesList, '', d.majorUpgrades];
    case 'hasHoa':           return [d.hoaDues, '', d.hasHoa];
    case 'alsoLookingToBuy': return ['', '', d.alsoLookingToBuy];
    case 'needSaleProceeds': return ['', '', d.needSaleProceeds];
    case 'contactInfo':      return [d.contactName, d.contactPhone, d.contactEmail];
    default:                 return ['', '', ''];
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SellerOnboarding() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const token = searchParams.get('token');

  const activeUser = useAuthStore((s) => s.activeUser);
  const markOnboardingComplete = useAuthStore((s) => s.markOnboardingComplete);
  // Never seed from the raw `agent` param — it's a UUID. Resolve the real name below.
  const [agentName, setAgentName] = useState('Your Agent');
  const [dealId, setDealId] = useState<string | null>(null);

  const [data, setData] = useState<SellerData>(EMPTY);
  const [screenIndex, setScreenIndex] = useState(0);

  /**
   * #427 — `?review=true` reopens the finished questionnaire from the portal's
   * *Your preferences* link. Opt-in only: nothing routes a seller here on its
   * own and the portal never prompts for it (#407). The wizard boots onto the
   * review with the saved answers loaded, and "Save changes" posts and returns
   * to the portal — the pitch, Smooth Exit and confirmation screens are never
   * reached.
   */
  const editMode = searchParams.get('review') === 'true';
  // An answer changed FROM the review returns to the review, not onwards.
  const [reviewReturn, setReviewReturn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editLoaded, setEditLoaded] = useState(!editMode);

  // Fetch invite details from token to get real agentName + the seller's deal
  // (threaded into the Smooth Exit pitch links below).
  useEffect(() => {
    if (!token) return;
    api.get<{ agent_name: string; deal_id: string }>(`/invites/${token}`)
      .then((inv) => { setAgentName(inv.agent_name); setDealId(inv.deal_id ?? null); })
      .catch(() => {});
  }, [token]);

  // Resolve the agent's real NAME (never a raw UUID) for non-token entry points:
  // an `?agent=<id>` link via the public lookup, or the seller's own deal when
  // already authenticated (account-first flow).
  useEffect(() => {
    if (token) return;
    const agentId = searchParams.get('agent');
    if (agentId) {
      fetch(`/api/agents/${agentId}/public`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { name?: string } | null) => { if (d?.name) setAgentName(d.name); })
        .catch(() => {});
    }
    if (activeUser) {
      // Account-first flow: with no invite token the deal id must come from
      // the seller's own participant deals. Thread it into the Smooth Exit
      // links below so the survey has a deal to actually enroll (#183).
      api.get<{ id: string; type: string; agent_name: string }[]>('/me/deals')
        .then((rows) => {
          if (!agentId && rows[0]?.agent_name) setAgentName(rows[0].agent_name);
          const sellDeal = rows.find((r) => r.type === 'sell');
          if (sellDeal) setDealId(sellDeal.id);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, activeUser]);

  // #427 edit mode: pull the submitted questionnaire back so the review shows
  // what they actually answered. Loads exactly once — a re-run after the seller
  // has started editing would silently revert their changes.
  const editLoadedRef = useRef(false);
  useEffect(() => {
    if (!editMode || !activeUser || editLoadedRef.current) return;
    editLoadedRef.current = true;
    api
      .get<{ deal_id: string | null; intake: { answers?: Record<string, unknown> } | null }>(
        '/me/intake?role=seller',
      )
      .then((res) => {
        if (res.deal_id) setDealId(res.deal_id);
        const saved = res.intake?.answers;
        const merged = saved ? { ...EMPTY, ...(saved as Partial<SellerData>) } : EMPTY;
        setData(merged);
        // The index is only meaningful against the screen list the loaded
        // answers produce — the mortgage / also-buying branches change its
        // length — so it is computed from `merged`, not from EMPTY.
        setScreenIndex(Math.max(getVisibleScreens(merged).indexOf('review'), 0));
        setEditLoaded(true);
      })
      .catch(() => {
        setEditLoaded(true);
        setSaveError("We couldn't load your saved answers. Try again in a moment.");
      });
  }, [editMode, activeUser]);

  // On confirmation screen: persist contact info + claim invite
  const hasSubmittedRef = useRef(false);

  // Local transient state (resets on screen change)
  const [localText, setLocalText] = useState('');
  const [localText2, setLocalText2] = useState('');
  const [localAnswer, setLocalAnswer] = useState('');

  const visibleScreens = getVisibleScreens(data);
  const currentId = visibleScreens[screenIndex];
  const total = visibleScreens.length;
  const progress = editMode ? 100 : Math.min((screenIndex / (total - 1)) * 100, 100);

  useEffect(() => {
    // Edit mode never reaches the confirmation screen (the review saves and
    // leaves), but the guard is explicit: re-running the first-submission side
    // effects would re-mark onboarding complete and re-POST the invite claim.
    if (editMode || currentId !== 'confirmation' || hasSubmittedRef.current) return;
    hasSubmittedRef.current = true;

    const name = data.contactName || activeUser?.name || '';
    const phone = data.contactPhone;
    const email = activeUser?.email || data.contactEmail;
    // #175 — the entire questionnaire (property address, list date,
    // priorities, mortgage details, lenderChoice, …) persists onto the deal
    // (deals.intake); the server also writes the property address onto the
    // deal itself when the agent left it empty.
    const answers: Record<string, unknown> = { ...data };

    if (activeUser) {
      // Authenticated seller finishing onboarding: persist contact edits and
      // mark onboarding complete (the PATCH flips onboarding_complete server-side).
      api.patch('/me/profile', { name: name || undefined, phone: phone || undefined }).catch(() => {});
      markOnboardingComplete();
      // Account-first flow: the invite may already be claimed (AuthSetup
      // claims before sync), so write the intake to the participant deal
      // directly. Idempotent with the claim's own intake write below.
      api.post('/me/intake', {
        role: 'seller',
        ...(dealId ? { deal_id: dealId } : {}),
        answers,
      }).catch(() => {});
    } else if (phone || name) {
      api.patch('/me/profile', { name: name || undefined, phone: phone || undefined }).catch(() => {});
    }
    if (token && email) {
      api.post(`/invites/${token}/claim`, { email, name, intake: { role: 'seller', answers } }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Reset local input state when screen changes. React 19 pattern: compare
  // to previous value during render rather than syncing in useEffect.
  //
  // #427 — "reset" now means "seed from the answer already on file", not
  // "blank". A seller reopening a screen from the review has to see what they
  // said in order to change it, and the contact screen in particular disables
  // its Continue button until all three fields are non-empty, so a blank reset
  // would strand them on a screen they only came back to correct.
  const [prevScreenIndex, setPrevScreenIndex] = useState(screenIndex);
  if (screenIndex !== prevScreenIndex) {
    setPrevScreenIndex(screenIndex);
    const [t1, t2, t3] = seedLocalInputs(visibleScreens[screenIndex], data);
    setLocalText(t1);
    setLocalText2(t2);
    setLocalAnswer(t3);
  }

  function set<K extends keyof SellerData>(key: K, val: SellerData[K]) {
    setData((d) => ({ ...d, [key]: val }));
  }

  /**
   * #427 — after an edit made FROM the review, "next" means "back to the
   * review". `visible` is passed in because an answer that changes the branch
   * structure (hasMortgage, alsoLookingToBuy) also changes where the review
   * sits in the list.
   */
  function goNext(visible: ScreenId[]) {
    if (reviewReturn) {
      setReviewReturn(false);
      setScreenIndex(Math.max(visible.indexOf('review'), 0));
      return;
    }
    setScreenIndex((i) => Math.min(i + 1, visible.length - 1));
  }

  function advance() { goNext(visibleScreens); }

  function back() {
    // Backing out of an edit is a cancel: it returns to the review rather than
    // dropping the seller into the middle of the questionnaire.
    if (reviewReturn) {
      setReviewReturn(false);
      setScreenIndex(Math.max(visibleScreens.indexOf('review'), 0));
      return;
    }
    setScreenIndex((i) => Math.max(i - 1, 0));
  }

  function autoAdvance(key: keyof SellerData, val: string) {
    setData((d) => ({ ...d, [key]: val }));
    // recalculate visible screens with the new data to determine next index
    goNext(getVisibleScreens({ ...data, [key]: val }));
  }

  /** Review row -> the screen that asked for that answer. */
  function editAnswer(target: number | string) {
    const idx = visibleScreens.indexOf(String(target) as ScreenId);
    if (idx < 0) return;
    setReviewReturn(true);
    setScreenIndex(idx);
  }

  const portalHref = activeUser?.id ? `/seller/${activeUser.id}` : '/';

  /** Edit mode's submit: overwrite the saved intake, then back to the portal. */
  async function saveEdits() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.post('/me/intake', {
        role: 'seller',
        ...(dealId ? { deal_id: dealId } : {}),
        answers: { ...data },
      });
      router.push(portalHref);
    } catch {
      setSaveError("We couldn't save your changes. Please try again.");
      setSaving(false);
    }
  }

  // In edit mode the review IS the top of the stack - behind it is only the
  // portal, which the review's own Cancel handles.
  const showBack = !editMode && screenIndex > 0 && currentId !== 'confirmation';

  // ── Screen renderers ─────────────────────────────────────────────────────

  function renderScreen(id: ScreenId) {
    const key = screenIndex;

    switch (id) {
      case 'address':
        return <TextScreen key={key} question="What is the address of the property you're selling?" value={localText} onChange={setLocalText} onContinue={() => { set('address', localText); advance(); }} placeholder="123 Oak Lane, Birmingham, AL 35203" />;

      case 'priceExpectation':
        return <OptionsScreen key={key} question="Do you have a price in mind?" options={['I have a number in mind', 'Open to strategy']} onSelect={(v) => autoAdvance('priceExpectation', v)} />;

      case 'whatMattersMost':
        return <OptionsScreen key={key} question="What matters most to you?" note="This helps your agent prioritize" options={['Certainty of closing', 'Speed of sale', 'Highest possible price']} onSelect={(v) => autoAdvance('whatMattersMost', v)} />;

      case 'desiredListDate':
        return <OptionsScreen key={key} question="When would you like to be listed?" options={['ASAP', 'Within 30 days', 'Within 60 days', '90+ days']} onSelect={(v) => autoAdvance('desiredListDate', v)} />;

      case 'hardDeadline':
        return <OptionsScreen key={key} question="Do you have a hard deadline to move?" options={['Job relocation', 'Closing on another home', 'Divorce', 'Estate / Inherited', 'No hard deadline']} onSelect={(v) => autoAdvance('hardDeadline', v)} />;

      case 'timelineFlexibility':
        return <OptionsScreen key={key} question="How flexible is your timeline?" options={['Firm — I have a hard date', 'Somewhat flexible', 'Very flexible']} onSelect={(v) => autoAdvance('timelineFlexibility', v)} />;

      case 'reasonsForSelling':
        return (
          <MultiSelectScreen
            key={key}
            question="What's your reason for selling?"
            note="Select all that apply"
            options={['Upsizing', 'Downsizing', 'Relocating', 'Divorce or Separation', 'Estate or Inherited', 'Financial need', 'Investment property', 'Other']}
            selected={data.reasonsForSelling}
            onChange={(v) => set('reasonsForSelling', v)}
            onContinue={advance}
          />
        );

      case 'stressfulOrUrgent':
        return (
          <YesNoWithNotesScreen
            key={key}
            question="Is this sale stressful or urgent for you?"
            note="Your agent wants to know so they can support you better"
            yesLabel="Yes — it's stressful"
            noLabel="No — we're good"
            notesPlaceholder="Optional — share what's going on…"
            value={localAnswer}
            notesValue={localText}
            onAnswer={(v) => {
              setLocalAnswer(v);
              if (v === 'no') { set('stressfulOrUrgent', 'no'); advance(); }
            }}
            onNotesChange={setLocalText}
            onContinue={() => { set('stressfulOrUrgent', 'yes'); set('stressNotes', localText); advance(); }}
          />
        );

      case 'hasMortgage':
        return <YesNoScreen key={key} question="Do you currently have a mortgage on this property?" value={localAnswer} onSelect={(v) => { setLocalAnswer(v); autoAdvance('hasMortgage', v); }} />;

      case 'mortgageBalance':
        return <NumberScreen key={key} question="What is your approximate mortgage balance?" placeholder="185,000" value={localText} onChange={setLocalText} onContinue={() => { set('mortgageBalance', localText); advance(); }} optional />;

      case 'mortgageRate':
        return (
          <div className="screen-enter flex flex-col items-center">
            <Question text="What's your current interest rate?" note="Optional — helps your agent understand your equity position" />
            <div className="w-full max-w-sm">
              <div className="relative">
                <input type="number" value={localText} onChange={(e) => setLocalText(e.target.value)} step="0.1" placeholder="6.5" className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 pr-8 text-sm outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10" />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400">%</span>
              </div>
              <ContinueBtn onClick={() => { set('mortgageRate', localText); advance(); }} />
            </div>
          </div>
        );

      case 'mortgageAssumable':
        return <OptionsScreen key={key} question="Is your mortgage assumable?" note="An assumable mortgage can be transferred to the buyer" options={['Yes', 'No', 'Not sure']} onSelect={(v) => autoAdvance('mortgageAssumable', v)} />;

      case 'hasHeloc':
        return <YesNoScreen key={key} question="Do you have a HELOC or second mortgage?" value={localAnswer} onSelect={(v) => { setLocalAnswer(v); autoAdvance('hasHeloc', v); }} />;

      case 'propertyTax':
        return <NumberScreen key={key} question="What are your annual property taxes?" placeholder="3,200" value={localText} onChange={setLocalText} onContinue={() => { set('propertyTax', localText); advance(); }} optional />;

      case 'propertyType':
        return <OptionsScreen key={key} question="What type of property is this?" options={['Single Family', 'Condominium', 'Townhome', 'Multi-Family']} onSelect={(v) => autoAdvance('propertyType', v)} />;

      case 'occupancy':
        return <OptionsScreen key={key} question="How is the property currently occupied?" options={['Owner-occupied', 'Tenant-occupied', 'Vacant']} onSelect={(v) => autoAdvance('occupancy', v)} />;

      case 'yearBuilt':
        return (
          <div className="screen-enter flex flex-col items-center">
            <Question text="What year was the home built?" note="Optional" />
            <div className="w-full max-w-sm">
              <TextInput value={localText} onChange={setLocalText} placeholder="e.g. 1998" type="number" />
              <ContinueBtn onClick={() => { set('yearBuilt', localText); advance(); }} />
            </div>
          </div>
        );

      case 'conditionRating':
        return <OptionsScreen key={key} question="How would you rate the property's condition?" options={['Turn-key / Move-in ready', 'Good but dated', 'Needs cosmetic work', 'Needs major repairs']} onSelect={(v) => autoAdvance('conditionRating', v)} />;

      case 'knownIssues':
        return (
          <MultiSelectScreen
            key={key}
            question="Are there any known issues?"
            note="Select all that apply — honesty helps your agent prepare"
            options={['Roof', 'HVAC', 'Foundation', 'Plumbing', 'Electrical', 'None']}
            selected={data.knownIssues}
            onChange={(v) => set('knownIssues', v)}
            onContinue={advance}
            optional
          />
        );

      case 'majorUpgrades':
        return (
          <YesNoWithFieldScreen
            key={key}
            question="Any major upgrades in the last 5 years?"
            fieldLabel="What was upgraded? (optional)"
            fieldPlaceholder="e.g. New roof 2022, Kitchen remodel 2023"
            value={localAnswer}
            fieldValue={localText}
            onAnswer={(v) => {
              setLocalAnswer(v);
              if (v === 'no') { set('majorUpgrades', 'no'); advance(); }
              else set('majorUpgrades', 'yes');
            }}
            onFieldChange={setLocalText}
            onContinue={() => { set('upgradesList', localText); advance(); }}
          />
        );

      case 'hasHoa':
        return (
          <YesNoWithFieldScreen
            key={key}
            question="Is there an HOA?"
            fieldLabel="Monthly dues"
            fieldPlaceholder="e.g. 150"
            fieldType="number"
            value={localAnswer}
            fieldValue={localText}
            onAnswer={(v) => {
              setLocalAnswer(v);
              if (v === 'no') { set('hasHoa', 'no'); advance(); }
              else set('hasHoa', 'yes');
            }}
            onFieldChange={setLocalText}
            onContinue={() => { set('hoaDues', localText); advance(); }}
          />
        );

      case 'preListingPrep':
        return (
          <MultiSelectScreen
            key={key}
            question="Are you open to pre-listing prep?"
            note="Select everything you'd consider"
            options={['Minor repairs', 'Pre-listing inspection', 'Deep cleaning', 'Staging', 'Price strategy session']}
            selected={data.preListingPrep}
            onChange={(v) => set('preListingPrep', v)}
            onContinue={advance}
            optional
          />
        );

      case 'preListingSpend':
        return <OptionsScreen key={key} question="How much are you comfortable spending before listing?" options={['$0 – List as-is', '$1,000 – $5,000', '$5,000 – $15,000', 'Case-by-case']} onSelect={(v) => autoAdvance('preListingSpend', v)} />;

      case 'biggerFear':
        return <OptionsScreen key={key} question="What's your bigger fear?" options={['Deal falling apart', 'Leaving money on the table']} onSelect={(v) => autoAdvance('biggerFear', v)} />;

      case 'openToIncentives':
        return <OptionsScreen key={key} question="Are you open to offering seller incentives?" note="e.g. closing cost credits, rate buy-downs" options={['Yes, open to it', 'No, not interested']} onSelect={(v) => autoAdvance('openToIncentives', v)} />;

      case 'alsoLookingToBuy':
        return <YesNoScreen key={key} question="Are you also looking to buy a home?" note="We can help coordinate both transactions" value={localAnswer} onSelect={(v) => { setLocalAnswer(v); autoAdvance('alsoLookingToBuy', v); }} />;

      case 'buyTiming':
        return <OptionsScreen key={key} question="When would you like to buy?" options={['Before selling', 'After selling', 'Depends on timing']} onSelect={(v) => autoAdvance('buyTiming', v)} />;

      case 'needSaleProceeds':
        return <YesNoScreen key={key} question="Do you need the proceeds from this sale to buy your next home?" value={localAnswer} onSelect={(v) => { setLocalAnswer(v); autoAdvance('needSaleProceeds', v); }} />;

      case 'pitchPage':
        return <PitchPage key={key} onSelect={(choice) => { set('lenderChoice', choice); advance(); }} />;

      case 'smoothExitPitch': {
        const isBuying = data.alsoLookingToBuy === 'yes';
        const qualifiesBridge = isBuying;
        return (
          <div key={key} className="screen-enter flex flex-col items-center">
            <div className="mb-6 text-center">
              <h2 className="text-2xl font-bold text-brand-navy">One more thing.</h2>
              <p className="mt-2 text-sm text-gray-400">A service designed specifically for sellers like you.</p>
            </div>
            <div className="w-full max-w-md rounded-2xl overflow-hidden border-2 border-purple-200 bg-purple-50">
              <div className="p-5">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-lg">🚪</span>
                  <span className="text-xs font-bold uppercase tracking-widest text-purple-600">
                    Seller Concierge
                  </span>
                </div>
                <div className="text-xl font-black text-purple-900 mt-1">Smooth Exit</div>
                <p className="mt-2 text-sm text-purple-800/80 leading-relaxed">
                  {isBuying
                    ? "Buy your next home before this one closes — no contingent offers, no double mortgage. Plus we coordinate your entire move-out."
                    : "We coordinate your move-out, handle utility cancellations, get repair bids, and support you through closing — so you can focus on what's next."}
                </p>
                <div className="mt-3 inline-block rounded-lg bg-purple-100 px-3 py-1.5 text-sm font-black text-purple-800">
                  1% of sale price · paid from proceeds
                </div>
                {qualifiesBridge && (
                  <div className="mt-3 rounded-lg bg-white border border-purple-200 px-3 py-2 text-xs text-purple-700 font-medium">
                    ✅ You qualify for Buy Before You Sell — included at no extra cost.
                  </div>
                )}
              </div>
              <div className="border-t border-purple-200 px-5 py-3 flex items-center gap-3">
                <button
                  onClick={() => router.push(`/smooth-exit?fromOnboarding=true${dealId ? `&dealId=${dealId}` : ''}`)}
                  className="text-xs font-semibold text-purple-700 hover:text-purple-900 transition-colors"
                >
                  Learn more →
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => router.push(`/smooth-exit/survey?fromOnboarding=true${dealId ? `&dealId=${dealId}` : ''}`)}
                  className="rounded-xl bg-purple-700 px-4 py-2 text-xs font-bold text-white hover:bg-purple-800 transition-colors"
                >
                  Get Started
                </button>
                <button
                  onClick={advance}
                  className="rounded-xl border border-purple-200 bg-white px-4 py-2 text-xs font-semibold text-purple-600 hover:bg-purple-50 transition-colors"
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        );
      }

      case 'contactInfo': {
        const inputCls = 'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10';
        return (
          <div key={key} className="screen-enter flex flex-col items-center">
            <Question
              text="How can your agent reach you?"
              note="Your agent uses this to follow up and schedule your listing strategy call"
            />
            <div className="w-full max-w-sm space-y-3">
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Full name</label>
                <input type="text" value={localText} onChange={(e) => setLocalText(e.target.value)} placeholder="e.g. Jordan Smith" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Phone</label>
                <input type="tel" value={localText2} onChange={(e) => setLocalText2(e.target.value)} placeholder="(205) 555-0100" className={inputCls} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">Email</label>
                <input type="email" value={localAnswer} onChange={(e) => setLocalAnswer(e.target.value)} placeholder="you@example.com" className={inputCls} />
              </div>
              <ContinueBtn
                onClick={() => {
                  set('contactName', localText.trim());
                  set('contactPhone', localText2.trim());
                  set('contactEmail', localAnswer.trim());
                  advance();
                }}
                disabled={!localText.trim() || !localText2.trim() || !localAnswer.trim()}
              />
            </div>
          </div>
        );
      }

      case 'review': {
        if (!editLoaded) {
          return (
            <div key={key} className="screen-enter flex flex-col items-center py-10 text-center">
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
            key={key}
            rows={buildSellerReview(data, visibleScreens)}
            onEdit={editAnswer}
            onSubmit={editMode ? saveEdits : advance}
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

      case 'confirmation':
        return <ConfirmationScreen key={key} data={data} agentName={agentName} />;

      default:
        return null;
    }
  }

  return (
    <OnboardingLayout
      progress={progress}
      onBack={showBack ? back : undefined}
      label="Seller"
    >
      {renderScreen(currentId)}
    </OnboardingLayout>
  );
}
