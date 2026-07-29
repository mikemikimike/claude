import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { POST as syncRoute } from "@/app/api/users/sync/route";
import { GET as listRoute } from "@/app/api/users/route";
import { PATCH as activateRoute } from "@/app/api/users/[id]/activate/route";
import { PATCH as deactivateRoute } from "@/app/api/users/[id]/deactivate/route";
import { GET as listDealsRoute } from "@/app/api/deals/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { isEmailUniqueViolation } from "@/lib/users";
import { ROLES, isValidRole, resolveRole } from "@/lib/roles";
import { prisma } from "@/lib/db";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createDeal, createUser } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
});

function makeRequest(
  url: string,
  init: RequestInit & { auth?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.auth) headers.set("authorization", init.auth);
  return new Request(url, { ...init, headers });
}

async function syncBody(body: unknown): Promise<Request> {
  return new Request("http://localhost/api/users/sync", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader("auth0|new-agent", ["agent"]),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/users/sync", () => {
  it("returns 401 without an Authorization header", async () => {
    const req = makeRequest("http://localhost/api/users/sync", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.co", name: "A" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|x", ["agent"]),
      },
      body: "not json{",
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(400);
  });

  it("creates a new user from JWT role + body", async () => {
    const req = await syncBody({ email: "agent@example.com", name: "Agent Smith" });
    const res = await syncRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string; name: string; role: string };
    expect(body.email).toBe("agent@example.com");
    expect(body.name).toBe("Agent Smith");
    expect(body.role).toBe("agent");
  });

  it("preserves an existing manually-edited name on re-sync", async () => {
    // First sync writes Auth0-supplied name.
    await syncRoute(await syncBody({ email: "u@example.com", name: "Initial" }));
    // Agent edits their name in onboarding — simulate by updating directly.
    await prisma.users.update({
      where: { auth0_id: "auth0|new-agent" },
      data: { name: "Manually Edited" },
    });
    // Second sync (Auth0 sends a different name — e.g. email) must NOT clobber.
    const req2 = await syncBody({ email: "u@example.com", name: "u@example.com" });
    const res2 = await syncRoute(req2);
    expect(res2.status).toBe(200);
    const body = (await res2.json()) as { name: string };
    expect(body.name).toBe("Manually Edited");
  });

  it("returns 403 when JWT has no role and no pre-existing user", async () => {
    const { signToken } = await getTestSigner();
    const token = await signToken({ sub: "auth0|no-role" }); // no roles claim
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "x@y.co", name: "X" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(403);
  });

  it("falls back to persisted role when JWT has no roles claim", async () => {
    await createUser({
      auth0_id: "auth0|invited",
      email: "inv@example.com",
      name: "",
      role: "agent",
    });
    const { signToken } = await getTestSigner();
    const token = await signToken({ sub: "auth0|invited" });
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: "inv@example.com", name: "Invited User" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string; name: string };
    expect(body.role).toBe("agent");
    expect(body.name).toBe("Invited User");
  });

  // #277 — a second Auth0 identity presenting an already-used email must get a
  // clean, recoverable 409, not the opaque 500 the raw unique violation caused.
  it("returns 409 when a new sub presents an email already used by another user", async () => {
    // An existing account already owns dup@example.com under a different sub.
    await createUser({
      auth0_id: "auth0|original-owner",
      email: "dup@example.com",
      name: "Original Owner",
      role: "agent",
    });
    // syncBody authenticates as auth0|new-agent — a brand-new Auth0 identity —
    // and tries to claim the same email.
    const res = await syncRoute(
      await syncBody({ email: "dup@example.com", name: "Impostor" })
    );
    expect(res.status).toBe(409);
    const text = (await res.text()).toLowerCase();
    expect(text).toContain("already exists");
  });

  // #277 Case 2 (unchanged happy path): a new sub + a fresh email still creates.
  it("creates the user when both the sub and the email are new", async () => {
    const res = await syncRoute(
      await syncBody({ email: "fresh@example.com", name: "Fresh Agent" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { email: string };
    expect(body.email).toBe("fresh@example.com");
  });

  // #277 Case 3 (regression): re-syncing the SAME sub with its own email must
  // update, never 409 — ON CONFLICT (auth0_id) owns that row's email, so the
  // email-unique guard must not fire on a legitimate re-sync.
  it("re-syncs an existing sub with its own email without a collision", async () => {
    const first = await syncRoute(
      await syncBody({ email: "keep@example.com", name: "Keeper" })
    );
    expect(first.status).toBe(200);
    const second = await syncRoute(
      await syncBody({ email: "keep@example.com", name: "Keeper Renamed" })
    );
    expect(second.status).toBe(200);
  });

  // #308 — a roles claim carrying only an unrecognized value must fail loudly
  // with a 400. Before the whitelist check, the bad string was cast straight to
  // Role and only rejected by the user_role enum inside upsertUser, surfacing as
  // an opaque 500.
  it("returns 400 when the JWT role claim is not a recognized role", async () => {
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|bad-role", ["not_a_real_role"]),
      },
      body: JSON.stringify({ email: "bad@example.com", name: "Bad Role" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(400);
    const text = (await res.text()).toLowerCase();
    expect(text).toContain("role");
    // Nothing should have been written for the rejected claim.
    const row = await prisma.users.findUnique({
      where: { auth0_id: "auth0|bad-role" },
    });
    expect(row).toBeNull();
  });

  // #308 Case 2 — a single recognized role (other than the default agent) still
  // upserts unchanged. Guards against the whitelist over-rejecting.
  it("upserts normally for a valid single non-default role (tc)", async () => {
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|tc-user", ["tc"]),
      },
      body: JSON.stringify({ email: "tc@example.com", name: "Terry Coordinator" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("tc");
  });

  // #308 Case 3 — a claim with multiple recognized roles resolves to the single
  // most-privileged one (documented precedence: admin > tc > agent >
  // lending_partner > seller > buyer). Array order must NOT decide it — before
  // the fix this was silent first-wins ("buyer").
  it("resolves a multi-role claim to the most-privileged role", async () => {
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // buyer listed first, admin last — precedence, not array order, wins.
        authorization: await authHeader("auth0|multi", ["buyer", "agent", "admin"]),
      },
      body: JSON.stringify({ email: "multi@example.com", name: "Multi Role" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("admin");
  });

  // #308 — an unrecognized entry alongside a valid one is ignored, not fatal:
  // the recognized role still wins. The 400 fires only when NOTHING is
  // recognized (see the bad-role case above).
  it("ignores an unrecognized role when a valid one is also present", async () => {
    const req = new Request("http://localhost/api/users/sync", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|mixed", ["not_a_real_role", "seller"]),
      },
      body: JSON.stringify({ email: "mixed@example.com", name: "Mixed" }),
    });
    const res = await syncRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe("seller");
  });
});

/**
 * The invited-client-becomes-an-agent bug. The Auth0 tenant hands every new
 * signup a default `agent` roles claim (self-serve agent signup is intentional).
 * /users/sync used to let that claim win unconditionally, so the `buyer` the
 * invite claim had just written was overwritten on the very next sync and the
 * client was dropped into agent onboarding. Precedence now lives in
 * lib/roles.ts#decideRole; these cases pin it at the route level.
 */
describe("POST /api/users/sync — role precedence", () => {
  async function syncAs(
    sub: string,
    roles: string[],
    body: { email: string; name: string }
  ): Promise<Response> {
    return syncRoute(
      new Request("http://localhost/api/users/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader(sub, roles),
        },
        body: JSON.stringify(body),
      })
    );
  }

  /** An unclaimed, unexpired invite addressed to `email`. */
  async function seedOpenInvite(
    email: string,
    role: "buyer" | "seller",
    opts: { claimed?: boolean; expired?: boolean } = {}
  ): Promise<void> {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email,
        name: "Invited Client",
        role,
        invited_by: agent.id,
        claimed_at: opts.claimed ? new Date() : null,
        expires_at: new Date(
          Date.now() + (opts.expired ? -1 : 7 * 24 * 60 * 60) * 1000
        ),
      },
    });
  }

  it("a default agent claim does not overwrite a persisted buyer role", async () => {
    await createUser({
      auth0_id: "auth0|client",
      email: "client@example.com",
      name: "Client",
      role: "buyer",
    });
    const res = await syncAs("auth0|client", ["agent"], {
      email: "client@example.com",
      name: "Client",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("buyer");
  });

  it("a default agent claim does not overwrite a persisted seller role", async () => {
    await createUser({
      auth0_id: "auth0|seller",
      email: "seller@example.com",
      name: "Seller",
      role: "seller",
    });
    const res = await syncAs("auth0|seller", ["agent"], {
      email: "seller@example.com",
      name: "Seller",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("seller");
  });

  // The documented promotion path (CLAUDE.md): assign the role in Auth0 RBAC,
  // log out, log back in. Must keep working.
  it("an explicit admin claim still promotes an existing agent", async () => {
    await createUser({
      auth0_id: "auth0|promoted",
      email: "promoted@example.com",
      name: "Promoted",
      role: "agent",
    });
    const res = await syncAs("auth0|promoted", ["admin"], {
      email: "promoted@example.com",
      name: "Promoted",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });

  it("an explicit admin claim wins over a persisted buyer role", async () => {
    await createUser({
      auth0_id: "auth0|client-admin",
      email: "client-admin@example.com",
      name: "Client Admin",
      role: "buyer",
    });
    const res = await syncAs("auth0|client-admin", ["admin"], {
      email: "client-admin@example.com",
      name: "Client Admin",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("admin");
  });

  it("a tc claim wins over a persisted agent role", async () => {
    await createUser({
      auth0_id: "auth0|to-tc",
      email: "to-tc@example.com",
      name: "To TC",
      role: "agent",
    });
    const res = await syncAs("auth0|to-tc", ["tc"], {
      email: "to-tc@example.com",
      name: "To TC",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("tc");
  });

  // decideRole rule 3 — the safety net for when the invite-claim POST never ran
  // (different device, transient failure, localStorage cleared).
  it("an open buyer invite beats a default agent claim for a brand-new user", async () => {
    await seedOpenInvite("fresh-buyer@example.com", "buyer");
    const res = await syncAs("auth0|fresh-buyer", ["agent"], {
      email: "fresh-buyer@example.com",
      name: "Fresh Buyer",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("buyer");
  });

  it("matches the invited email case-insensitively", async () => {
    await seedOpenInvite("Mixed.Case@Example.com", "seller");
    const res = await syncAs("auth0|mixed-case", ["agent"], {
      email: "mixed.case@example.com",
      name: "Mixed Case",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("seller");
  });

  it("a claimed invite does not override the agent claim", async () => {
    await seedOpenInvite("used@example.com", "buyer", { claimed: true });
    const res = await syncAs("auth0|used", ["agent"], {
      email: "used@example.com",
      name: "Used",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("agent");
  });

  it("an expired invite does not override the agent claim", async () => {
    await seedOpenInvite("stale@example.com", "buyer", { expired: true });
    const res = await syncAs("auth0|stale", ["agent"], {
      email: "stale@example.com",
      name: "Stale",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("agent");
  });

  // Rule 3 is gated on "no users row" so an agent who happens to hold a client
  // invite for their own email is never demoted (cf. #174).
  it("an open buyer invite does not demote an established agent", async () => {
    await createUser({
      auth0_id: "auth0|agent-with-invite",
      email: "agent-invite@example.com",
      name: "Agent With Invite",
      role: "agent",
    });
    await seedOpenInvite("agent-invite@example.com", "buyer");
    const res = await syncAs("auth0|agent-with-invite", ["agent"], {
      email: "agent-invite@example.com",
      name: "Agent With Invite",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("agent");
  });

  // Self-serve agent signup with no invite is intentional — must not regress.
  it("a brand-new signup with no invite still becomes an agent", async () => {
    const res = await syncAs("auth0|self-serve", ["agent"], {
      email: "self-serve@example.com",
      name: "Self Serve",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe("agent");
  });

  // #173 — the deactivation guard moved from getPersistedRole into
  // resolveSyncRole and must still fire.
  it("still returns 403 for a deactivated user", async () => {
    const user = await createUser({
      auth0_id: "auth0|gone",
      email: "gone@example.com",
      name: "Gone",
      role: "agent",
    });
    await prisma.users.update({
      where: { id: user.id },
      data: { deactivated_at: new Date() },
    });
    const res = await syncAs("auth0|gone", ["agent"], {
      email: "gone@example.com",
      name: "Gone",
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/users", () => {
  it("returns 401 without auth", async () => {
    const res = await listRoute(new Request("http://localhost/api/users"));
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const req = new Request("http://localhost/api/users", {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listRoute(req);
    expect(res.status).toBe(403);
  });

  it("returns all users ordered by role (enum order) then name for admin", async () => {
    await createUser({ name: "Zelda Admin", role: "admin" });
    await createUser({ name: "Alice Agent", role: "agent" });
    await createUser({ name: "Bob Agent", role: "agent" });

    const req = new Request("http://localhost/api/users", {
      headers: { authorization: await authHeader("auth0|admin", ["admin"]) },
    });
    const res = await listRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; role: string }[];
    expect(body.length).toBe(3);
    // Postgres sorts enums by declaration order — `agent` is declared before
    // `admin` in the user_role enum, so agents come first, alphabetical by name.
    expect(body[0].name).toBe("Alice Agent");
    expect(body[0].role).toBe("agent");
    expect(body[1].name).toBe("Bob Agent");
    expect(body[1].role).toBe("agent");
    expect(body[2].name).toBe("Zelda Admin");
    expect(body[2].role).toBe("admin");
  });
});

describe("PATCH /api/users/[id]/activate", () => {
  async function call(id: string, roles: string[] = ["admin"]) {
    const req = new Request(`http://localhost/api/users/${id}/activate`, {
      method: "PATCH",
      headers: { authorization: await authHeader("auth0|admin", roles) },
    });
    return activateRoute(req, { params: Promise.resolve({ id }) });
  }

  it("returns 401 without auth", async () => {
    const req = new Request("http://localhost/api/users/abc/activate", {
      method: "PATCH",
    });
    const res = await activateRoute(req, { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const u = await createUser({ role: "agent" });
    const res = await call(u.id, ["agent"]);
    expect(res.status).toBe(403);
  });

  it("clears deactivated_at on the target user", async () => {
    const u = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: u.id },
      data: { deactivated_at: new Date() },
    });
    const res = await call(u.id);
    expect(res.status).toBe(200);
    const row = await prisma.users.findUnique({ where: { id: u.id } });
    expect(row?.deactivated_at).toBeNull();
  });

  it("returns 404 for unknown user id", async () => {
    const res = await call("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/users/[id]/deactivate", () => {
  async function call(id: string, roles: string[] = ["admin"]) {
    const req = new Request(`http://localhost/api/users/${id}/deactivate`, {
      method: "PATCH",
      headers: { authorization: await authHeader("auth0|admin", roles) },
    });
    return deactivateRoute(req, { params: Promise.resolve({ id }) });
  }

  it("returns 401 without auth", async () => {
    const req = new Request("http://localhost/api/users/abc/deactivate", {
      method: "PATCH",
    });
    const res = await deactivateRoute(req, { params: Promise.resolve({ id: "abc" }) });
    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin", async () => {
    const u = await createUser({ role: "agent" });
    const res = await call(u.id, ["agent"]);
    expect(res.status).toBe(403);
  });

  it("sets deactivated_at on the target user", async () => {
    const u = await createUser({ role: "agent" });
    const res = await call(u.id);
    expect(res.status).toBe(200);
    const row = await prisma.users.findUnique({ where: { id: u.id } });
    expect(row?.deactivated_at).not.toBeNull();
  });

  it("returns 404 if the user is already deactivated", async () => {
    const u = await createUser({ role: "agent" });
    await prisma.users.update({
      where: { id: u.id },
      data: { deactivated_at: new Date() },
    });
    const res = await call(u.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown user id", async () => {
    const res = await call("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("deactivated user enforcement (#173)", () => {
  async function deactivate(userId: string): Promise<void> {
    await prisma.users.update({
      where: { id: userId },
      data: { deactivated_at: new Date() },
    });
  }

  async function syncAs(auth: string): Promise<Response> {
    return syncRoute(
      new Request("http://localhost/api/users/sync", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ email: "who@example.com", name: "Who" }),
      })
    );
  }

  it("returns 403 on a protected route once the user is deactivated", async () => {
    const u = await createUser({ auth0_id: "auth0|fired-agent", role: "agent" });
    const auth = await authHeader("auth0|fired-agent", ["agent"]);

    // Sanity: while active, the agent can list deals.
    const before = await listDealsRoute(
      makeRequest("http://localhost/api/deals", { auth })
    );
    expect(before.status).toBe(200);

    await deactivate(u.id);

    const after = await listDealsRoute(
      makeRequest("http://localhost/api/deals", { auth })
    );
    expect(after.status).toBe(403);
  });

  it("returns 403 on /api/users/sync for a deactivated user", async () => {
    const u = await createUser({ auth0_id: "auth0|fired-sync", role: "agent" });
    await deactivate(u.id);
    const res = await syncAs(await authHeader("auth0|fired-sync", ["agent"]));
    expect(res.status).toBe(403);
  });

  it("returns 403 even on routes that never call resolveUserId (GET /api/users)", async () => {
    const admin = await createUser({ auth0_id: "auth0|fired-admin", role: "admin" });
    await deactivate(admin.id);
    const res = await listRoute(
      makeRequest("http://localhost/api/users", {
        auth: await authHeader("auth0|fired-admin", ["admin"]),
      })
    );
    expect(res.status).toBe(403);
  });

  it("restores access after reactivation", async () => {
    const u = await createUser({ auth0_id: "auth0|rehired", role: "agent" });
    await deactivate(u.id);
    const auth = await authHeader("auth0|rehired", ["agent"]);

    // Blocked while deactivated.
    const blocked = await listDealsRoute(
      makeRequest("http://localhost/api/deals", { auth })
    );
    expect(blocked.status).toBe(403);

    // Admin reactivates through the real route.
    const adminAuth = await authHeader("auth0|admin", ["admin"]);
    const actRes = await activateRoute(
      makeRequest(`http://localhost/api/users/${u.id}/activate`, {
        method: "PATCH",
        auth: adminAuth,
      }),
      { params: Promise.resolve({ id: u.id }) }
    );
    expect(actRes.status).toBe(200);

    // Access restored on sync and on a protected route.
    const syncRes = await syncAs(auth);
    expect(syncRes.status).toBe(200);
    const deals = await listDealsRoute(
      makeRequest("http://localhost/api/deals", { auth })
    );
    expect(deals.status).toBe(200);
  });

  it("leaves active users unaffected", async () => {
    await createUser({ auth0_id: "auth0|still-here", role: "agent" });
    const auth = await authHeader("auth0|still-here", ["agent"]);
    const deals = await listDealsRoute(
      makeRequest("http://localhost/api/deals", { auth })
    );
    expect(deals.status).toBe(200);
    const syncRes = await syncAs(auth);
    expect(syncRes.status).toBe(200);
  });
});

describe("GET /api/users — market + brokerage (admin)", () => {
  it("returns market and brokerage so admin can wire board/brokerage forms", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    void admin;
    const agent = await createUser({ role: "agent", auth0_id: "auth0|ag" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { market: "BALDWIN_GULF_COAST", brokerage: "RE/MAX" },
    });
    const res = await listRoute(
      makeRequest("http://localhost/api/users", {
        auth: await authHeader("auth0|admin", ["admin"]),
      })
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { id: string; market: string; brokerage: string }[];
    const row = rows.find((r) => r.id === agent.id);
    expect(row?.market).toBe("BALDWIN_GULF_COAST");
    expect(row?.brokerage).toBe("RE/MAX");
  });
});

// #277 — the collision detector is pure, so exercise every error shape it must
// recognize directly (the live DB only ever produces the P2010 branch below).
describe("isEmailUniqueViolation", () => {
  it("detects the real P2010 raw-query shape upsertUser throws", () => {
    const err = {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "23505",
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["email"] },
            originalMessage:
              'duplicate key value violates unique constraint "users_email_key"',
          },
        },
      },
      message:
        'Raw query failed. Code: `23505`. Message: `duplicate key value violates unique constraint "users_email_key"`',
    };
    expect(isEmailUniqueViolation(err)).toBe(true);
  });

  it("ignores a unique violation on a non-email field (e.g. auth0_id)", () => {
    const err = {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: {
            originalCode: "23505",
            kind: "UniqueConstraintViolation",
            constraint: { fields: ["auth0_id"] },
          },
        },
      },
    };
    expect(isEmailUniqueViolation(err)).toBe(false);
  });

  it("detects a model-style P2002 targeting email", () => {
    expect(isEmailUniqueViolation({ code: "P2002", meta: { target: ["email"] } })).toBe(true);
  });

  it("ignores a P2002 targeting a different field", () => {
    expect(
      isEmailUniqueViolation({ code: "P2002", meta: { target: ["auth0_id"] } })
    ).toBe(false);
  });

  it("detects a bare pg 23505 passthrough on the email constraint", () => {
    expect(isEmailUniqueViolation({ code: "23505", constraint: "users_email_key" })).toBe(true);
  });

  it("falls back to the message when the nested meta shape is absent", () => {
    const err = {
      code: "P2010",
      message:
        'Raw query failed. Code: `23505`. Message: `duplicate key value violates unique constraint "users_email_key"`',
    };
    expect(isEmailUniqueViolation(err)).toBe(true);
  });

  it("returns false for unrelated errors and non-objects", () => {
    expect(isEmailUniqueViolation(new Error("connection refused"))).toBe(false);
    expect(isEmailUniqueViolation({ code: "P2025" })).toBe(false);
    expect(isEmailUniqueViolation(null)).toBe(false);
    expect(isEmailUniqueViolation("boom")).toBe(false);
    expect(isEmailUniqueViolation(undefined)).toBe(false);
  });
});

// #308 — the role whitelist guard + multi-role precedence resolver are pure, so
// exercise them directly. This pins the contract independent of the route.
describe("isValidRole", () => {
  it("accepts every canonical role", () => {
    for (const r of ROLES) {
      expect(isValidRole(r)).toBe(true);
    }
  });

  it("rejects unknown strings, wrong case, and non-strings", () => {
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
    expect(isValidRole("Admin")).toBe(false); // case-sensitive
    expect(isValidRole("AGENT")).toBe(false);
    expect(isValidRole(null)).toBe(false);
    expect(isValidRole(undefined)).toBe(false);
    expect(isValidRole(123)).toBe(false);
    expect(isValidRole(["admin"])).toBe(false);
  });
});

describe("resolveRole (multi-role precedence)", () => {
  it("returns the sole role when the claim has exactly one valid role", () => {
    expect(resolveRole(["agent"])).toBe("agent");
    expect(resolveRole(["lending_partner"])).toBe("lending_partner");
    expect(resolveRole(["buyer"])).toBe("buyer");
  });

  // Coverage guard: every role in the source-of-truth list must be resolvable
  // on its own. Catches a future role added to ROLES but not to the precedence
  // list (which would make resolveRole silently 400 a legitimate token).
  it("resolves every canonical role to itself when alone", () => {
    for (const r of ROLES) {
      expect(resolveRole([r])).toBe(r);
    }
  });

  it("prefers the most-privileged role regardless of array order", () => {
    // Documented order: admin > tc > agent > lending_partner > seller > buyer.
    expect(resolveRole(["buyer", "admin"])).toBe("admin");
    expect(resolveRole(["admin", "buyer"])).toBe("admin");
    expect(resolveRole(["seller", "agent", "tc"])).toBe("tc");
    expect(resolveRole(["agent", "lending_partner"])).toBe("agent");
    expect(resolveRole(["buyer", "seller"])).toBe("seller");
  });

  it("ignores unrecognized entries when a valid role is present", () => {
    expect(resolveRole(["nonsense", "seller"])).toBe("seller");
    expect(resolveRole(["nonsense", "admin", "junk"])).toBe("admin");
  });

  it("returns null when no recognized role is present", () => {
    expect(resolveRole([])).toBeNull();
    expect(resolveRole(["nonsense"])).toBeNull();
    expect(resolveRole(["Admin", "AGENT"])).toBeNull(); // case-sensitive
  });
});
