import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  GET as getMlsRoute,
  PATCH as patchMlsRoute,
} from "@/app/api/me/mls/route";
import { GET as searchRoute } from "@/app/api/deals/[id]/listings/search/route";
import { GET as meDealsRoute } from "@/app/api/me/deals/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import {
  setSimplyretsForTesting,
  SimplyRetsAuthError,
  type SimplyRetsClient,
  type SearchParams,
} from "@/lib/simplyrets";
import {
  ENC_PREFIX,
  createFieldCrypto,
  parseFieldKey,
  setCryptoForTesting,
} from "@/lib/crypto";
import type { MLSListing } from "@/hooks/useMLS";
import { prisma } from "@/lib/db";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

// A fixed, deterministic field-encryption key so the crypto seam round-trips in
// tests without ever depending on a real FIELD_ENCRYPTION_KEY env var.
const TEST_FIELD_KEY_HEX =
  "2222222222222222222222222222222222222222222222222222222222222222";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

afterEach(() => {
  setSimplyretsForTesting(undefined);
  setCryptoForTesting(undefined);
});

beforeEach(async () => {
  await truncateAll();
  // Inject a deterministic crypto impl for the whole file — real AES-256-GCM
  // under a fixed test key (so stored creds are genuinely ciphertext, and the
  // read path genuinely decrypts).
  setCryptoForTesting(createFieldCrypto(parseFieldKey(TEST_FIELD_KEY_HEX)));
});

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const SAMPLE_LISTING: MLSListing = {
  mlsId: "mls-1",
  listPrice: 450000,
  address: { full: "123 Main St", city: "Austin", state: "TX", postalCode: "78701" },
  property: { bedrooms: 3, bathsFull: 2, area: 1800, subType: "SingleFamilyResidence" },
  photos: ["https://photos.test/1.jpg"],
  mls: { status: "Active", daysOnMarket: 7 },
  remarks: "Charming home.",
};

// A fake SimplyRETS client that records calls and returns canned listings. The
// route tests inject this so they never touch the real SimplyRETS API.
function fakeClient(opts?: {
  listings?: MLSListing[];
  throwErr?: Error;
  calls?: { key: string; secret: string; params: SearchParams }[];
}): SimplyRetsClient {
  return {
    search: async (key, secret, params) => {
      opts?.calls?.push({ key, secret, params });
      if (opts?.throwErr) throw opts.throwErr;
      return opts?.listings ?? [SAMPLE_LISTING];
    },
  };
}

