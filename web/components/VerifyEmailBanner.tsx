"use client";

import { useEffect, useState } from 'react';
import { MailWarning, X, Loader2 } from 'lucide-react';
import { api } from "@/lib/api-client";
import { useAuthStore } from "@/lib/store/authStore";

/** null = the server could not determine it (Management API unconfigured/down). */
type VerificationStatus = { email_verified: boolean | null };
type ResendResponse = { ok: boolean; already_verified?: boolean };
type SendState = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Answer for this tab: true/false when known, `"unknown"` when the server told
 * us it couldn't check. Distinct from the cache's `null`, which means "not
 * fetched yet" — collapsing the two would make the guard below treat every
 * unknown as a cache miss and re-request on every client-side navigation.
 */
type Verification = boolean | 'unknown';

// Per-tab memory so client-side navigation between sections doesn't re-hit the
// Auth0 Management API (the GET route calls it) or resurrect a dismissed banner.
let cachedVerified: Verification | null = null;
let dismissedThisSession = false;

/**
 * Clears the per-tab cache. Called on logout so the next account to sign in on
 * this tab re-checks its OWN verification state instead of inheriting the
 * previous user's answer (or their dismissal).
 */
export function resetVerifyEmailBannerCache(): void {
  cachedVerified = null;
  dismissedThisSession = false;
}

/**
 * Unverified-email prompt (FF2 #20). Mounted in every AppLayout variant; checks
 * the caller's verification state via GET /api/auth/verification once per tab
 * and offers a "Resend verification" action (POST, caller-scoped server-side).
 *
 * Quiet by design: any lookup failure — or the Management API being
 * unconfigured — renders nothing rather than nagging users about a state we
 * can't actually check.
 */
export default function VerifyEmailBanner() {
  const isLoaded = useAuthStore((s) => s.isLoaded);
  const activeUser = useAuthStore((s) => s.activeUser);
  const [verified, setVerified] = useState<Verification | null>(cachedVerified);
  const [dismissed, setDismissed] = useState(dismissedThisSession);
  const [sendState, setSendState] = useState<SendState>('idle');

  useEffect(() => {
    if (!isLoaded || !activeUser || cachedVerified !== null) return;
    let cancelled = false;
    api
      .get<VerificationStatus>('/auth/verification')
      .then((status) => {
        // null from the server = it couldn't determine the state. Record that
        // as a real answer so the cache is filled and we don't re-ask on every
        // navigation — but never as `true`, which would claim it IS verified.
        const next: Verification = status.email_verified ?? 'unknown';
        cachedVerified = next;
        if (!cancelled) setVerified(next);
      })
      .catch(() => {
        // Can't check (offline, unconfigured, transient) — stay quiet, but
        // record it as unknown rather than asserting verified.
        cachedVerified = 'unknown';
        if (!cancelled) setVerified('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, activeUser]);

  if (!isLoaded || !activeUser || verified !== false || dismissed) return null;

  function dismiss() {
    dismissedThisSession = true;
    setDismissed(true);
  }

  async function resend() {
    if (sendState === 'sending') return;
    setSendState('sending');
    try {
      const res = await api.post<ResendResponse>('/auth/verification', {});
      if (res.already_verified) {
        cachedVerified = true;
        setVerified(true);
        return;
      }
      setSendState('sent');
    } catch {
      setSendState('error');
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 bg-blue-50 border-b border-blue-200 px-5 py-2.5">
      <div className="flex items-center gap-2 text-sm text-blue-800">
        <MailWarning size={15} className="flex-shrink-0" />
        <span className="font-semibold">Verify your email.</span>
        <span className="text-blue-600 hidden sm:inline">
          We sent a verification link to {activeUser.email}.
        </span>
      </div>
      <div className="flex items-center gap-3 flex-shrink-0">
        {sendState === 'sent' ? (
          <span className="text-xs font-bold text-green-600">
            Sent — check your inbox
          </span>
        ) : (
          <>
            {sendState === 'error' && (
              <span className="text-xs font-semibold text-red-500 hidden sm:inline">
                Couldn&apos;t send — try again
              </span>
            )}
            <button
              onClick={resend}
              disabled={sendState === 'sending'}
              className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1 text-xs font-bold text-white hover:bg-blue-700 transition-colors disabled:opacity-60"
            >
              {sendState === 'sending' && <Loader2 size={12} className="animate-spin" />}
              {sendState === 'sending' ? 'Sending…' : 'Resend verification'}
            </button>
          </>
        )}
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="text-blue-300 hover:text-blue-500 transition-colors"
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
