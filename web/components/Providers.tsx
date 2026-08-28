"use client";

import { Auth0Provider } from "@auth0/auth0-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ReactNode, useState, useSyncExternalStore } from "react";
import { ApiError } from "@/lib/api-client";
import AuthSetup from "@/components/AuthSetup";
import TestAuthSetup from "@/components/TestAuthSetup";

/**
 * Where to send a user once Auth0 hands them back (#425).
 *
 * Every `loginWithRedirect()` in the app already passed
 * `appState: { returnTo }`, but `Auth0Provider` had no `onRedirectCallback`, so
 * auth0-react ran its DEFAULT one — which only strips `?code=&state=` from the
 * URL and drops appState on the floor. Every returning user therefore landed on
 * `/` regardless, which is why an invited client asking for
 * `/onboard/buyer` ended up on the portal instead.
 *
 * Kept pure and exported so the rules are unit-testable. Relative in-app paths
 * only: `appState` round-trips through Auth0, so treating it as a destination
 * is only safe if it can never become another origin.
 */
export function resolveReturnTo(appState: unknown): string {
  const to = (appState as { returnTo?: unknown } | undefined)?.returnTo;
  if (typeof to !== "string") return "/";
  // "/x" is in-app; "//host" and "https://host" are not, and a scheme-relative
  // "//" is the classic open-redirect bypass of a naive startsWith("/") check.
  if (!to.startsWith("/") || to.startsWith("//")) return "/";
  return to;
}

// E2E-only: when Playwright seeds a session we bypass Auth0 entirely (see
// TestAuthSetup). Off in every normal/production build.
const E2E_AUTH = process.env.NEXT_PUBLIC_E2E_AUTH === "1";

// useSyncExternalStore returns the server snapshot (`false`) during SSR AND the
// first client/hydration render, then the client snapshot (`true`) — so the
// hydration render matches the server output without a setState-in-effect.
const subscribeNoop = () => () => {};
const getIsClient = () => true;
const getIsServer = () => false;

/**
 * The half of the stack that genuinely needs `window`. Auth0Provider reads
 * `window.location.origin` for `redirect_uri`, so it can only render on the
 * client — see the `isClient` gate in Providers below.
 */
function ClientAuthProviders({ children }: { children: ReactNode }) {
  const origin = window.location.origin;
  const router = useRouter();

  // E2E: seeded session via cookie, no Auth0Provider. The E2E flow only visits
  // protected pages (which read identity from the auth store), so nothing calls
  // useAuth0 and we can drop the provider safely.
  if (E2E_AUTH) return <TestAuthSetup>{children}</TestAuthSetup>;

  return (
    <Auth0Provider
      domain={process.env.NEXT_PUBLIC_AUTH0_DOMAIN ?? ""}
      clientId={process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID ?? ""}
      authorizationParams={{
        redirect_uri: origin,
        audience: process.env.NEXT_PUBLIC_AUTH0_AUDIENCE,
      }}
      // #425 — makes `appState.returnTo` mean something. A client-side
      // `router.replace` (not `window.location`) so the token auth0-react just
      // exchanged stays in memory; it also strips the `?code=&state=` query the
      // library's default callback was the only thing removing.
      //
      // This does NOT race the pending-invite claim: AuthSetup lives INSIDE
      // this provider, so it mounts and fires the claim regardless of which
      // route we land on, and the onboarding questionnaire only writes minutes
      // later on its final screen.
      onRedirectCallback={(appState) => router.replace(resolveReturnTo(appState))}
    >
      <AuthSetup>{children}</AuthSetup>
    </Auth0Provider>
  );
}

/**
 * Client-side provider stack. Wraps everything in Auth0Provider so React Router
 * pages can call useAuth0(); also fires /users/sync via AuthSetup.
 *
 * The Auth0 half of the stack is deferred until the client (see the `isClient`
 * flag) so the first client render matches the server-rendered HTML — otherwise
 * the client-only Auth0Provider subtree triggers a hydration mismatch.
 * QueryClientProvider is NOT deferred; see below.
 */
export function Providers({ children }: { children: ReactNode }) {
  // Defer the entire client-only provider stack until after the first client
  // render. SSR and the initial client render must produce the SAME tree or
  // React throws a hydration mismatch. Reading `window.location.origin` in a
  // useState initializer broke that: the server rendered just `children` (no
  // `window` → no providers), while the client's first render injected
  // the Auth0Provider subtree the server never produced
  // (issue #102). Gating on a client flag keeps the first client render
  // identical to SSR, then swaps in the providers once `window` is guaranteed.
  const isClient = useSyncExternalStore(subscribeNoop, getIsClient, getIsServer);

  // One QueryClient per Providers mount. Lazy initializer ensures we don't
  // recreate it on every render.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Never retry auth errors (401/403) — they're permanent until the user
            // re-authenticates. Cap all other errors at 2 retries (issue #108).
            retry: (failureCount: number, error: unknown) => {
              if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return false;
              return failureCount < 2;
            },
            retryDelay: (attempt: number) => Math.min(1_000 * 2 ** attempt, 30_000),
          },
        },
      }),
  );

  // QueryClientProvider sits OUTSIDE the `isClient` gate on purpose (issue
  // #398). A QueryClient is inert during SSR — it touches no `window`, starts
  // no fetch, and emits no DOM — so it renders identically on the server and on
  // the first client render, which is all #102 requires. Keeping it behind the
  // gate meant `"use client"` pages that call useQuery at the top level (the
  // two invite landing pages) threw "No QueryClient set" on every server
  // render: React recovered by client-rendering the whole route, so users saw
  // the right page, but those routes lost SSR and logged an error per request.
  //
  // Only the Auth0 subtree below still waits for the client, so the first
  // client render is `QueryClientProvider > children` — exactly what the server
  // produced — and the providers swap in once `window` is guaranteed.
  return (
    <QueryClientProvider client={queryClient}>
      {isClient ? <ClientAuthProviders>{children}</ClientAuthProviders> : children}
    </QueryClientProvider>
  );
}
