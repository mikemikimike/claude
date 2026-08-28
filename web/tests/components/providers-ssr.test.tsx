// @vitest-environment happy-dom
/**
 * Issue #398 — "No QueryClient set" thrown during SSR on the two invite landing
 * pages (`/agent-signup/[token]`, `/invite/[token]`).
 *
 * Both pages are `"use client"` components that call `useQuery` at the top of
 * the component — and Next.js still SERVER-renders client components. `Providers`
 * used to gate its ENTIRE stack (including `QueryClientProvider`) behind a
 * post-mount flag, so on the server there was no QueryClient above them and
 * `useQuery` threw. React silently discarded the failed server render and fell
 * back to client rendering, so users saw the right page — but the routes lost
 * SSR completely and every hit logged an error in production.
 *
 * The fix hoists `QueryClientProvider` ABOVE the client gate: a QueryClient is
 * inert during SSR and has no `window` dependency, so it renders identically on
 * the server and on the first client render. Only the Auth0 subtree (which
 * reads `window.location.origin`) stays behind the gate.
 *
 * That gate exists for issue #102 — a hydration mismatch caused by the client's
 * FIRST render injecting a subtree the server never produced. So this file also
 * locks the hydration contract down: SSR markup and the first client render must
 * be identical, with the client-only stack appearing only afterwards.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "@testing-library/react";
import { Providers } from "@/components/Providers";
import AgentSignupPage from "@/components/pages/agent-signup/AgentSignupPage";
import InvitePage from "@/components/pages/invite/InvitePage";

// Both pages read the route token via useParams; outside a Next router that
// returns null and destructuring it throws for reasons unrelated to this test.
// `useRouter` is here because Providers' client-only subtree now takes one for
// the `onRedirectCallback` that honours appState.returnTo (#425) — it mounts
// during hydration below, so the hook has to resolve.
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "11111111-1111-4111-8111-111111111111" }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
}));

// The real Auth0Provider phones the tenant on mount (checkSession), which we
// neither want nor need in CI: this file is about WHERE the provider stack
// renders, not what Auth0 does. The stand-in emits a marker element so a test
// can tell the client-only stack apart from the server render.
//
// `useAuth0` is deliberately left REAL — with no provider above it, it returns
// the library's initial context (`isLoading: true`), which is exactly what the
// pages see when Next.js server-renders them in production.
vi.mock("@auth0/auth0-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@auth0/auth0-react")>();
  const { createElement } = await import("react");
  return {
    ...actual,
    Auth0Provider: ({ children }: { children: React.ReactNode }) =>
      createElement("div", { "data-testid": "auth0-provider-mounted" }, children),
  };
});

// SSR never invokes a queryFn, but hydration does once the gate flips. Stub the
// GET to a rejection so the test stays off the network and every promise it
// starts actually settles — both pages pass `retry: false`, so react-query
// takes the one failure and stops.
vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      get: () => Promise.reject(new Error("network disabled in this test")),
    },
  };
});

const AUTH0_MARKER = "auth0-provider-mounted";

const mounted: { root: Root; container: HTMLElement }[] = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
});

/**
 * Hydrates `tree` over its own server-rendered HTML and reports everything React
 * complained about along the way. A hydration mismatch surfaces both as a
 * recoverable error and as a console.error, so both are captured.
 */
async function hydrateServerMarkup(tree: React.ReactElement) {
  const html = renderToString(tree);

  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);

  const recoverable: string[] = [];
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

  let root!: Root;
  await act(async () => {
    root = hydrateRoot(container, tree, {
      onRecoverableError: (err) => recoverable.push(String(err)),
    });
  });

  const consoleErrors = consoleError.mock.calls.map((args) => args.map(String).join(" "));
  consoleError.mockRestore();
  mounted.push({ root, container });

  return { html, container, recoverable, consoleErrors };
}

const hydrationComplaints = (messages: string[]) =>
  messages.filter((m) => /hydrat|did not match|server.rendered/i.test(m));

describe("Providers — SSR of the invite landing pages (#398)", () => {
  it("server-renders AgentSignupPage inside Providers without throwing", () => {
    let html = "";
    expect(() => {
      html = renderToString(
        <Providers>
          <AgentSignupPage />
        </Providers>,
      );
    }).not.toThrow();

    // Real server HTML, not an empty shell — the whole point is that these
    // routes get SSR back.
    expect(html).toContain("min-h-screen");
  });

  it("server-renders InvitePage inside Providers without throwing", () => {
    let html = "";
    expect(() => {
      html = renderToString(
        <Providers>
          <InvitePage />
        </Providers>,
      );
    }).not.toThrow();

    expect(html).toContain("min-h-screen");
  });
});

describe("Providers — hydration contract (#102 must stay fixed)", () => {
  it("hydrates its server markup with no mismatch, mounting the client-only stack only after", async () => {
    const tree = (
      <Providers>
        <p data-testid="app-child">app-root</p>
      </Providers>
    );

    const { html, container, recoverable, consoleErrors } = await hydrateServerMarkup(tree);

    // The client-only stack must not be in the server render — that divergence
    // between server and first client render IS issue #102.
    expect(html).not.toContain(AUTH0_MARKER);
    expect(recoverable).toEqual([]);
    expect(hydrationComplaints(consoleErrors)).toEqual([]);

    // …and it is there once effects have run, so the gate still swaps the real
    // providers in rather than dropping them.
    expect(container.querySelector(`[data-testid="${AUTH0_MARKER}"]`)).not.toBeNull();
    expect(container.textContent).toContain("app-root");
  });

  it("hydrates the agent-signup route's server markup with no mismatch", async () => {
    const tree = (
      <Providers>
        <AgentSignupPage />
      </Providers>
    );

    const { html, recoverable, consoleErrors } = await hydrateServerMarkup(tree);

    expect(html).not.toContain(AUTH0_MARKER);
    expect(recoverable).toEqual([]);
    expect(hydrationComplaints(consoleErrors)).toEqual([]);
  });

  it("hydrates the client-invite route's server markup with no mismatch", async () => {
    const tree = (
      <Providers>
        <InvitePage />
      </Providers>
    );

    const { html, recoverable, consoleErrors } = await hydrateServerMarkup(tree);

    expect(html).not.toContain(AUTH0_MARKER);
    expect(recoverable).toEqual([]);
    expect(hydrationComplaints(consoleErrors)).toEqual([]);
  });
});
