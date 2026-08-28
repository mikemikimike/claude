"use client";

import { useState, useEffect } from 'react';
import Image from "next/image";
import { api } from "@/lib/api-client";
import {
  User, Store, Bell, Plug, Star, Pencil, Trash2,
  ChevronUp, ChevronDown, Plus, X, Check, ExternalLink,
  Phone, Mail, Users, UserCheck, FileText, Upload, FileSignature,
} from 'lucide-react';
import { useAuthStore } from "@/lib/store/authStore";
import { useTC, useMyAgents } from "@/hooks/useTC";
import { MyFormsSection } from "@/components/pages/settings/MyFormsSection";
import MarketMultiSelect from "@/components/MarketMultiSelect";
import { BROKERAGE_FALLBACK } from "@/lib/brokerages";
import {
  VendorCategory,
  VENDOR_CATEGORY_LABELS,
  VENDOR_CATEGORY_ORDER,
} from "@/lib/vendor-categories";
import { useVendors, Vendor, VendorInput } from "@/hooks/useVendors";
import { useSettings } from "@/hooks/useSettings";
import { useMLSConnection } from "@/hooks/useMLS";
import { uploadAgentPhoto } from "@/hooks/useAgentPhoto";
import { useIntegrations } from "@/hooks/useIntegrations";
import { settingsTabFromSearch } from "@/lib/settings-nav";

// ─── Tabs ─────────────────────────────────────────────────────────────────────

type Tab = 'profile' | 'tc' | 'vendors' | 'my_agents' | 'notifications' | 'integrations' | 'forms';

// Tabs vary by role — built dynamically in the main component

// ─── Vendor Modal ─────────────────────────────────────────────────────────────

type VendorFormData = VendorInput;

const EMPTY_FORM = (): VendorFormData => ({
  category: 'home_inspector',
  company: '',
  contactName: '',
  phone: '',
  email: '',
  website: '',
  notes: '',
  isFeatured: false,
});

