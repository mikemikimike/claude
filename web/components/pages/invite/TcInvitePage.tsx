"use client";

/**
 * The Transaction Coordinator invite landing page (#446).
 *
 * Sibling of InvitePage, and deliberately the same shape: show who invited them
 * and when the link dies BEFORE anyone is walked into creating an Auth0 account
 * (#278), stash the token, then let AuthSetup claim it after the round-trip.
 *
 * This page is the only route to becoming an agent's TC. Signing up with the
 * invited address and never opening this link grants nothing.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth0 } from "@auth0/auth0-react";
import { api, ApiError } from "@/lib/api-client";
import { ClipboardCheck, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

type TcInviteDetails = {
  token: string;
  email: string;
  name: string;
  agent_name: string;
  expires_at: string;
  claimed: boolean;
};

export default function TcInvitePage() {
  const { token } = useParams<{ token: string }>();
  const { loginWithRedirect, isAuthenticated, isLoading: auth0Loading, user } = useAuth0();

  const query = useQuery({
    queryKey: ["tc-invite", token],
    queryFn: () => api.get<TcInviteDetails>(`/tc-invites/${token}`),
    enabled: Boolean(token),
    retry: false,
  });

  const invite = query.data ?? null;
  const loading = query.isLoading;
  const isExpired = query.error instanceof ApiError && query.error.status === 410;
  const error: string | null = !token
    ? "Invalid invite link"
    : query.error instanceof Error
      ? "Invite not found or has expired."
      : null;

  // AuthSetup reads these back after the Auth0 round-trip and claims the invite.
  function persistPending() {
    if (!token || !invite) return false;
    localStorage.setItem("pendingTcInvite", token);
    localStorage.setItem("pendingTcInviteEmail", invite.email);
    return true;
  }

  function signUp() {
    if (!persistPending()) return;
    loginWithRedirect({
      authorizationParams: { screen_hint: "signup", login_hint: invite!.email },
      appState: { returnTo: "/" },
    });
  }

  function logIn() {
    if (!persistPending()) return;
    loginWithRedirect({
      authorizationParams: { login_hint: invite!.email },
      appState: { returnTo: "/" },
    });
  }

  function acceptAsCurrentUser() {
    if (!persistPending()) return;
    window.location.href = "/";
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
          <p data-testid="tc-invite-expired" className="text-sm text-gray-400">
            This invite link has expired. Ask the agent to re-save you in Settings →
            Transaction Coordinator and you&apos;ll get a fresh link.
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
          <p className="text-sm text-gray-400">
            {error ?? "This invite link is invalid or has expired."}
          </p>
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
          <p className="text-sm text-gray-400">
            This invite has already been used. Log in to get to your TC dashboard.
          </p>
          <button
            onClick={() =>
              loginWithRedirect({
                authorizationParams: { login_hint: invite.email },
                appState: { returnTo: "/" },
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

  const loggedInEmail = isAuthenticated ? user?.email ?? null : null;
  const emailMismatch = Boolean(
    loggedInEmail && loggedInEmail.toLowerCase() !== invite.email.toLowerCase()
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-bg p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-xl font-bold text-brand-navy tracking-tight">RealTour Flow</span>
        </div>

        <div className="rounded-2xl bg-white shadow-xl overflow-hidden">
          <div className="bg-brand-navy px-6 py-6 text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
              <ClipboardCheck size={26} className="text-white" />
            </div>
            <h1 className="text-lg font-bold text-white">You&apos;ve been invited</h1>
            <p className="mt-1 text-sm text-white/60">as a Transaction Coordinator</p>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div className="rounded-xl bg-brand-bg px-4 py-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Agent
                </span>
                <span className="text-sm font-bold text-brand-navy">{invite.agent_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  Your role
                </span>
                <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700">
                  Transaction Coordinator
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                  For
                </span>
                <span className="text-sm text-gray-700">{invite.email}</span>
              </div>
            </div>

            {emailMismatch && (
              <div
                data-testid="tc-invite-email-mismatch"
                className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
                <p className="text-xs leading-relaxed text-amber-800">
                  You&apos;re signed in as <span className="font-semibold">{loggedInEmail}</span>,
                  but this invite was sent to <span className="font-semibold">{invite.email}</span>.
                  Accepting from this account won&apos;t work — forward the link to the right
                  inbox.
                </p>
              </div>
            )}

            <p className="text-xs text-gray-400 text-center leading-relaxed">
              Accepting gives you access to {invite.agent_name}&apos;s deals, tasks, checklists,
              documents, and internal messages. They can remove you at any time.
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
                  <Link
                    href="/forgot-password"
                    className="font-semibold text-brand-navy hover:underline"
                  >
                    Forgot password?
                  </Link>
                </p>
              </div>
            )}

            <p className="text-[11px] text-gray-300 text-center">
              Expires{" "}
              {new Date(invite.expires_at).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
