"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth0 } from '@auth0/auth0-react';
import { api } from "@/lib/api-client";
import { Briefcase, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

type AgentInviteDetails = {
  id: string;
  email: string;
  name: string;
  token: string;
  claimed: boolean;
  expires_at: string;
};

export default function AgentSignupPage() {
  const { token } = useParams<{ token: string }>();
  const { loginWithRedirect, isAuthenticated, isLoading: auth0Loading, user } = useAuth0();

  const query = useQuery({
    queryKey: ['agent-invite', token],
    queryFn: () => api.get<AgentInviteDetails>(`/agent-invites/${token}`),
    enabled: Boolean(token),
    retry: false,
  });

  const invite = query.data ?? null;
  const loading = query.isLoading;
  const error: string | null = !token
    ? 'Invalid invite link'
    : query.error instanceof Error
      ? 'This invite link is invalid or has expired.'
      : null;

  // #425 — the client invite page now names its onboarding route explicitly
  // (`/onboard/buyer` | `/onboard/seller`) because a client's post-signup
  // destination is ambiguous: `/` is the portal AND the questionnaire's parent.
  // An agent has no such ambiguity — RootRedirect sends any agent whose
  // onboarding is incomplete to `/onboard/agent`, and a brand-new account
  // always is — so `/` here already lands in onboarding. Same outcome, one
  // fewer hard-coded route. Keep it that way unless agent onboarding grows a
  // second entry point.
  function accept() {
    if (!token || !invite) return;
    localStorage.setItem('pendingAgentInvite', token);
    localStorage.setItem('pendingAgentInviteEmail', invite.email);
    loginWithRedirect({
      authorizationParams: {
        screen_hint: 'signup',
        login_hint: invite.email,
      },
      appState: { returnTo: '/' },
    });
  }

  function logIn() {
    if (!token || !invite) return;
    localStorage.setItem('pendingAgentInvite', token);
    localStorage.setItem('pendingAgentInviteEmail', invite.email);
    loginWithRedirect({ appState: { returnTo: '/' } });
  }

  if (auth0Loading || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg">
        <Loader2 size={28} className="animate-spin text-brand-navy/40" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-8 text-center">
          <AlertCircle size={40} className="mx-auto mb-4 text-red-400" />
          <h1 className="text-lg font-bold text-brand-navy mb-2">Invite not found</h1>
          <p className="text-sm text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  if (invite?.claimed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
        <div className="w-full max-w-sm rounded-2xl bg-white shadow-xl p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto mb-4 text-green-400" />
          <h1 className="text-lg font-bold text-brand-navy mb-2">Already accepted</h1>
          <p className="text-sm text-gray-400 mb-5">This invite has already been used. Log in to access your account.</p>
          <button
            onClick={() => loginWithRedirect({ appState: { returnTo: '/' } })}
            className="w-full rounded-xl bg-brand-navy py-3 text-sm font-bold text-white hover:bg-brand-navy/90 transition-colors"
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

  // #224 — an authenticated user opening someone else's agent invite (a
  // forwarded link, or the admin previewing it) gets a clear warning. The
  // server rejects the claim for existing non-agent accounts either way;
  // this is UX.
  const loggedInEmail = isAuthenticated ? user?.email ?? null : null;
  const emailMismatch = Boolean(
    invite && loggedInEmail && loggedInEmail.toLowerCase() !== invite.email.toLowerCase()
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-xl font-bold text-brand-navy tracking-tight">RealTour Flow</span>
        </div>

        <div className="rounded-2xl bg-white shadow-xl overflow-hidden">
          <div className="bg-brand-navy px-6 py-7 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
              <Briefcase size={26} className="text-white" />
            </div>
            <h1 className="text-lg font-bold text-white">Agent Invitation</h1>
            <p className="mt-1 text-sm text-white/60">You&apos;ve been invited to join as an agent</p>
          </div>

          <div className="px-6 py-6 space-y-5">
            <div className="rounded-xl bg-brand-bg px-4 py-3.5 space-y-2.5">
              {invite?.name && (
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Name</span>
                  <span className="text-sm font-semibold text-brand-navy">{invite.name}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Email</span>
                <span className="text-sm text-gray-700">{invite?.email}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Role</span>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">Agent</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Expires</span>
                <span className="text-xs text-gray-500">
                  {invite ? new Date(invite.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : ''}
                </span>
              </div>
            </div>

            {emailMismatch && (
              <div
                data-testid="agent-invite-email-mismatch"
                className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-800">
                  You&apos;re signed in as <span className="font-semibold">{loggedInEmail}</span>,
                  but this invite was sent to <span className="font-semibold">{invite?.email}</span>.
                  Accepting from this account won&apos;t work — sign out and accept the invite
                  with the invited email.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-400 text-center leading-relaxed">
              Create your account to access the agent dashboard, manage deals, and get started with onboarding.
            </p>

            {isAuthenticated ? (
              <button
                onClick={logIn}
                className="w-full rounded-xl bg-brand-navy py-3.5 text-sm font-bold text-white hover:bg-brand-navy/90 active:scale-[0.98] transition-all"
              >
                Accept invitation →
              </button>
            ) : (
              <div className="space-y-2.5">
                <button
                  onClick={accept}
                  className="w-full rounded-xl bg-brand-navy py-3.5 text-sm font-bold text-white hover:bg-brand-navy/90 active:scale-[0.98] transition-all"
                >
                  Create my account →
                </button>
                <button
                  onClick={logIn}
                  className="w-full rounded-xl border border-gray-200 bg-white py-3 text-sm font-semibold text-brand-navy hover:bg-gray-50 transition-all"
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
          </div>
        </div>
      </div>
    </div>
  );
}