function VendorModal({
  initial,
  defaultCategory,
  onSave,
  onClose,
}: {
  initial?: Vendor;
  defaultCategory?: VendorCategory;
  onSave: (data: VendorFormData) => Promise<void> | void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<VendorFormData>(() => {
    if (initial) return { ...initial };
    const base = EMPTY_FORM();
    if (defaultCategory) base.category = defaultCategory;
    return base;
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  function set<K extends keyof VendorFormData>(k: K, v: VendorFormData[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  const isEdit = !!initial;
  const canSave = form.company.trim().length > 0 && !saving;

  async function handleClick() {
    if (!canSave) return;
    setSaving(true);
    setSaveErr('');
    try {
      await onSave(form);
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to save vendor. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-md rounded-t-3xl sm:rounded-2xl bg-white shadow-2xl overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-4 flex-shrink-0">
          <h2 className="font-bold text-brand-navy">
            {isEdit ? 'Edit Vendor' : 'Add Vendor'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          {/* Category */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Category
            </label>
            <select
              value={form.category}
              onChange={(e) => set('category', e.target.value as VendorCategory)}
              disabled={isEdit}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10 disabled:opacity-60"
            >
              {VENDOR_CATEGORY_ORDER.map((cat) => (
                <option key={cat} value={cat}>
                  {VENDOR_CATEGORY_LABELS[cat]}
                </option>
              ))}
            </select>
          </div>

          {/* Company */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Company <span className="text-red-400">*</span>
            </label>
            <input
              value={form.company}
              onChange={(e) => set('company', e.target.value)}
              placeholder="e.g. BirminghamHome Inspections"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
            />
          </div>

          {/* Contact name */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Contact name
            </label>
            <input
              value={form.contactName ?? ''}
              onChange={(e) => set('contactName', e.target.value)}
              placeholder="e.g. Ray Simmons"
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
            />
          </div>

          {/* Phone + Email */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Phone
              </label>
              <input
                value={form.phone ?? ''}
                onChange={(e) => set('phone', e.target.value)}
                placeholder="(205) 555-0188"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
                Email
              </label>
              <input
                type="email"
                value={form.email ?? ''}
                onChange={(e) => set('email', e.target.value)}
                placeholder="name@company.com"
                className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
              />
            </div>
          </div>

          {/* Website */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Website
            </label>
            <input
              value={form.website ?? ''}
              onChange={(e) => set('website', e.target.value)}
              placeholder="https://..."
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-400">
              Notes <span className="font-normal normal-case text-gray-300">(shown to clients)</span>
            </label>
            <textarea
              value={form.notes ?? ''}
              onChange={(e) => set('notes', e.target.value)}
              placeholder='e.g. "Ask for Mike" or "Best for older homes"'
              rows={2}
              className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10 resize-none"
            />
          </div>

          {/* Featured */}
          <button
            onClick={() => set('isFeatured', !form.isFeatured)}
            className={[
              'flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 transition-all',
              form.isFeatured
                ? 'border-brand-gold bg-brand-gold/10'
                : 'border-gray-100 bg-gray-50 hover:border-gray-200',
            ].join(' ')}
          >
            <Star
              size={18}
              className={form.isFeatured ? 'fill-brand-gold text-brand-gold' : 'text-gray-300'}
            />
            <div className="text-left">
              <div className="text-sm font-semibold text-brand-navy">Featured vendor</div>
              <div className="text-xs text-gray-400">Shown as top pick in this category for your clients</div>
            </div>
            {form.isFeatured && <Check size={15} className="ml-auto text-brand-gold" />}
          </button>
        </div>

        {/* Footer */}
        <div className="border-t px-5 py-4 flex flex-col gap-2 flex-shrink-0">
          {saveErr && (
            <p className="text-xs text-red-600 text-center">{saveErr}</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={saving}
              className="flex-1 rounded-xl border border-gray-200 py-2.5 text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleClick}
              disabled={!canSave}
              className={[
                'flex-1 rounded-xl py-2.5 text-sm font-bold transition-all',
                canSave
                  ? 'bg-brand-navy text-white hover:bg-brand-navy/90'
                  : 'cursor-not-allowed bg-gray-100 text-gray-300',
              ].join(' ')}
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add vendor'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Vendors Section ──────────────────────────────────────────────────────────

function VendorsSection({ agentId: _agentId }: { agentId: string }) {
  const { vendors, addVendor, updateVendor, deleteVendor, moveVendor, toggleFeatured } =
    useVendors();

  const [modal, setModal] = useState<
    { mode: 'add'; category: VendorCategory } | { mode: 'edit'; vendor: Vendor } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function handleSave(data: VendorFormData) {
    if (modal?.mode === 'edit') {
      await updateVendor(modal.vendor.id, data);
    } else if (modal?.mode === 'add') {
      await addVendor({ ...data, category: modal.category });
    }
    setModal(null);
  }

  const modalCategory =
    modal?.mode === 'add' ? modal.category :
    modal?.mode === 'edit' ? modal.vendor.category :
    undefined;

  return (
    <div className="space-y-1">
      <p className="mb-5 text-sm text-gray-400">
        These vendors appear in your clients&apos; portals under &quot;Preferred Vendors.&quot; Changes apply to all active deals.
      </p>

      {VENDOR_CATEGORY_ORDER.map((category) => {
        const catVendors = vendors.filter((v) => v.category === category);

        return (
          <div key={category} className="rounded-2xl bg-white shadow-sm overflow-hidden">
            {/* Category header */}
            <div className="flex items-center justify-between border-b border-gray-50 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-brand-navy">
                  {VENDOR_CATEGORY_LABELS[category]}
                </span>
                {catVendors.length > 0 && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-500">
                    {catVendors.length}
                  </span>
                )}
              </div>
              <button
                onClick={() => setModal({ mode: 'add', category })}
                className="flex items-center gap-1 rounded-lg bg-brand-navy/5 px-2.5 py-1 text-xs font-semibold text-brand-navy hover:bg-brand-navy/10 transition-colors"
              >
                <Plus size={12} /> Add
              </button>
            </div>

            {/* Vendor rows */}
            {catVendors.length === 0 ? (
              <div className="px-4 py-3 text-xs text-gray-300 italic">No vendors added yet</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {catVendors.map((v, posInCat) => (
                  <div key={v.id} className="flex items-center gap-3 px-4 py-3">
                    {/* Featured star */}
                    <button
                      onClick={() => toggleFeatured(v.id)}
                      title={v.isFeatured ? 'Remove featured' : 'Mark as featured'}
                      className="flex-shrink-0"
                    >
                      <Star
                        size={15}
                        className={
                          v.isFeatured
                            ? 'fill-brand-gold text-brand-gold'
                            : 'text-gray-200 hover:text-gray-300 transition-colors'
                        }
                      />
                    </button>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-brand-navy truncate">
                        {v.company}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {v.contactName && (
                          <span className="text-xs text-gray-400 truncate">{v.contactName}</span>
                        )}
                        {v.phone && (
                          <span className="flex items-center gap-0.5 text-xs text-gray-300">
                            <Phone size={10} /> {v.phone}
                          </span>
                        )}
                        {v.email && (
                          <span className="flex items-center gap-0.5 text-xs text-gray-300">
                            <Mail size={10} />
                          </span>
                        )}
                      </div>
                      {v.notes && (
                        <div className="mt-0.5 text-xs text-gray-400 italic truncate">{v.notes}</div>
                      )}
                    </div>

                    {/* Reorder */}
                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                      <button
                        onClick={() => moveVendor(v.id, 'up')}
                        disabled={posInCat === 0}
                        className="rounded p-0.5 text-gray-200 hover:text-gray-400 disabled:opacity-0 transition-colors"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        onClick={() => moveVendor(v.id, 'down')}
                        disabled={posInCat === catVendors.length - 1}
                        className="rounded p-0.5 text-gray-200 hover:text-gray-400 disabled:opacity-0 transition-colors"
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>

                    {/* Edit */}
                    <button
                      onClick={() => setModal({ mode: 'edit', vendor: v })}
                      className="flex-shrink-0 rounded-lg p-1.5 text-gray-300 hover:bg-gray-100 hover:text-gray-500 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>

                    {/* Delete */}
                    {confirmDelete === v.id ? (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          onClick={() => { deleteVendor(v.id); setConfirmDelete(null); }}
                          className="rounded-lg bg-red-500 px-2 py-1 text-xs font-bold text-white hover:bg-red-600 transition-colors"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-gray-400 hover:bg-gray-100 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(v.id)}
                        className="flex-shrink-0 rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-400 transition-colors"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Modal */}
      {modal && (
        <VendorModal
          initial={modal.mode === 'edit' ? modal.vendor : undefined}
          defaultCategory={modalCategory}
          onSave={handleSave}
          onClose={() => setModal(null)}
        />
      )}
      {modal && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setModal(null)}
        />
      )}
    </div>
  );
}

// ─── Profile Section ──────────────────────────────────────────────────────────

function ProfileSection() {
  const { activeUser } = useAuthStore();
  const { settings, loading: settingsLoading, saveSettings, saveProfile } = useSettings();
  const [form, setForm] = useState({
    name: activeUser?.name ?? '',
    phone: '',
    title: '',
    licenseNumber: '',
    bio: '',
  });
  const [markets, setMarkets] = useState<string[]>([]);
  const [brokerage, setBrokerage] = useState('');
  const [brokerageOther, setBrokerageOther] = useState(false);
  // Company + markets hydrate from GET /me/profile — the SOURCE OF TRUTH (the
  // settings JSON blob can be stale/missing) — and are only sent on Save after
  // hydration, so a failed fetch can never wipe the profile columns.
  const [profileLoaded, setProfileLoaded] = useState(false);
  useEffect(() => {
    api.get<{ markets?: string[]; market?: string; brokerage?: string }>('/me/profile')
      .then((p) => {
        const saved = Array.isArray(p.markets) ? p.markets : [];
        setMarkets(saved.length > 0 ? saved : p.market ? [p.market] : []);
        setBrokerage(p.brokerage ?? '');
        setProfileLoaded(true);
      })
      .catch(() => {});
  }, []);
  // Managed company list (seeded fallback while the fetch resolves); the saved
  // value may be an admin-pending "Other" name — the picker shows it via the
  // Other input once both fetches have settled.
  const [companies, setCompanies] = useState<string[]>(BROKERAGE_FALLBACK);
  useEffect(() => {
    api.get<string[]>('/brokerages')
      .then((names) => { if (names.length > 0) setCompanies(names); })
      .catch(() => {});
  }, []);
  const [photoUrl, setPhotoUrl] = useState<string>('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoErr, setPhotoErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // React 19 pattern for "hydrate local form state from fetched settings":
  // compare to previous value during render rather than syncing in useEffect.
  // The onboarding flow writes these into the settings JSONB, so we prefer
  // those values over the empty initial form state.
  const [prevSettings, setPrevSettings] = useState(settings);
  if (!settingsLoading && settings !== prevSettings) {
    setPrevSettings(settings);
    setForm((f) => ({
      ...f,
      name: (settings.name as string) ?? f.name,
      phone: (settings.phone as string) ?? '',
      title: (settings.title as string) ?? '',
      licenseNumber: (settings.licenseNumber as string) ?? '',
      bio: (settings.bio as string) ?? '',
    }));
    setPhotoUrl((settings.photoUrl as string) ?? '');
  }

  async function handleSave() {
    setSaving(true);
    try {
      await Promise.all([
        saveProfile(form.name, form.phone, {
          // Only write company/markets once hydrated from the profile — an
          // unresolved fetch must never wipe them (undefined = leave unchanged).
          ...(profileLoaded ? { markets, brokerage } : {}),
        }),
        saveSettings({
          name: form.name,
          phone: form.phone,
          title: form.title,
          licenseNumber: form.licenseNumber,
          ...(profileLoaded ? { markets, brokerage } : {}),
          bio: form.bio,
        }),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Error handling — could add toast here
    } finally {
      setSaving(false);
    }
  }

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPhotoErr('Please choose an image file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setPhotoErr('Image is too large — max 5 MB.');
      return;
    }
    setPhotoErr('');
    setPhotoUploading(true);
    try {
      const url = await uploadAgentPhoto(file);
      setPhotoUrl(url);
      await saveSettings({ photoUrl: url });
    } catch (err) {
      setPhotoErr(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setPhotoUploading(false);
    }
  }

  const initials = (form.name || activeUser?.email || '?')
    .split(/[\s@]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <div className="space-y-5 max-w-lg">
      {/* Avatar */}
      <div className="flex items-center gap-4">
        <div className="relative h-16 w-16 flex-shrink-0">
          {photoUrl ? (
            <Image
              src={photoUrl}
              alt={form.name || 'Headshot'}
              width={64}
              height={64}
              unoptimized
              className="h-16 w-16 rounded-2xl ring-2 ring-brand-navy/10 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-navy/10 ring-2 ring-brand-navy/10 text-lg font-bold text-brand-navy">
              {initials || '?'}
            </div>
          )}
          <label className="absolute -bottom-1 -right-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-brand-navy text-white shadow-sm hover:bg-brand-navy/90 transition-colors">
            {photoUploading ? (
              <span className="text-[10px] font-bold">…</span>
            ) : (
              <Upload size={12} />
            )}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handlePhotoChange}
              disabled={photoUploading}
            />
          </label>
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-brand-navy truncate">{form.name || activeUser?.email}</div>
          <div className="text-xs text-gray-400 truncate">{activeUser?.email}</div>
          <div className="mt-1 rounded-full bg-brand-navy/5 px-2 py-0.5 text-xs font-semibold text-brand-navy inline-block">
            {activeUser?.role}
          </div>
          {photoErr && <p className="mt-1 text-xs text-red-500">{photoErr}</p>}
        </div>
      </div>

      <div className="rounded-2xl bg-white shadow-sm divide-y divide-gray-50 overflow-hidden">
        {[
          { label: 'Full name', key: 'name', placeholder: 'Your name' },
          { label: 'Phone', key: 'phone', placeholder: '(205) 555-0100' },
          { label: 'Title', key: 'title', placeholder: 'e.g. Realtor, Senior Agent' },
          { label: 'License #', key: 'licenseNumber', placeholder: 'e.g. AL-012345' },
        ].map(({ label, key, placeholder }) => (
          <div key={key} className="flex items-center gap-4 px-5 py-3.5">
            <label className="w-28 flex-shrink-0 text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {label}
            </label>
            <input
              value={form[key as keyof typeof form]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="flex-1 rounded-lg border border-transparent bg-gray-50 px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-navy/20 focus:bg-white focus:ring-2 focus:ring-brand-navy/10 transition-all"
            />
          </div>
        ))}

        {/* Company — from the managed list; "Other" queues the typed name for
            admin review into the dropdown. */}
        <div className="flex items-center gap-4 px-5 py-3.5">
          <label className="w-28 flex-shrink-0 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Company
          </label>
          <div className="flex-1 space-y-2">
            <select
              value={brokerageOther || (brokerage && !companies.includes(brokerage)) ? '__other__' : brokerage}
              onChange={(e) => {
                if (e.target.value === '__other__') {
                  setBrokerageOther(true);
                } else {
                  setBrokerageOther(false);
                  setBrokerage(e.target.value);
                }
              }}
              className="w-full rounded-lg border border-transparent bg-gray-50 px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-navy/20 focus:bg-white focus:ring-2 focus:ring-brand-navy/10 transition-all"
            >
              <option value="">Select your company…</option>
              {companies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
              <option value="__other__">Other…</option>
            </select>
            {(brokerageOther || (brokerage !== '' && !companies.includes(brokerage))) && (
              <input
                value={brokerage}
                onChange={(e) => setBrokerage(e.target.value)}
                placeholder="Type your company name"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-navy/20 focus:ring-2 focus:ring-brand-navy/10 transition-all"
              />
            )}
          </div>
        </div>

        {/* Markets — multi-select; the first pick is the primary market that
            drives board contract forms. */}
        <div className="px-5 py-3.5">
          <label className="mb-2 block text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Market(s) <span className="font-normal normal-case text-gray-300">select all you serve</span>
          </label>
          <MarketMultiSelect selected={markets} onChange={setMarkets} />
        </div>

        {/* Bio */}
        <div className="px-5 py-3.5">
          <label className="mb-2 block text-xs font-semibold text-gray-400 uppercase tracking-wide">
            Bio <span className="font-normal normal-case text-gray-300">(shown to clients)</span>
          </label>
          <textarea
            value={form.bio}
            onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
            placeholder="A short introduction that your clients will see in their portal..."
            rows={3}
            className="w-full rounded-lg border border-transparent bg-gray-50 px-3 py-2 text-sm text-gray-800 outline-none focus:border-brand-navy/20 focus:bg-white focus:ring-2 focus:ring-brand-navy/10 transition-all resize-none"
          />
        </div>
      </div>

      {/* Email note */}
      <p className="text-xs text-gray-300">
        Email address is managed by your admin and cannot be changed here.
      </p>

      <button
        onClick={handleSave}
        disabled={saving}
        className={[
          'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-all',
          saved
            ? 'bg-green-500 text-white'
            : saving
            ? 'bg-brand-navy/60 text-white cursor-not-allowed'
            : 'bg-brand-navy text-white hover:bg-brand-navy/90 active:scale-[0.98]',
        ].join(' ')}
      >
        {saved ? <><Check size={15} /> Saved</> : saving ? 'Saving…' : 'Save profile'}
      </button>
    </div>
  );
}

// ─── Notifications Section ────────────────────────────────────────────────────

const NOTIFICATION_ITEMS = [
  {
    group: 'Deals',
    items: [
      { id: 'deal_stage', label: 'Deal stage changes', sub: 'When a deal advances or falls back a stage' },
      { id: 'new_task', label: 'New task assigned to me', sub: 'When a task is created and assigned to you' },
      { id: 'overdue_task', label: 'Overdue task alert', sub: 'Daily reminder for tasks past their due date' },
    ],
  },
  {
    group: 'Clients',
    items: [
      { id: 'fastpass_enroll', label: 'Fast Pass enrollment', sub: 'When a client submits a Fast Pass request' },
      { id: 'disclosure_reminder', label: 'Disclosure reminder', sub: 'When disclosures are sent but unsigned for 48+ hours' },
      { id: 'new_message', label: 'New client message', sub: 'When a client sends a message through the portal' },
    ],
  },
  {
    group: 'Delivery',
    items: [
      { id: 'email', label: 'Email notifications', sub: 'Receive alerts via email' },
      { id: 'push', label: 'Push / text notifications', sub: 'Receive alerts via SMS or push' },
    ],
  },
];

const NOTIFICATION_DEFAULTS: Record<string, boolean> = {
  deal_stage: true,
  new_task: true,
  overdue_task: true,
  fastpass_enroll: true,
  disclosure_reminder: true,
  new_message: false,
  email: true,
  push: false,
};

function NotificationsSection() {
  const { settings, loading, saveSettings } = useSettings();
  const [enabled, setEnabled] = useState<Record<string, boolean>>(NOTIFICATION_DEFAULTS);

  // React 19 pattern: compare to previous notifications during render to
  // hydrate local state when settings finish loading.
  const [prevNotifs, setPrevNotifs] = useState(settings.notifications);
  if (!loading && settings.notifications && settings.notifications !== prevNotifs) {
    setPrevNotifs(settings.notifications);
    setEnabled({ ...NOTIFICATION_DEFAULTS, ...(settings.notifications as Record<string, boolean>) });
  }

  function toggle(id: string) {
    const updated = { ...enabled, [id]: !enabled[id] };
    setEnabled(updated);
    saveSettings({ notifications: updated });
  }

  return (
    <div className="space-y-5 max-w-lg">
      {NOTIFICATION_ITEMS.map(({ group, items }) => (
        <div key={group}>
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-gray-400">{group}</h3>
          <div className="rounded-2xl bg-white shadow-sm divide-y divide-gray-50 overflow-hidden">
            {items.map(({ id, label, sub }) => (
              <div key={id} className="flex items-center justify-between px-5 py-3.5">
                <div className="flex-1 min-w-0 pr-4">
                  <div className="text-sm font-semibold text-brand-navy">{label}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{sub}</div>
                </div>
                <button
                  onClick={() => toggle(id)}
                  className={[
                    'relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors',
                    enabled[id] ? 'bg-brand-navy' : 'bg-gray-200',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                      enabled[id] ? 'translate-x-6' : 'translate-x-1',
                    ].join(' ')}
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Integrations Section ─────────────────────────────────────────────────────

function MLSCard() {
  const { connected, loading, saveMLS, disconnectMLS } = useMLSConnection();
  const [expanded, setExpanded] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [secretInput, setSecretInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function handleSave() {
    if (!keyInput.trim() || !secretInput.trim() || saving) return;
    setSaving(true);
    setSaveErr('');
    try {
      await saveMLS(keyInput.trim(), secretInput.trim());
      setSaved(true);
      setExpanded(false);
      setKeyInput('');
      setSecretInput('');
      setTimeout(() => setSaved(false), 3000);
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to save — check your credentials');
    }
    setSaving(false);
  }

  async function handleDisconnect() {
    await disconnectMLS().catch(() => {});
    setConfirmDisconnect(false);
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gray-50 text-2xl">
          🏠
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-bold text-brand-navy text-sm">SimplyRETS MLS</span>
            {!loading && connected && (
              <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                <Check size={9} strokeWidth={3} /> Connected
              </span>
            )}
            {saved && (
              <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                <Check size={9} strokeWidth={3} /> Saved!
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-400 leading-relaxed">
            Connect your SimplyRETS account to show live MLS listings to buyers in their portal. Buyers can browse active listings and add homes to their tracked list.
          </p>
          {!loading && connected && (
            <p className="mt-1 text-xs text-green-600 font-medium">Live MLS listings are active in all buyer portals</p>
          )}
        </div>
      </div>

      {/* Credential form */}
      {expanded && (
        <div className="border-t border-gray-50 px-5 py-4 space-y-3 bg-gray-50/50">
          <p className="text-[11px] text-gray-400 leading-relaxed">
            Enter your SimplyRETS API credentials. Find them at{' '}
            <span className="font-semibold text-brand-navy">app.simplyrets.com</span> under your app settings.
          </p>
          <div className="space-y-2">
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="API Key (username)"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
            />
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder="API Secret (password)"
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-brand-navy/30 focus:ring-2 focus:ring-brand-navy/10"
            />
          </div>
          {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={!keyInput.trim() || !secretInput.trim() || saving}
              className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-4 py-2 text-xs font-bold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-40"
            >
              <Check size={12} /> {saving ? 'Verifying…' : 'Save & connect'}
            </button>
            <button
              onClick={() => { setExpanded(false); setKeyInput(''); setSecretInput(''); setSaveErr(''); }}
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-gray-50 px-5 py-3 flex items-center justify-between">
        {!loading && !connected && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-navy/90 transition-colors"
          >
            <ExternalLink size={11} /> Connect SimplyRETS
          </button>
        )}
        {!loading && connected && !confirmDisconnect && (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
            >
              <Pencil size={11} /> Update credentials
            </button>
            <button
              onClick={() => setConfirmDisconnect(true)}
              className="text-xs text-gray-300 hover:text-red-400 transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
        {confirmDisconnect && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Remove MLS connection?</span>
            <button onClick={handleDisconnect} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-600">
              Disconnect
            </button>
            <button onClick={() => setConfirmDisconnect(false)} className="text-xs text-gray-400 hover:text-gray-600">
              Cancel
            </button>
          </div>
        )}
        {loading && <span className="text-xs text-gray-300">Loading…</span>}
        {!loading && !connected && !expanded && (
          <span className="text-xs text-gray-300">Live MLS listings for buyer portals</span>
        )}
      </div>
    </div>
  );
}

// Compact card layout used for every integration row so the section reads
// consistently regardless of whether the integration is platform-wide or
// per-agent.
function IntegrationCard({
  logo, name, description, statusBadge, primaryAction, secondaryAction, footnote,
}: {
  logo: string;
  name: string;
  description: string;
  statusBadge?: { label: string; color: 'green' | 'amber' | 'gray' };
  primaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  secondaryAction?: { label: string; onClick: () => void };
  footnote?: string;
}) {
  const badgeColor =
    statusBadge?.color === 'green' ? 'bg-green-100 text-green-700'
    : statusBadge?.color === 'amber' ? 'bg-amber-100 text-amber-800'
    : 'bg-gray-100 text-gray-500';

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
      <div className="flex items-start gap-4 p-5">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-gray-50 text-2xl">
          {logo}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-brand-navy text-sm">{name}</span>
            {statusBadge && (
              <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${badgeColor}`}>
                {statusBadge.label}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-400 leading-relaxed">{description}</p>
          {footnote && (
            <p className="mt-1 text-xs text-gray-500">{footnote}</p>
          )}
        </div>
      </div>
      {(primaryAction || secondaryAction) && (
        <div className="border-t border-gray-50 px-5 py-3 flex items-center gap-3">
          {primaryAction && (
            <button
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
              className="flex items-center gap-1.5 rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-navy/90 transition-colors disabled:opacity-40"
            >
              <ExternalLink size={11} />
              {primaryAction.label}
            </button>
          )}
          {secondaryAction && (
            <button
              onClick={secondaryAction.onClick}
              className="text-xs font-semibold text-gray-400 hover:text-red-500 transition-colors"
            >
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function IntegrationsSection() {
  const { activeUser } = useAuthStore();
  const isAgent = activeUser?.groupId === 'agent' || activeUser?.groupId === 'admin';
  const { status, loading, error, startOAuth, disconnect, refresh } = useIntegrations();
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  // After the OAuth callback bounces the user back to /agent/settings?integrations=...
  // we surface a one-time toast so the agent sees that the connection landed
  // (or that it failed). React 19 pattern: capture the initial query state at
  // mount via a lazy useState initializer; setActionError gets called from
  // there exactly once.
  const [integrationsInitFlag] = useState<{ flag: string | null; reason: string | null }>(() => {
    if (typeof window === 'undefined') return { flag: null, reason: null };
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('integrations');
    const reason = params.get('reason');
    if (flag) {
      // Clean the query string so a refresh doesn't keep showing the toast.
      params.delete('integrations');
      params.delete('reason');
      const newSearch = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (newSearch ? `?${newSearch}` : ''));
    }
    return { flag, reason };
  });

  // Apply the initial query state. We use a one-shot guard so the side
  // effect (refresh + setActionError) only fires once.
  const [initApplied, setInitApplied] = useState(false);
  if (!initApplied && integrationsInitFlag.flag) {
    setInitApplied(true);
    if (integrationsInitFlag.flag.endsWith('_connected')) {
      void refresh();
    } else if (integrationsInitFlag.flag.endsWith('_error')) {
      setActionError(`Calendar connection failed: ${integrationsInitFlag.reason ?? 'unknown'}`);
    }
  }

  async function handleConnect(provider: 'google_calendar' | 'microsoft_calendar') {
    setBusy(provider);
    setActionError('');
    try {
      await startOAuth(provider);
      // startOAuth navigates away; we won't typically reach here.
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not start connection.');
      setBusy(null);
    }
  }

  async function handleDisconnect(provider: 'google_calendar' | 'microsoft_calendar', label: string) {
    if (!window.confirm(`Disconnect ${label}? Existing calendar events stay in place; new milestones won't be pushed.`)) return;
    setBusy(provider);
    setActionError('');
    try {
      await disconnect(provider);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not disconnect.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 max-w-lg">
      {error && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">{error}</div>
      )}
      {actionError && (
        <div className="rounded-xl bg-red-50 px-4 py-3 text-xs text-red-700">{actionError}</div>
      )}

      {/* SimplyRETS MLS — agents only, real connection */}
      {isAgent && <MLSCard />}

      {/* Google Calendar — per-user OAuth */}
      <IntegrationCard
        logo="📅"
        name="Google Calendar"
        description="Push closing dates and task deadlines from RealTourFlow into your Google Calendar. Events update automatically when stages advance or due dates change."
        statusBadge={
          !status.google_calendar.configured
            ? { label: 'Not configured on server', color: 'gray' }
            : status.google_calendar.connected && status.google_calendar.needs_reconnect
            ? { label: 'Reconnect needed', color: 'amber' }
            : status.google_calendar.connected
            ? { label: status.google_calendar.account_email || 'Connected', color: 'green' }
            : { label: 'Not connected', color: 'amber' }
        }
        primaryAction={
          status.google_calendar.configured &&
          (!status.google_calendar.connected || status.google_calendar.needs_reconnect)
            ? {
                label: busy === 'google_calendar'
                  ? 'Opening…'
                  : status.google_calendar.needs_reconnect
                  ? 'Reconnect Google Calendar'
                  : 'Connect Google Calendar',
                onClick: () => handleConnect('google_calendar'),
                disabled: busy === 'google_calendar' || loading,
              }
            : undefined
        }
        secondaryAction={
          status.google_calendar.connected
            ? { label: busy === 'google_calendar' ? 'Disconnecting…' : 'Disconnect', onClick: () => handleDisconnect('google_calendar', 'Google Calendar') }
            : undefined
        }
        footnote={
          !status.google_calendar.configured
            ? 'Admin: set GOOGLE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URL to enable.'
            : status.google_calendar.connected && status.google_calendar.needs_reconnect
            ? 'Access was revoked or expired — reconnect to resume calendar sync.'
            : undefined
        }
      />

      {/* Microsoft Calendar — per-user OAuth */}
      <IntegrationCard
        logo="📆"
        name="Outlook / Office 365"
        description="Push deal milestones into Outlook via Microsoft Graph. Works with personal Microsoft accounts and Office 365 work accounts."
        statusBadge={
          !status.microsoft_calendar.configured
            ? { label: 'Not configured on server', color: 'gray' }
            : status.microsoft_calendar.connected && status.microsoft_calendar.needs_reconnect
            ? { label: 'Reconnect needed', color: 'amber' }
            : status.microsoft_calendar.connected
            ? { label: status.microsoft_calendar.account_email || 'Connected', color: 'green' }
            : { label: 'Not connected', color: 'amber' }
        }
        primaryAction={
          status.microsoft_calendar.configured &&
          (!status.microsoft_calendar.connected || status.microsoft_calendar.needs_reconnect)
            ? {
                label: busy === 'microsoft_calendar'
                  ? 'Opening…'
                  : status.microsoft_calendar.needs_reconnect
                  ? 'Reconnect Outlook'
                  : 'Connect Outlook',
                onClick: () => handleConnect('microsoft_calendar'),
                disabled: busy === 'microsoft_calendar' || loading,
              }
            : undefined
        }
        secondaryAction={
          status.microsoft_calendar.connected
            ? { label: busy === 'microsoft_calendar' ? 'Disconnecting…' : 'Disconnect', onClick: () => handleDisconnect('microsoft_calendar', 'Outlook') }
            : undefined
        }
        footnote={
          !status.microsoft_calendar.configured
            ? 'Admin: set MICROSOFT_OAUTH_CLIENT_ID / SECRET / REDIRECT_URL to enable.'
            : status.microsoft_calendar.connected && status.microsoft_calendar.needs_reconnect
            ? 'Access was revoked or expired — reconnect to resume calendar sync.'
            : undefined
        }
      />

      {/* DocuSign — platform-wide service */}
      <IntegrationCard
        logo="📄"
        name="DocuSign"
        description="Send any deal document for signature directly from the Documents tab on a deal. Signed envelopes sync back automatically."
        statusBadge={
          status.docusign.configured
            ? { label: 'Enabled platform-wide', color: 'green' }
            : { label: 'Not configured on server', color: 'gray' }
        }
        footnote={
          status.docusign.configured
            ? 'Open any deal → Documents tab → "Send for signature" to use DocuSign.'
            : 'Admin: set DOCUSIGN_INTEGRATION_KEY / USER_ID / ACCOUNT_ID / PRIVATE_KEY.'
        }
      />

      {/* Stripe — platform-wide payments */}
      <IntegrationCard
        logo="💳"
        name="Stripe Payments"
        description="Fast Pass enrollment fees, Smooth Exit fees, and the $75 closing fee are processed through Stripe Checkout."
        statusBadge={
          status.stripe.configured
            ? { label: 'Enabled platform-wide', color: 'green' }
            : { label: 'Not configured on server', color: 'gray' }
        }
        footnote={
          status.stripe.configured
            ? 'Buyers see a Stripe Checkout link in their Fast Pass / Smooth Exit flow.'
            : 'Admin: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.'
        }
      />

      {/* ARIVE — per-deal, Mountain Mortgage scope */}
      <IntegrationCard
        logo="🏔️"
        name="ARIVE (Mountain Mortgage)"
        description="Real-time loan milestone sync for Mountain Mortgage / Fast Pass buyers. Disclosures, underwriting status, and clear-to-close update automatically once a loan ID is linked to the deal."
        statusBadge={
          status.arive.configured
            ? { label: 'Enabled platform-wide', color: 'green' }
            : { label: 'Not configured on server', color: 'gray' }
        }
        footnote={
          status.arive.configured
            ? 'Link a buyer\'s ARIVE loan from the deal\'s Overview tab. Fast Pass enrollments auto-link.'
            : 'Admin: set ARIVE_API_URL / ARIVE_API_KEY / ARIVE_CLIENT_ID / ARIVE_CLIENT_SECRET.'
        }
      />
    </div>
  );
}

// ─── Transaction Coordinator Section (agents only) ───────────────────────────

function TransactionCoordinatorSection({ agentId: _agentId }: { agentId: string }) {
  const { tc: existing, saveTC, removeTC } = useTC();

  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // What the last save actually did, so the card can stop making promises the
  // API doesn't keep (#415): 'invited' = we emailed them, 'linked' = they
  // already had an account, 'send-failed' = saved but the email bounced out.
  const [outcome, setOutcome] = useState<'invited' | 'linked' | 'send-failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // React 19 pattern: hydrate local form state from fetched record by
  // comparing to previous value during render.
  const [prevExisting, setPrevExisting] = useState(existing);
  if (existing !== prevExisting) {
    setPrevExisting(existing);
    if (existing) setForm({ name: existing.name, email: existing.email, phone: existing.phone });
  }

  const canSave = form.name.trim().length > 0 && form.email.trim().length > 0;

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveTC(form.name, form.email, form.phone);
      setOutcome(
        result.userId ? 'linked' : result.invited ? 'invited' : 'send-failed'
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setOutcome(null);
      setError(err instanceof Error ? err.message : 'Could not save your TC.');
    }
    setSaving(false);
  }

  async function handleClear() {
    await removeTC().catch(() => {});
    setForm({ name: '', email: '', phone: '' });
    setOutcome(null);
    setError(null);
    setConfirmClear(false);
  }

  return (
    <div className="space-y-5 max-w-lg">
      {/* Explainer */}
      <div className="rounded-2xl bg-blue-50 border border-blue-100 px-5 py-4">
        <div className="flex items-start gap-3">
          <UserCheck size={18} className="text-blue-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-800">Your dedicated Transaction Coordinator</p>
            <p className="text-xs text-blue-600 mt-1 leading-relaxed">
              Your TC is automatically added to every deal you work. They get access to the file, the internal message thread, checklists, and tasks. Only you can assign your TC — update this anytime if your coordinator changes.
            </p>
          </div>
        </div>
      </div>

      {/* Current TC card */}
      {existing && (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-50">
            <span className="text-xs font-bold uppercase tracking-wider text-gray-400">Current TC</span>
          </div>
          <div className="flex items-center gap-4 px-5 py-4">
            <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 font-bold text-lg">
              {existing.name.charAt(0)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-brand-navy">{existing.name}</span>
                {existing.userId ? (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                    In RealTourFlow
                  </span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    Invite pending
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="flex items-center gap-1 text-xs text-gray-400">
                  <Mail size={11} /> {existing.email}
                </span>
                {existing.phone && (
                  <span className="flex items-center gap-1 text-xs text-gray-400">
                    <Phone size={11} /> {existing.phone}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit form */}
      <div className="rounded-2xl bg-white shadow-sm divide-y divide-gray-50 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-50">
          <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
            {existing ? 'Update TC info' : 'Add your TC'}
          </span>
        </div>
        {[
          { label: 'Full name',     key: 'name',  placeholder: 'e.g. Jamie Taylor',          required: true },
          { label: 'Email',         key: 'email', placeholder: 'jamie@youroffice.com',        required: true },
          { label: 'Phone',         key: 'phone', placeholder: '(205) 555-0100',              required: false },
        ].map(({ label, key, placeholder, required }) => (
          <div key={key} className="flex items-center gap-4 px-5 py-3.5">
            <label className="w-24 flex-shrink-0 text-xs font-semibold text-gray-400 uppercase tracking-wide">
              {label}{required && <span className="text-red-400 ml-0.5">*</span>}
            </label>
            <input
              type={key === 'email' ? 'email' : 'text'}
              value={form[key as keyof typeof form] ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              placeholder={placeholder}
              className="flex-1 rounded-lg border border-transparent bg-gray-50 px-3 py-1.5 text-sm text-gray-800 outline-none focus:border-brand-navy/20 focus:bg-white focus:ring-2 focus:ring-brand-navy/10 transition-all"
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-300">
        We&apos;ll email them an invite when you save. They&apos;re connected once they open that link and accept — the link expires in 7 days, and signing up without it won&apos;t connect them to you.
      </p>

      {outcome === 'invited' && (
        <p className="text-xs font-semibold text-green-600">
          Invite sent to {form.email.trim().toLowerCase()}. They&apos;ll show as connected once they accept it.
        </p>
      )}
      {outcome === 'linked' && (
        <p className="text-xs font-semibold text-green-600">
          Connected — no change to their access.
        </p>
      )}
      {outcome === 'send-failed' && (
        <p className="text-xs font-semibold text-amber-600">
          Saved, but we couldn&apos;t send the invite email to {form.email.trim().toLowerCase()}. Save again to retry — they can&apos;t connect without that link.
        </p>
      )}
      {error && <p className="text-xs font-semibold text-red-500">{error}</p>}

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={[
            'flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition-all',
            saved
              ? 'bg-green-500 text-white'
              : canSave
              ? 'bg-brand-navy text-white hover:bg-brand-navy/90 active:scale-[0.98]'
              : 'bg-gray-100 text-gray-300 cursor-not-allowed',
          ].join(' ')}
        >
          {saved ? <><Check size={15} /> Saved</> : saving ? 'Saving…' : existing ? 'Update TC' : 'Save TC'}
        </button>

        {existing && !confirmClear && (
          <button
            onClick={() => setConfirmClear(true)}
            className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-400 hover:border-red-200 hover:text-red-400 transition-colors"
          >
            Remove TC
          </button>
        )}
        {confirmClear && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Remove {existing?.name}?</span>
            <button onClick={handleClear} className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-red-600">
              Yes, remove
            </button>
            <button onClick={() => setConfirmClear(false)} className="text-xs text-gray-400 hover:text-gray-600">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── My Agents Section (TC only) ─────────────────────────────────────────────

function MyAgentsSection({ tcUserId: _tcUserId }: { tcUserId: string }) {
  const { agents: myAgents, loading } = useMyAgents();

  return (
    <div className="space-y-5 max-w-lg">
      {/* Explainer */}
      <div className="rounded-2xl bg-amber-50 border border-amber-100 px-5 py-4">
        <div className="flex items-start gap-3">
          <Users size={18} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-800">Agents you work with</p>
            <p className="text-xs text-amber-700 mt-1 leading-relaxed">
              These agents have added you as their Transaction Coordinator. You&apos;re automatically included in their deals, internal messages, and checklists. Agents manage this relationship from their own settings.
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="rounded-2xl bg-white shadow-sm px-5 py-6 text-center">
          <p className="text-sm text-gray-300">Loading…</p>
        </div>
      ) : myAgents.length === 0 ? (
        <div className="rounded-2xl bg-white shadow-sm px-5 py-10 text-center">
          <Users size={28} className="mx-auto mb-2 text-gray-200" />
          <p className="text-sm text-gray-400">No agents linked yet</p>
          <p className="text-xs text-gray-300 mt-1">Agents add you from their Settings → Transaction Coordinator tab</p>
        </div>
      ) : (
        <div className="rounded-2xl bg-white shadow-sm overflow-hidden divide-y divide-gray-50">
          {myAgents.map((agent) => (
            <div key={agent.id} className="flex items-center gap-4 px-5 py-4">
              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-brand-navy/10 text-brand-navy font-bold text-sm">
                {agent.name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <span className="font-bold text-brand-navy">{agent.name}</span>
                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                  <a
                    href={`mailto:${agent.email}`}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-navy transition-colors"
                  >
                    <Mail size={11} /> {agent.email}
                  </a>
                  {agent.phone && (
                    <a
                      href={`tel:${agent.phone}`}
                      className="flex items-center gap-1 text-xs text-gray-400 hover:text-brand-navy transition-colors"
                    >
                      <Phone size={11} /> {agent.phone}
                    </a>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="flex items-center gap-1.5 justify-end">
                  <FileText size={13} className="text-gray-300" />
                  <span className="text-sm font-bold text-brand-navy">{agent.activeDealCount}</span>
                </div>
                <div className="text-[10px] text-gray-300 mt-0.5">active deals</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <p className="text-xs text-gray-300">
          {myAgents.length} agent{myAgents.length !== 1 ? 's' : ''} · You appear in {myAgents.reduce((sum, a) => sum + a.activeDealCount, 0)} active deal files
        </p>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { activeUser } = useAuthStore();
  const role = activeUser?.groupId ?? 'agent';
  const isAgent = role === 'agent' || role === 'admin';
  const isTC    = role === 'tc';

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'profile',   label: 'Profile',                  icon: <User size={15} /> },
    ...(isAgent ? [{ id: 'tc' as Tab,        label: 'Transaction Coordinator', icon: <UserCheck size={15} /> }] : []),
    ...(isAgent ? [{ id: 'vendors' as Tab,   label: 'My Vendors',             icon: <Store size={15} /> }] : []),
    ...(isAgent ? [{ id: 'forms' as Tab,     label: 'My Forms',               icon: <FileSignature size={15} /> }] : []),
    ...(isTC    ? [{ id: 'my_agents' as Tab, label: 'My Agents',              icon: <Users size={15} /> }] : []),
    { id: 'notifications', label: 'Notifications', icon: <Bell size={15} /> },
    { id: 'integrations',  label: 'Integrations',  icon: <Plug size={15} /> },
  ];

  // Open the Integrations tab when an OAuth connect bounces back here, so its
  // return-flow handler (status refresh / error toast) runs.
  const [tab, setTab] = useState<Tab>(() =>
    settingsTabFromSearch(typeof window !== 'undefined' ? window.location.search : '')
  );
  const agentId = activeUser?.id ?? 'agent-sarah';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-brand-navy">Settings</h1>
        <p className="text-sm text-gray-400 mt-0.5">Manage your profile, vendors, and integrations</p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-100 pb-px">
        {TABS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={[
              'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-t-lg px-4 py-2.5 text-sm font-semibold transition-colors',
              tab === id
                ? 'border-b-2 border-brand-navy text-brand-navy'
                : 'text-gray-400 hover:text-gray-600',
            ].join(' ')}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {/* Section content */}
      {tab === 'profile'        && <ProfileSection />}
      {tab === 'tc'             && <TransactionCoordinatorSection agentId={agentId} />}
      {tab === 'vendors'        && <VendorsSection agentId={agentId} />}
      {tab === 'forms'          && <MyFormsSection />}
      {tab === 'my_agents'      && <MyAgentsSection tcUserId={activeUser?.id ?? 'tc-taylor'} />}
      {tab === 'notifications'  && <NotificationsSection />}
      {tab === 'integrations'   && <IntegrationsSection />}
    </div>
  );
}
