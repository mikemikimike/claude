"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth0 } from '@auth0/auth0-react';
import { api, ApiError } from "@/lib/api-client";
import { Home, UserPlus, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';

type InviteDetails = {
  token: string;
  deal_id: string;
  email: string;
  name: string;
  role: 'buyer' | 'seller';
  agent_name: string;
  deal_title: string;
  expires_at: string;
  claimed: boolean;
};

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const { loginWithRedirect, isAuthenticated, isLoading: auth0Loading, user } = useAuth0();

  const query = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InviteDetails>(`/invites/${token}`),
    enabled: Boolean(token),
    retry: false,
  });

  const invite = query.data ?? null;
  const loading = query.isLoading;
  // #278 — the GET returns 410 for an expired, unclaimed invite. Surface that as
  // a distinct state (before the generic error branch) so the user sees an
  // "ask your agent to resend" message instead of an Accept button that would
  // only dead-end after they've already created an Auth0 account.
  const isExpired = query.error instanceof ApiError && query.error.status === 410;
  const error: string | null = !token
    ? 'Invalid invite link'
    : query.error instanceof Error
      ? 'Invite not found or has expired.'
      : null;

  // AuthSetup reads these back after the Auth0 round-trip and claims the invite.
  function persistPending() {
    if (!token || !invite) return false;
    localStorage.setItem('pendingInvite', token);
    localStorage.setItem('pendingInviteEmail', invite.email);
    return true;
  }

  // Brand-new client — go straight to Auth0's SIGN-UP screen with the invited
  // email prefilled. Without screen_hint they landed on the LOG-IN form and had
  // to find "Create new account" themselves, which is where the onboarding
  // dead-ended. Mirrors AgentSignupPage.
  function signUp() {
    if (!persistPending()) return;
    loginWithRedirect({
      authorizationParams: { screen_hint: 'signup', login_hint: invite!.email },
      appState: { returnTo: '/' },
    });
  }

  // Client who already has a RealTourFlow account (e.g. a second deal).
  function logIn() {
    if (!persistPending()) return;
    loginWithRedirect({
      authorizationParams: { login_hint: invite!.email },
      appState: { returnTo: '/' },
    });
  }

  // Already signed in — root triggers the claim in AuthSetup.
  function acceptAsCurrentUser() {
    if (!persistPending()) return;
    window.location.href = '/';
  }

  if (auth0Loading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg">
        <Loader2 size={28} className="animate-spin text-brand-navy/40" />
      </div>
    );
  }

  if (isExpired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-8 text-center">
          <AlertCircle size={40} className="mx-auto mb-4 text-amber-400" />
          <h1 className="text-lg font-bold text-brand-navy mb-2">Invite expired</h1>
          <p data-testid="invite-expired" className="text-sm text-gray-400">
            This invite link has expired. Ask your agent to resend it and you&apos;ll get a fresh link to accept.
          </p>
        </div>
      </div>
    );
  }

  if (error || !invite) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-8 text-center">
          <AlertCircle size={40} className="mx-auto mb-4 text-red-400" />
          <h1 className="text-lg font-bold text-brand-navy mb-2">Invite not found</h1>
          <p className="text-sm text-gray-400">{error ?? 'This invite link is invalid or has expired.'}</p>
        </div>
      </div>
    );
  }

  if (invite.claimed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-4 text-green-400" />
          <h1 className="text-lg font-bold text-brand-navy mb-2">Already accepted</h1>
          <p className="text-sm text-gray-400">This invite has already been claimed. Log in to access your deal.</p>
          <button
            onClick={() =>
              loginWithRedirect({
                authorizationParams: { login_hint: invite.email },
                appState: { returnTo: '/' },
              })
            }
            className="mt-5 w-full rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
          >
            Log in
          </button>
          <p className="mt-3 text-center text-xs text-gray-400">
            <Link href="/forgot-password" className="font-semibold text-brand-navy hover:underline">
              Forgot password?
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const RoleIcon = invite.role === 'buyer' ? Home : UserPlus;
  const roleColor = invite.role === 'buyer' ? 'bg-green-100 text-green-700' : 'bg-purple-100 text-purple-700';

  // #174 — an authenticated user opening someone else's invite (usually the
  // inviting agent previewing the link) gets a clear warning. The server
  // rejects the claim for agent/admin/TC accounts either way; this is UX.
  const loggedInEmail = isAuthenticated ? user?.email ?? null : null;
  const emailMismatch = Boolean(
    loggedInEmail && loggedInEmail.toLowerCase() !== invite.email.toLowerCase()
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-6 text-center">
          <span className="text-xl font-bold text-brand-navy tracking-tight">RealTour Flow</span>
        </div>

        <div className="rounded-2xl bg-white shadow-xl overflow-hidden">
          {/* Header */}
          <div className="bg-brand-navy px-6 py-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
              <RoleIcon size={26} className="text-white" />
            </div>
            <h1 className="text-lg font-bold text-white">You&apos;re invited!</h1>
            <p className="mt-1 text-sm text-white/60">to join a real estate transaction</p>
          </div>

          {/* Details */}
          <div className="px-6 py-5 space-y-4">
            <div className="rounded-xl bg-brand-bg px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Deal</span>
                <span className="text-sm font-bold text-brand-navy">{invite.deal_title}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Agent</span>
                <span className="text-sm text-gray-700">{invite.agent_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Your role</span>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold capitalize ${roleColor}`}>
                  {invite.role}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">For</span>
                <span className="text-sm text-gray-700">{invite.email}</span>
              </div>
            </div>

            {emailMismatch && (
              <div
                data-testid="invite-email-mismatch"
                className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-800">
                  You&apos;re signed in as <span className="font-semibold">{loggedInEmail}</span>,
                  but this invite was sent to <span className="font-semibold">{invite.email}</span>.
                  Accepting from this account won&apos;t work — send the link to your client so
                  they can accept it themselves.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-400 text-center leading-relaxed">
              By accepting, you&apos;ll get access to your deal file, tasks, messages, and documents through the client portal.
            </p>

            {isAuthenticated ? (
              <button
                onClick={acceptAsCurrentUser}
                className="w-full rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 active:scale-[0.98] transition-all shadow-sm"
              >
                Accept invitation →
              </button>
            ) : (
              <div className="space-y-2.5">
                <button
                  onClick={signUp}
                  className="w-full rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 active:scale-[0.98] transition-all shadow-sm"
                >
                  Create my account →
                </button>
                <button
                  onClick={logIn}
                  className="w-full rounded-xl border border-gray-200 bg-white py-3 text-sm font-semibold text-brand-navy hover:bg-gray-50 transition-colors"
                >
                  I already have an account
                </button>
                <p className="text-center text-xs text-gray-400">
                  <Link href="/forgot-password" className="font-semibold text-brand-navy hover:underline">
                    Forgot password?
                  </Link>
                </p>
              </div>
            )}

            <p className="text-[11px] text-gray-300 text-center">
              Expires {new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
