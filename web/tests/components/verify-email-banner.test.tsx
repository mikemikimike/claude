// @vitest-environment happy-dom
/**
 * Issue #405 — GET /api/auth/verification used to answer `email_verified: true`
 * whenever it COULDN'T check (Management API unconfigured). The prod M2M
 * credentials were empty strings for months, so the app asserted every account
 * was verified without ever asking Auth0.
 *
 * It now answers `null` = undeterminable. These cover the client half:
 *  - `null` must stay quiet (identical UI to before — the banner is for `false`),
 *  - but must still FILL the per-tab cache, or the guard in the effect reads
 *    every unknown as a cache miss and re-requests on every navigation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

vi.mock("@/lib/api-client", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  setTokenGetter: vi.fn(),
}));

import { render, screen, waitFor } from "@testing-library/react";
import VerifyEmailBanner, {
  resetVerifyEmailBannerCache,
} from "@/components/VerifyEmailBanner";
import { useAuthStore } from "@/lib/store/authStore";
import { api } from "@/lib/api-client";

const mockGet = vi.mocked(api.get);

beforeEach(() => {
  vi.clearAllMocks();
  // The cache is module-level and deliberately survives remounts — clear it so
  // each case starts from "not fetched yet".
  resetVerifyEmailBannerCache();
  useAuthStore.setState({ activeUser: undefined, isLoaded: false, syncError: null });
  useAuthStore
    .getState()
    .setFromAuth0("u-1", "Chad Harris", "chad@example.com", "agent", true);
  useAuthStore.setState({ isLoaded: true });
});

describe("VerifyEmailBanner — undeterminable verification (#405)", () => {
  it("stays quiet when the server can't determine the state", async () => {
    mockGet.mockResolvedValue({ email_verified: null });

    render(<VerifyEmailBanner />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    // Same visible outcome as the old `true` — no nagging about an unchecked state.
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });

  it("caches the unknown answer instead of re-requesting on every remount", async () => {
    mockGet.mockResolvedValue({ email_verified: null });

    const first = render(<VerifyEmailBanner />);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<VerifyEmailBanner />);

    // The regression this guards: if "unknown" were stored as the cache's
    // not-fetched-yet sentinel, every client-side navigation would hit the
    // Management API again.
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it("still shows the banner when the server says the email is NOT verified", async () => {
    mockGet.mockResolvedValue({ email_verified: false });

    render(<VerifyEmailBanner />);

    expect(
      await screen.findByText(/Verify your email/i)
    ).toBeInTheDocument();
  });

  it("treats a failed lookup as unknown, not verified — and stays quiet", async () => {
    mockGet.mockRejectedValue(new Error("network"));

    render(<VerifyEmailBanner />);

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Verify your email/i)).toBeNull();
  });
});
