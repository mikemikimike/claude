// @vitest-environment happy-dom
/**
 * In E2E mode Providers renders NO Auth0Provider (Playwright seeds a session
 * cookie instead). useAuth0() outside the provider is safe to CALL, but every
 * function on the context it returns throws — so the logout hook must not reach
 * for Auth0 there.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { stubLocalStorage } from "../helpers/local-storage";

// Default behaviour mirrors the real library outside a provider: the context
// is returned fine, but calling anything on it throws.
const logout = vi.fn<(opts?: unknown) => void>(() => {
  throw new Error("You forgot to wrap your component in <Auth0Provider>.");
});
vi.mock("@auth0/auth0-react", () => ({
  useAuth0: () => ({ logout }),
}));

const localStore = stubLocalStorage();
const assign = vi.fn();

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  logout.mockClear();
  assign.mockClear();
  localStore.reset();
});

/** The hook reads NEXT_PUBLIC_E2E_AUTH at module scope, so import it fresh. */
async function loadHook() {
  const mod = await import("@/hooks/useLogout");
  return mod.useLogout;
}

describe("useLogout — E2E guard", () => {
  it("clears the seeded session cookie and never calls Auth0", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTH", "1");
    vi.stubGlobal("location", { origin: "http://localhost:3100", assign });

    const useLogout = await loadHook();
    const { result } = renderHook(() => useLogout());
    act(() => result.current());

    expect(logout).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("rtf_e2e_session=seeded");
    expect(assign).toHaveBeenCalledWith("http://localhost:3100");
  });

  it("uses the real Auth0 logout when not in E2E mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTH", "");
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign });
    logout.mockImplementationOnce(() => undefined);

    const useLogout = await loadHook();
    const { result } = renderHook(() => useLogout());
    act(() => result.current());

    expect(logout).toHaveBeenCalledWith({
      logoutParams: { returnTo: "http://localhost:3000" },
    });
  });

  // If Auth0 throws (misconfigured provider, blocked redirect) the user must
  // still end up signed out and off the page, not stranded on a dead screen.
  it("falls back to a plain navigation when Auth0 logout throws", async () => {
    vi.stubEnv("NEXT_PUBLIC_E2E_AUTH", "");
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign });
    localStorage.setItem("pendingInvite", "tok");

    const useLogout = await loadHook();
    const { result } = renderHook(() => useLogout());
    act(() => result.current());

    expect(logout).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith("http://localhost:3000");
    // Local teardown happens before the redirect, so it survives the throw.
    expect(localStorage.getItem("pendingInvite")).toBeNull();
  });
});
