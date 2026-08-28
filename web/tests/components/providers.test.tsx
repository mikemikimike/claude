// @vitest-environment happy-dom
/**
 * Regression test for issue #102 — hydration mismatch on the root page.
 *
 * Providers gates its entire client-only stack (Auth0Provider etc.) behind a
 * post-mount flag, so the server render and the first client render both emit
 * just `children`. The previous code read `window.location.origin` in a
 * useState initializer, so the client's first render injected a subtree the
 * server never produced — a hydration mismatch.
 *
 * A server render (no effects run → mount flag stays false) must therefore
 * contain the children and nothing else. The buggy version read `window`
 * (defined under happy-dom), rendered the full client-only stack here, and
 * would either leak provider markup or throw reaching useRouter — so this
 * test fails on the regression and passes on the fix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Capture what Providers hands Auth0Provider. The real one phones the tenant on
// mount, which CI has no secrets for and this file has no interest in — the
// question here is what props the wiring passes, not what Auth0 does with them.
type CapturedAuth0Props = {
  children?: React.ReactNode;
  onRedirectCallback?: (appState?: unknown) => void;
};
const auth0Props: CapturedAuth0Props[] = [];
vi.mock("@auth0/auth0-react", async () => {
  const { createElement } = await import("react");
  return {
    Auth0Provider: (props: CapturedAuth0Props) => {
      auth0Props.push(props);
      return createElement("div", { "data-testid": "auth0" }, props.children);
    },
    useAuth0: () => ({
      isAuthenticated: false,
      isLoading: false,
      user: undefined,
      logout: vi.fn(),
      getAccessTokenSilently: vi.fn(),
    }),
  };
});

const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn(), back: vi.fn() }),
}));

import { render, cleanup, act } from "@testing-library/react";
import { Providers, resolveReturnTo } from "@/components/Providers";

describe("Providers (issue #102 — no client-only stack on the server render)", () => {
  it("server-renders only the children", () => {
    const html = renderToStaticMarkup(
      <Providers>
        <p>app-root</p>
      </Providers>,
    );
    // Children only — any extra markup means the client-only provider stack
    // rendered on the server, which diverges from the first client render.
    expect(html).toBe("<p>app-root</p>");
  });
});

/**
 * #425 — every loginWithRedirect() in the app passed `appState: { returnTo }`,
 * but Auth0Provider had no `onRedirectCallback`, so the library's default ran
 * and returnTo was silently discarded: everyone came back to `/` no matter what
 * they asked for. resolveReturnTo is the half of the fix that decides where a
 * returning user is sent, kept pure so the rules are testable directly.
 */
describe("resolveReturnTo (#425)", () => {
  it("honours a relative in-app path", () => {
    expect(resolveReturnTo({ returnTo: "/onboard/buyer" })).toBe("/onboard/buyer");
    expect(resolveReturnTo({ returnTo: "/onboard/seller" })).toBe("/onboard/seller");
  });

  it("falls back to '/' when no returnTo was supplied", () => {
    expect(resolveReturnTo(undefined)).toBe("/");
    expect(resolveReturnTo({})).toBe("/");
    expect(resolveReturnTo({ returnTo: 42 })).toBe("/");
  });

  it("refuses anything that could leave the app (open-redirect guard)", () => {
    expect(resolveReturnTo({ returnTo: "https://evil.example.com/x" })).toBe("/");
    expect(resolveReturnTo({ returnTo: "//evil.example.com/x" })).toBe("/");
    expect(resolveReturnTo({ returnTo: "javascript:alert(1)" })).toBe("/");
    expect(resolveReturnTo({ returnTo: "onboard/buyer" })).toBe("/");
  });
});

/**
 * The WIRING, not just the pure rule. `onRedirectCallback` REPLACES
 * auth0-react's default for every login in the app — agent signup, TC invite,
 * plain returning-user login, every role — so if it misbehaves nobody gets in.
 * The full Auth0 round-trip is UAT-only, but the callback the library will
 * invoke is an ordinary function, and this pins down what it does.
 */
describe("Providers — onRedirectCallback wiring (#425)", () => {
  /** Mount Providers past its client gate and return the callback Auth0 gets. */
  async function mountAndGetCallback() {
    await act(async () => {
      render(
        <Providers>
          <p>app-root</p>
        </Providers>,
      );
    });
    const props = auth0Props.at(-1);
    expect(props, "Auth0Provider was never rendered").toBeDefined();
    const cb = props!.onRedirectCallback;
    expect(typeof cb, "Auth0Provider got no onRedirectCallback").toBe("function");
    return cb!;
  }

  beforeEach(() => {
    auth0Props.length = 0;
    routerReplace.mockClear();
    // The library only invokes the callback after a code exchange, so the URL
    // still carries Auth0's ?code=&state= at that moment.
    window.history.replaceState({}, "", "/?code=abc123&state=xyz789");
  });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("navigates to the appState's returnTo", async () => {
    const onRedirectCallback = await mountAndGetCallback();

    onRedirectCallback({ returnTo: "/onboard/buyer" });

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith("/onboard/buyer");
  });

  it("falls back to '/' when Auth0 returns no appState — the pre-#425 behaviour", async () => {
    const onRedirectCallback = await mountAndGetCallback();

    onRedirectCallback(undefined);

    expect(routerReplace).toHaveBeenCalledWith("/");
  });

  it("never navigates off-origin, even if appState says so", async () => {
    const onRedirectCallback = await mountAndGetCallback();

    onRedirectCallback({ returnTo: "https://evil.example.com/steal" });

    expect(routerReplace).toHaveBeenCalledWith("/");
  });

  it("strips Auth0's ?code=&state= either way", async () => {
    // The library's DEFAULT callback existed to do exactly this — overriding it
    // means we own the cleanup. A leftover `code` is a one-time credential that
    // errors if the page is reloaded with it still in the URL.
    const onRedirectCallback = await mountAndGetCallback();

    onRedirectCallback({ returnTo: "/onboard/seller" });
    onRedirectCallback(undefined);

    for (const [target] of routerReplace.mock.calls) {
      expect(target).not.toContain("code=");
      expect(target).not.toContain("state=");
      expect(target).not.toContain("?");
    }
    expect(routerReplace.mock.calls.map(([t]) => t)).toEqual(["/onboard/seller", "/"]);
  });
});