describe("GET /api/me/mls", () => {
  it("connected=false before any creds, true after PATCH; never returns the secret", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    void agent;

    setSimplyretsForTesting(fakeClient());

    // Before: not connected.
    const before = await getMlsRoute(
      new Request("http://localhost/api/me/mls", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as Record<string, unknown>;
    expect(beforeBody).toEqual({ connected: false });
    expect(beforeBody).not.toHaveProperty("secret");
    expect(beforeBody).not.toHaveProperty("mls_secret");
    expect(beforeBody).not.toHaveProperty("key");

    // Save creds.
    const patch = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "k-123", secret: "s-456" }),
      })
    );
    expect(patch.status).toBe(200);

    // After: connected, still no secret exposed.
    const after = await getMlsRoute(
      new Request("http://localhost/api/me/mls", {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      })
    );
    const afterBody = (await after.json()) as Record<string, unknown>;
    expect(afterBody).toEqual({ connected: true });
    expect(afterBody).not.toHaveProperty("secret");
    expect(afterBody).not.toHaveProperty("mls_secret");
  });

  it("401 without a token", async () => {
    const res = await getMlsRoute(new Request("http://localhost/api/me/mls"));
    expect(res.status).toBe(401);
  });

  it("404 when the JWT subject has no DB user", async () => {
    setSimplyretsForTesting(fakeClient());
    const res = await getMlsRoute(
      new Request("http://localhost/api/me/mls", {
        headers: { authorization: await authHeader("auth0|ghost", ["agent"]) },
      })
    );
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/me/mls", () => {
  // Case 1 (#273): creds must be stored ENCRYPTED at rest — never plaintext.
  it("stores key + secret as ciphertext (enc:v1:...), NOT plaintext; returns { ok, connected:true }", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    setSimplyretsForTesting(fakeClient());

    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "real-key", secret: "real-secret" }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, connected: true });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true, mls_secret: true },
    });
    // The raw DB values are ciphertext, not the plaintext the agent sent.
    expect(row?.mls_key).not.toBe("real-key");
    expect(row?.mls_secret).not.toBe("real-secret");
    expect(row?.mls_key?.startsWith(ENC_PREFIX)).toBe(true);
    expect(row?.mls_secret?.startsWith(ENC_PREFIX)).toBe(true);

    // ...and they decrypt back to exactly what was sent.
    const crypto = createFieldCrypto(parseFieldKey(TEST_FIELD_KEY_HEX));
    expect(crypto.decryptField(row!.mls_key!)).toBe("real-key");
    expect(crypto.decryptField(row!.mls_secret!)).toBe("real-secret");
  });

  // Case 2 (#273): the round-trip — stored ciphertext is decrypted before it
  // reaches SimplyRETS, so the client authenticates with the ORIGINAL plaintext.
  it("round-trips: PATCH stores ciphertext, listing search hands SimplyRETS the decrypted plaintext creds", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });

    const calls: { key: string; secret: string; params: SearchParams }[] = [];
    setSimplyretsForTesting(fakeClient({ calls }));

    // Connect through the real PATCH path (validates + encrypts + stores).
    const patch = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "plain-key", secret: "plain-secret" }),
      })
    );
    expect(patch.status).toBe(200);

    // Sanity: the row is ciphertext at rest.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true },
    });
    expect(row?.mls_key?.startsWith(ENC_PREFIX)).toBe(true);

    const deal = await createDeal({ agent_id: agent.id });
    const searchRes = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(searchRes.status).toBe(200);

    // The last stub call (the listing search) received PLAINTEXT, not ciphertext.
    const searchCall = calls[calls.length - 1];
    expect(searchCall.key).toBe("plain-key");
    expect(searchCall.secret).toBe("plain-secret");
    expect(searchCall.key.startsWith(ENC_PREFIX)).toBe(false);
    expect(searchCall.secret.startsWith(ENC_PREFIX)).toBe(false);
  });

  // Case 3 (#273): legacy plaintext rows (written before encryption shipped, no
  // enc:v1: prefix) must remain readable — decrypt-on-read passes them through
  // unchanged, so listing search still authenticates with them.
  it("reads LEGACY PLAINTEXT rows transparently: listing search still uses them unchanged", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // Simulate a pre-encryption row: raw plaintext, no enc:v1: prefix.
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "legacy-key", mls_secret: "legacy-secret" },
    });
    const deal = await createDeal({ agent_id: agent.id });

    const calls: { key: string; secret: string; params: SearchParams }[] = [];
    setSimplyretsForTesting(fakeClient({ calls }));

    const res = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(res.status).toBe(200);
    // The legacy plaintext passed straight through the decrypt helper.
    expect(calls[0].key).toBe("legacy-key");
    expect(calls[0].secret).toBe("legacy-secret");
  });

  it("real 401 (SimplyRetsAuthError) → 400 invalid + nothing saved", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // A genuine auth rejection is a typed SimplyRetsAuthError (what the real
    // client throws on a 401) — this must still be reported as invalid creds.
    setSimplyretsForTesting(
      fakeClient({ throwErr: new SimplyRetsAuthError("invalid MLS credentials") })
    );

    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "bad", secret: "bad" }),
      })
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/invalid/i);

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true, mls_secret: true },
    });
    expect(row?.mls_key).toBeNull();
    expect(row?.mls_secret).toBeNull();
  });

  it("a transient outage (5xx/timeout) → 502 temporarily-unavailable, NOT 400 invalid (#309)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    void agent;
    // A 5xx / network / timeout surfaces as a generic (non-auth) Error. The
    // agent's credentials may be perfectly valid — they must not be told they
    // are wrong just because SimplyRETS is down.
    setSimplyretsForTesting(
      fakeClient({
        throwErr: new Error("simplyrets: 503 Service Unavailable"),
      })
    );

    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        // Valid-shaped credentials — the only problem is the outage.
        body: JSON.stringify({ key: "real-key", secret: "real-secret" }),
      })
    );

    // Distinct from the 400 invalid-credentials path.
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toMatch(/invalid/i);
    expect(text).toMatch(/unavailable|try again/i);
  });

  it("an outage does NOT clear or overwrite previously-saved creds (#309)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // Agent already has working creds on file.
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "old-key", mls_secret: "old-secret" },
    });

    // They try to update to new creds while SimplyRETS is having an outage.
    setSimplyretsForTesting(
      fakeClient({
        throwErr: new Error("simplyrets: 500 Internal Server Error"),
      })
    );

    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "new-key", secret: "new-secret" }),
      })
    );
    expect(res.status).toBe(502);

    // Prior saved state is untouched — not cleared, not overwritten.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true, mls_secret: true },
    });
    expect(row?.mls_key).toBe("old-key");
    expect(row?.mls_secret).toBe("old-secret");
  });

  it("empty key/secret disconnects: creds nulled, connected:false (no validation call)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    // Seed existing creds.
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "old-key", mls_secret: "old-secret" },
    });

    // A client that would throw if invoked — disconnect must NOT call it.
    setSimplyretsForTesting(
      fakeClient({ throwErr: new Error("should not be called") })
    );

    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ key: "", secret: "" }),
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, connected: false });

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true, mls_secret: true },
    });
    expect(row?.mls_key).toBeNull();
    expect(row?.mls_secret).toBeNull();
  });

  it("401 without a token", async () => {
    const res = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "k", secret: "s" }),
      })
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/deals/[id]/listings/search", () => {
  it("returns mapped MLSListing[] using the deal agent's creds + passed-through params", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "agent-key", mls_secret: "agent-secret" },
    });
    const deal = await createDeal({ agent_id: agent.id });

    const calls: { key: string; secret: string; params: SearchParams }[] = [];
    setSimplyretsForTesting(fakeClient({ calls }));

    const res = await searchRoute(
      new Request(
        `http://localhost/api/deals/${deal.id}/listings/search?minprice=300000&maxprice=600000&minbeds=3&cities=Austin&cities=Round%20Rock`,
        { headers: { authorization: await authHeader("auth0|a", ["agent"]) } }
      ),
      ctx(deal.id)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as MLSListing[];
    expect(body).toEqual([SAMPLE_LISTING]);

    // Used the deal agent's creds, not anyone else's.
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("agent-key");
    expect(calls[0].secret).toBe("agent-secret");
    // Query params passed through.
    expect(calls[0].params.minPrice).toBe(300000);
    expect(calls[0].params.maxPrice).toBe(600000);
    expect(calls[0].params.minBeds).toBe(3);
    expect(calls[0].params.cities).toEqual(["Austin", "Round Rock"]);
  });

  it("a participant (buyer) may search; the deal agent's creds are still used", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "agent-key", mls_secret: "agent-secret" },
    });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const calls: { key: string; secret: string; params: SearchParams }[] = [];
    setSimplyretsForTesting(fakeClient({ calls }));

    const res = await searchRoute(
      new Request(
        `http://localhost/api/deals/${deal.id}/listings/search`,
        { headers: { authorization: await authHeader("auth0|b", ["buyer"]) } }
      ),
      ctx(deal.id)
    );
    expect(res.status).toBe(200);
    expect(calls[0].key).toBe("agent-key");
  });

  it("503 when the deal agent has not connected MLS (Go handler behavior)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    setSimplyretsForTesting(fakeClient());

    const res = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(res.status).toBe(503);
  });

  it("502 when SimplyRETS errors", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "agent-key", mls_secret: "agent-secret" },
    });
    const deal = await createDeal({ agent_id: agent.id });
    setSimplyretsForTesting(
      fakeClient({ throwErr: new Error("simplyrets: 500 Internal Server Error") })
    );

    const res = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(res.status).toBe(502);
  });

  it("404 when caller has no access to the deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "agent-key", mls_secret: "agent-secret" },
    });
    const stranger = await createUser({ role: "agent", auth0_id: "auth0|s" });
    void stranger;
    const deal = await createDeal({ agent_id: agent.id });
    setSimplyretsForTesting(fakeClient());

    const res = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`, {
        headers: { authorization: await authHeader("auth0|s", ["agent"]) },
      }),
      ctx(deal.id)
    );
    expect(res.status).toBe(404);
  });

  it("401 without a token", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await searchRoute(
      new Request(`http://localhost/api/deals/${deal.id}/listings/search`),
      ctx(deal.id)
    );
    expect(res.status).toBe(401);
  });
});

