import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
  GET as getVerificationRoute,
  POST as postVerificationRoute,
} from "@/app/api/auth/verification/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setAuth0ForTesting, type Auth0Client } from "@/lib/auth0";
import { authHeader, getTestSigner } from "../helpers/jwt";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

afterEach(() => {
  setAuth0ForTesting(undefined);
});

// A fake Auth0 client recording Management-API calls. Injected via the
// setAuth0ForTesting seam — never hits real Auth0 (CI has no secrets).
function fakeAuth0(opts?: {
  emailVerified?: boolean;
  managementEnabled?: boolean;
  getUserError?: Error;
  sendError?: Error;
}) {
  const getUserCalls: string[] = [];
  const sendCalls: string[] = [];
  const client: Auth0Client = {
    managementEnabled: () => opts?.managementEnabled ?? true,
    sendPasswordResetEmail: async () => {
      throw new Error("sendPasswordResetEmail must not be called by verification");
    },
    getUser: async (auth0UserId) => {
      getUserCalls.push(auth0UserId);
      if (opts?.getUserError) throw opts.getUserError;
      return { email_verified: opts?.emailVerified ?? false };
    },
    sendVerificationEmail: async (auth0UserId) => {
      sendCalls.push(auth0UserId);
      if (opts?.sendError) throw opts.sendError;
    },
  };
  return { client, getUserCalls, sendCalls };
}

async function getVerification(auth?: string): Promise<Response> {
  return getVerificationRoute(
    new Request("http://localhost/api/auth/verification", {
      headers: auth ? { authorization: auth } : {},
    })
  );
}

async function postVerification(auth?: string, body?: unknown): Promise<Response> {
  return postVerificationRoute(
    new Request("http://localhost/api/auth/verification", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: auth } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  );
}

describe("GET /api/auth/verification", () => {
  it("returns { email_verified: false } for an unverified caller (Management getUser)", async () => {
    const { client, getUserCalls } = fakeAuth0({ emailVerified: false });
    setAuth0ForTesting(client);

    const res = await getVerification(await authHeader("auth0|unverified", ["agent"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_verified: false });
    // Looked up the CALLER's auth0 user id, nothing else.
    expect(getUserCalls).toEqual(["auth0|unverified"]);
  });

  it("returns { email_verified: true } for a verified caller", async () => {
    const { client } = fakeAuth0({ emailVerified: true });
    setAuth0ForTesting(client);

    const res = await getVerification(await authHeader("auth0|verified", ["agent"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_verified: true });
  });

  // #405 — this used to answer `true` when it had checked nothing. The prod M2M
  // credentials were empty strings for months, so every account reported
  // verified and no caller could tell a verified address from an unverified
  // one. `null` says "undeterminable" so a caller that GATES on verification
  // can fail closed; the banner still stays quiet (it only shows on `false`).
  it("reports email_verified: null when the Management API is not configured", async () => {
    const { client, getUserCalls } = fakeAuth0({ managementEnabled: false });
    setAuth0ForTesting(client);

    const res = await getVerification(await authHeader("auth0|anyone", ["agent"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email_verified: null });
    // Never asserts verified without asking Auth0 — and never asks when it can't.
    expect(getUserCalls).toHaveLength(0);
  });

  it("502 when the Management API fails", async () => {
    const { client } = fakeAuth0({ getUserError: new Error("auth0 mgmt: 500") });
    setAuth0ForTesting(client);

    const res = await getVerification(await authHeader("auth0|x", ["agent"]));

    expect(res.status).toBe(502);
  });

  it("401 without a token", async () => {
    const { client } = fakeAuth0();
    setAuth0ForTesting(client);

    const res = await getVerification();

    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/verification", () => {
  it("sends a verification email to the CALLER exactly once and returns { ok: true }", async () => {
    const { client, sendCalls } = fakeAuth0({ emailVerified: false });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|caller", ["agent"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendCalls).toEqual(["auth0|caller"]);
  });

  it("ignores any user_id in the body — always targets the caller's sub", async () => {
    const { client, sendCalls, getUserCalls } = fakeAuth0({ emailVerified: false });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|caller", ["agent"]), {
      user_id: "auth0|victim",
    });

    expect(res.status).toBe(200);
    expect(getUserCalls).toEqual(["auth0|caller"]);
    expect(sendCalls).toEqual(["auth0|caller"]);
  });

  it("already verified → { ok: true, already_verified: true } and NO email is sent", async () => {
    const { client, sendCalls } = fakeAuth0({ emailVerified: true });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|done", ["agent"]));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, already_verified: true });
    expect(sendCalls).toHaveLength(0);
  });

  it("502 with a friendly message when the Management API fails on send", async () => {
    const { client } = fakeAuth0({
      emailVerified: false,
      sendError: new Error("auth0 mgmt: 503"),
    });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|x", ["agent"]));

    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/verification email/i);
  });

  it("502 when the Management API fails on the verified-state lookup", async () => {
    const { client, sendCalls } = fakeAuth0({ getUserError: new Error("boom") });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|x", ["agent"]));

    expect(res.status).toBe(502);
    expect(sendCalls).toHaveLength(0);
  });

  it("503 when the Management API is not configured", async () => {
    const { client, sendCalls } = fakeAuth0({ managementEnabled: false });
    setAuth0ForTesting(client);

    const res = await postVerification(await authHeader("auth0|x", ["agent"]));

    expect(res.status).toBe(503);
    expect(sendCalls).toHaveLength(0);
  });

  it("401 without a token", async () => {
    const { client, sendCalls } = fakeAuth0();
    setAuth0ForTesting(client);

    const res = await postVerification();

    expect(res.status).toBe(401);
    expect(sendCalls).toHaveLength(0);
  });
});