/**
 * #428 — the buyer portal has to know whether its agent has MLS connected
 * BEFORE it offers a search form, so `GET /api/me/deals` carries the boolean.
 *
 * Two things are load-bearing and are asserted here:
 *
 *   1. It is a BOOLEAN, derived from `users.mls_key IS NOT NULL`. No key, no
 *      secret, no partial value, no ciphertext ever reaches the client — the
 *      creds are encrypted at rest (#273) and stay agent-side.
 *   2. The read inherits the endpoint's existing participant join, so a client
 *      only ever learns about THEIR OWN deal's agent.
 */
describe("GET /api/me/deals — agent MLS connection state (#428)", () => {
  async function myDeals(auth0Id: string, role: string): Promise<Response> {
    return meDealsRoute(
      new Request("http://localhost/api/me/deals", {
        headers: { authorization: await authHeader(auth0Id, [role]) },
      })
    );
  }

  it("reports agent_mls_connected=false when the deal's agent has no MLS key", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id, stage: "active_search" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await myDeals("auth0|b", "buyer");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_mls_connected).toBe(false);
  });

  it("reports agent_mls_connected=true once connected, and NEVER leaks a credential", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    setSimplyretsForTesting(fakeClient());

    // Connect through the real PATCH path so what is stored is genuine
    // AES-256-GCM ciphertext, not a hand-written placeholder string.
    const patch = await patchMlsRoute(
      new Request("http://localhost/api/me/mls", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({
          key: "super-secret-key",
          secret: "super-secret-secret",
        }),
      })
    );
    expect(patch.status).toBe(200);

    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id, stage: "active_search" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const res = await myDeals("auth0|b", "buyer");
    expect(res.status).toBe(200);
    const raw = await res.text();
    const rows = JSON.parse(raw) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_mls_connected).toBe(true);

    // No credential field, and — scanning the whole serialized body — neither
    // the plaintext the agent typed nor the ciphertext it is stored as.
    for (const field of [
      "mls_key",
      "mls_secret",
      "agent_mls_key",
      "agent_mls_secret",
    ]) {
      expect(rows[0]).not.toHaveProperty(field);
    }
    expect(raw).not.toContain("super-secret-key");
    expect(raw).not.toContain("super-secret-secret");
    expect(raw).not.toContain(ENC_PREFIX);

    // Belt and braces: the row really is ciphertext, so the absent ENC_PREFIX
    // above is proof the payload carries no encrypted value either.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { mls_key: true },
    });
    expect(row?.mls_key?.startsWith(ENC_PREFIX)).toBe(true);
  });

  it("scopes the read to the caller's own deals — a stranger learns nothing about that agent", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { mls_key: "agent-key", mls_secret: "agent-secret" },
    });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id, stage: "active_search" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    // A buyer who is a participant on nobody's deal.
    await createUser({ role: "buyer", auth0_id: "auth0|stranger" });
    const res = await myDeals("auth0|stranger", "buyer");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
