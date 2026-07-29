import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/admin/agent-invites/route";
import { DELETE as deleteRoute } from "@/app/api/admin/agent-invites/[inviteId]/route";
import { GET as getByTokenRoute } from "@/app/api/agent-invites/[token]/route";
import { POST as claimRoute } from "@/app/api/agent-invites/[token]/claim/route";
import { POST as syncRoute } from "@/app/api/users/sync/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
import { prisma } from "@/lib/db";
import { upsertUser } from "@/lib/users";
import type { Role } from "@/lib/roles";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  // Reset the seam so a stub from one test never leaks into the next.
  setEmailForTesting(undefined);
});

type SentEmail = {
  from: string;
  to: string | string[];
  subject: string;
  html: string;
};

/**
 * Minimal Resend-surface fake. Mirrors fakeEmail in invite-email.test.ts —
 * records every send, or throws to simulate a delivery failure. Never touches
 * the real Resend API.
 */
function fakeEmail(opts: { throwOnSend?: boolean } = {}) {
  const sent: SentEmail[] = [];
  const client = {
    emails: {
      send: async (payload: SentEmail) => {
        if (opts.throwOnSend) throw new Error("resend boom");
        sent.push(payload);
        return { data: { id: "email_test_1" }, error: null };
      },
    },
  };
  return { client, sent };
}

function tokenCtx(token: string) {
  return { params: Promise.resolve({ token }) };
}

function inviteIdCtx(inviteId: string) {
  return { params: Promise.resolve({ inviteId }) };
}

async function createReq(sub: string, roles: string[], body: unknown) {
  return new Request("http://localhost/api/admin/agent-invites", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(sub, roles),
    },
    body: JSON.stringify(body),
  });
}

async function listReq(sub: string, roles: string[]) {
  return new Request("http://localhost/api/admin/agent-invites", {
    method: "GET",
    headers: { authorization: await authHeader(sub, roles) },
  });
}

async function deleteReq(inviteId: string, sub: string, roles: string[]) {
  return new Request(`http://localhost/api/admin/agent-invites/${inviteId}`, {
    method: "DELETE",
    headers: { authorization: await authHeader(sub, roles) },
  });
}

function getReq(token: string) {
  return new Request(`http://localhost/api/agent-invites/${token}`, {
    method: "GET",
  });
}

async function claimReq(token: string, sub: string, roles: string[], body: unknown) {
  return new Request(`http://localhost/api/agent-invites/${token}/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(sub, roles),
    },
    body: JSON.stringify(body),
  });
}

/**
 * Seeds an agent_invites row, optionally overriding expires_at / claimed_at.
 * Returns id + the (string) token for use in token-keyed routes.
 */
async function seedInvite(
  invitedBy: string,
  opts: { email?: string; name?: string; expiresAt?: Date; claimedAt?: Date; claimedBy?: string } = {}
): Promise<{ id: string; token: string; email: string }> {
  const email = opts.email ?? "invitee@example.com";
  const rows = await prisma.$queryRaw<{ id: string; token: string; email: string }[]>`
    INSERT INTO agent_invites (email, name, invited_by, expires_at, claimed_at, claimed_by)
    VALUES (
      ${email},
      ${opts.name ?? ""},
      ${invitedBy}::uuid,
      ${opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)},
      ${opts.claimedAt ?? null},
      ${opts.claimedBy ?? null}
    )
    RETURNING id, token::text AS token, email
  `;
  return rows[0];
}

describe("POST /api/admin/agent-invites — create", () => {
  it("1. admin → 201, returns token, and emails an /agent-signup/ link", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await createReq("auth0|admin", ["admin"], {
      email: "newagent@example.com",
      name: "New Agent",
    });
    const res = await createRoute(req);
    expect(res.status).toBe(201);
    const inv = (await res.json()) as { token: string; email: string; claimed: boolean };
    expect(inv.token).toBeTruthy();
    expect(inv.email).toBe("newagent@example.com");
    expect(inv.claimed).toBe(false);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("newagent@example.com");
    expect(sent[0].subject).toContain("agent");
    expect(sent[0].html).toContain(`/agent-signup/${inv.token}`);
  });

  it("2. still returns 201 and persists when the email send throws", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const { client } = fakeEmail({ throwOnSend: true });
    setEmailForTesting(client);

    const req = await createReq("auth0|admin", ["admin"], {
      email: "newagent@example.com",
      name: "New Agent",
    });
    const res = await createRoute(req);
    expect(res.status).toBe(201);
    const count = await prisma.agent_invites.count({
      where: { email: "newagent@example.com" },
    });
    expect(count).toBe(1);
  });

  it("3. non-admin → 403 and no email sent", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await createReq("auth0|agent", ["agent"], {
      email: "x@example.com",
      name: "X",
    });
    const res = await createRoute(req);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("4. missing email → 400", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await createReq("auth0|admin", ["admin"], { name: "No Email" });
    const res = await createRoute(req);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("GET /api/agent-invites/[token] — public validate", () => {
  it("5. returns invite shape for a valid token", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "invitee@example.com", name: "Invitee" });

    const res = await getByTokenRoute(getReq(seeded.token), tokenCtx(seeded.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      email: string;
      name: string;
      token: string;
      claimed: boolean;
      expires_at: string;
    };
    expect(body.id).toBe(seeded.id);
    expect(body.email).toBe("invitee@example.com");
    expect(body.name).toBe("Invitee");
    expect(body.token).toBe(seeded.token);
    expect(body.claimed).toBe(false);
    expect(typeof body.expires_at).toBe("string");
  });

  it("6. unknown token → 404", async () => {
    const unknown = "00000000-0000-0000-0000-000000000000";
    const res = await getByTokenRoute(getReq(unknown), tokenCtx(unknown));
    expect(res.status).toBe(404);
  });

  it("7. expired (unclaimed) token → 410", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, {
      expiresAt: new Date(Date.now() - 60 * 1000),
    });
    const res = await getByTokenRoute(getReq(seeded.token), tokenCtx(seeded.token));
    expect(res.status).toBe(410);
  });
});

describe("POST /api/agent-invites/[token]/claim — claim", () => {
  it("8. upserts an agent user, marks the invite claimed, returns the user", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "invitee@example.com" });

    // #272 — the claim is bound to the invited email, so the caller presents it.
    const req = await claimReq(seeded.token, "auth0|newagent", ["agent"], {
      email: "invitee@example.com",
      name: "Claimed Agent",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(200);
    const user = (await res.json()) as { id: string; email: string; role: string };
    expect(user.email).toBe("invitee@example.com");
    expect(user.role).toBe("agent");

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).not.toBeNull();
    expect(invite?.claimed_by).toBe(user.id);

    // The upserted user is persisted as an agent.
    const dbUser = await prisma.users.findUnique({
      where: { auth0_id: "auth0|newagent" },
      select: { role: true },
    });
    expect(dbUser?.role).toBe("agent");
  });

  // Counterpart to the client-invite regression: the new role-precedence rule
  // must not disturb the agent path. Claim writes `agent`, and the next sync
  // (default agent claim) leaves it exactly as it was.
  it("8b. a later sync with the default agent claim keeps the claimed agent role", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "stays@example.com" });

    const claimRes = await claimRoute(
      await claimReq(seeded.token, "auth0|stays-agent", ["agent"], {
        email: "stays@example.com",
        name: "Stays Agent",
      }),
      tokenCtx(seeded.token)
    );
    expect(claimRes.status).toBe(200);

    const syncRes = await syncRoute(
      new Request("http://localhost/api/users/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|stays-agent", ["agent"]),
        },
        body: JSON.stringify({ email: "stays@example.com", name: "Stays Agent" }),
      })
    );
    expect(syncRes.status).toBe(200);
    expect(((await syncRes.json()) as { role: string }).role).toBe("agent");
  });

  it("9. omitting the email → 400 (claim is bound to the invited email, #272)", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "invited@example.com" });

    // #272 — the pre-fix fallback ("no email → use the invited email") is gone;
    // the caller must present the invited email, so an omitted email is a 400
    // and no account is provisioned / invite burned.
    const req = await claimReq(seeded.token, "auth0|fallback", ["agent"], {});
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(400);

    const dbUser = await prisma.users.findUnique({
      where: { auth0_id: "auth0|fallback" },
      select: { id: true },
    });
    expect(dbUser).toBeNull();

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true },
    });
    expect(invite?.claimed_at).toBeNull();
  });

  it("10. already-claimed invite → 409", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const claimer = await createUser({ role: "agent", auth0_id: "auth0|claimer" });
    const seeded = await seedInvite(admin.id, {
      claimedAt: new Date(),
      claimedBy: claimer.id,
    });

    // #272 — present the invited (default) email so the lookup finds the invite
    // and reaches the already-claimed check.
    const req = await claimReq(seeded.token, "auth0|newagent", ["agent"], {
      email: "invitee@example.com",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(409);
  });

  it("11. expired invite → 410", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, {
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    // #272 — present the invited (default) email so the lookup finds the invite
    // and reaches the expiry check.
    const req = await claimReq(seeded.token, "auth0|newagent", ["agent"], {
      email: "invitee@example.com",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(410);
  });

  it("12. no auth → 401", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id);

    const req = new Request(
      `http://localhost/api/agent-invites/${seeded.token}/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }
    );
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/admin/agent-invites/[inviteId] — revoke", () => {
  it("13. admin deletes an unclaimed invite → {ok:true}", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id);

    const req = await deleteReq(seeded.id, "auth0|admin", ["admin"]);
    const res = await deleteRoute(req, inviteIdCtx(seeded.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const count = await prisma.agent_invites.count({ where: { id: seeded.id } });
    expect(count).toBe(0);
  });

  it("14. deleting a claimed invite → 404", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const claimer = await createUser({ role: "agent", auth0_id: "auth0|claimer" });
    const seeded = await seedInvite(admin.id, {
      claimedAt: new Date(),
      claimedBy: claimer.id,
    });

    const req = await deleteReq(seeded.id, "auth0|admin", ["admin"]);
    const res = await deleteRoute(req, inviteIdCtx(seeded.id));
    expect(res.status).toBe(404);
  });

  it("15. non-admin delete → 403", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const seeded = await seedInvite(admin.id);

    const req = await deleteReq(seeded.id, "auth0|agent", ["agent"]);
    const res = await deleteRoute(req, inviteIdCtx(seeded.id));
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Issue #224 — claiming an agent invite must never rewrite an existing
// account's role (mirror of #174 for client invites): a buyer/seller must not
// be promoted to agent, an admin/tc must not be demoted to agent, and a
// non-agent opening the link must not burn the invite for the real invitee.
// ---------------------------------------------------------------------------

describe("POST /api/agent-invites/[token]/claim — existing accounts (#224)", () => {
  it("18. an existing buyer claiming an agent invite → 409, role unchanged, invite not burned", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "newagent@example.com" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|existing-buyer",
      email: "buyer@example.com",
      name: "Betty Buyer",
    });

    const req = await claimReq(seeded.token, "auth0|existing-buyer", ["buyer"], {
      email: "newagent@example.com",
      name: "Betty Buyer",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(409);

    // The buyer was NOT promoted to agent, and the account was not rewritten.
    const row = await prisma.users.findUnique({
      where: { id: buyer.id },
      select: { role: true, email: true, name: true },
    });
    expect(row?.role).toBe("buyer");
    expect(row?.email).toBe("buyer@example.com");
    expect(row?.name).toBe("Betty Buyer");

    // The invite is still claimable by the real invitee.
    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).toBeNull();
    expect(invite?.claimed_by).toBeNull();
  });

  it.each(["seller", "admin", "tc", "lending_partner"] as const)(
    "19. an existing %s claiming an agent invite → 409, role unchanged, invite unclaimed",
    async (role) => {
      const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
      const seeded = await seedInvite(admin.id, { email: "newagent@example.com" });
      const existing = await createUser({ role, auth0_id: `auth0|existing-${role}` });

      const req = await claimReq(seeded.token, `auth0|existing-${role}`, [role], {
        email: "newagent@example.com",
        name: "Existing User",
      });
      const res = await claimRoute(req, tokenCtx(seeded.token));
      expect(res.status).toBe(409);

      const row = await prisma.users.findUnique({
        where: { id: existing.id },
        select: { role: true },
      });
      expect(row?.role).toBe(role);

      const invite = await prisma.agent_invites.findUnique({
        where: { id: seeded.id },
        select: { claimed_at: true },
      });
      expect(invite?.claimed_at).toBeNull();
    }
  );

  it("20. an existing agent claims → 200, invite claimed by them, account untouched", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "invited@example.com" });
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|existing-agent",
      email: "personal@example.com",
      name: "Alice Agent",
    });

    const req = await claimReq(seeded.token, "auth0|existing-agent", ["agent"], {
      email: "invited@example.com",
      name: "Different Name",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; role: string };
    expect(out.id).toBe(agent.id);
    expect(out.role).toBe("agent");

    // Account untouched: role, email and name all preserved.
    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { role: true, email: true, name: true },
    });
    expect(row?.role).toBe("agent");
    expect(row?.email).toBe("personal@example.com");
    expect(row?.name).toBe("Alice Agent");

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).not.toBeNull();
    expect(invite?.claimed_by).toBe(agent.id);
  });

  it("21. a brand-new user claims → 200, agent account created (happy path intact)", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "brandnew@example.com" });

    const req = await claimReq(seeded.token, "auth0|brand-new", [], {
      email: "brandnew@example.com",
      name: "Nina New",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; role: string; email: string };
    expect(out.role).toBe("agent");
    expect(out.email).toBe("brandnew@example.com");

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).not.toBeNull();
    expect(invite?.claimed_by).toBe(out.id);
  });
});

// ---------------------------------------------------------------------------
// Issue #272 — the agent-invite claim must be bound to the INVITED email
// (mirror of the client-invite claim). #224/#225 closed account-hijack, but a
// brand-new authenticated user who obtains an unclaimed token could still
// self-provision `agent` under an arbitrary email. The claim must only succeed
// when the caller presents the invited email.
// ---------------------------------------------------------------------------

describe("POST /api/agent-invites/[token]/claim — email binding (#272)", () => {
  it("22. brand-new caller with a NON-matching email → rejected, no agent account created, invite not burned", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "intended-agent@example.com" });

    const req = await claimReq(seeded.token, "auth0|attacker", [], {
      email: "attacker@example.com",
      name: "Attacker",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    // Mismatched email → the invite lookup misses (mirrors the client claim).
    expect([404, 409]).toContain(res.status);

    // No agent account was provisioned for the attacker.
    const dbUser = await prisma.users.findUnique({
      where: { auth0_id: "auth0|attacker" },
      select: { id: true, role: true },
    });
    expect(dbUser).toBeNull();

    // The invite is still claimable by the real invitee.
    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).toBeNull();
    expect(invite?.claimed_by).toBeNull();
  });

  it("23. brand-new caller with the INVITED email → 200, agent account created, invite claimed", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "intended-agent@example.com" });

    const req = await claimReq(seeded.token, "auth0|intended", [], {
      email: "intended-agent@example.com",
      name: "Intended Agent",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; role: string; email: string };
    expect(out.role).toBe("agent");
    expect(out.email).toBe("intended-agent@example.com");

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invite?.claimed_at).not.toBeNull();
    expect(invite?.claimed_by).toBe(out.id);
  });

  it("24. existing non-agent presenting the invited email → still 409 (#225 guard intact), invite not burned", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const seeded = await seedInvite(admin.id, { email: "intended-agent@example.com" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|buyer-guard",
      email: "buyer@example.com",
      name: "Betty Buyer",
    });

    const req = await claimReq(seeded.token, "auth0|buyer-guard", ["buyer"], {
      email: "intended-agent@example.com",
      name: "Betty Buyer",
    });
    const res = await claimRoute(req, tokenCtx(seeded.token));
    expect(res.status).toBe(409);

    // The #225 guard still fires: role unchanged, not promoted to agent.
    const row = await prisma.users.findUnique({
      where: { id: buyer.id },
      select: { role: true },
    });
    expect(row?.role).toBe("buyer");

    const invite = await prisma.agent_invites.findUnique({
      where: { id: seeded.id },
      select: { claimed_at: true },
    });
    expect(invite?.claimed_at).toBeNull();
  });
});

describe("upsertUser — keepExistingRole (#224, mirrors #174)", () => {
  it("does not overwrite an existing row's role when keepExistingRole is set", async () => {
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|keep-role-buyer" });

    const user = await upsertUser({
      auth0Id: "auth0|keep-role-buyer",
      email: buyer.email,
      name: buyer.name,
      role: "agent" as Role,
      keepExistingRole: true,
    });
    expect(user.role).toBe("buyer");

    const row = await prisma.users.findUnique({
      where: { id: buyer.id },
      select: { role: true },
    });
    expect(row?.role).toBe("buyer");
  });

  it("still sets the role on first insert when keepExistingRole is set", async () => {
    const user = await upsertUser({
      auth0Id: "auth0|fresh-agent-insert",
      email: "fresh@example.com",
      name: "Fresh Agent",
      role: "agent" as Role,
      keepExistingRole: true,
    });
    expect(user.role).toBe("agent");
  });
});

describe("GET /api/admin/agent-invites — list", () => {
  it("16. admin sees seeded invites (newest first)", async () => {
    const admin = await createUser({ role: "admin", auth0_id: "auth0|admin" });
    await seedInvite(admin.id, { email: "a@example.com" });
    await seedInvite(admin.id, { email: "b@example.com" });

    const res = await listRoute(await listReq("auth0|admin", ["admin"]));
    expect(res.status).toBe(200);
    const list = (await res.json()) as { email: string; claimed: boolean }[];
    expect(list).toHaveLength(2);
    const emails = list.map((r) => r.email).sort();
    expect(emails).toEqual(["a@example.com", "b@example.com"]);
  });

  it("17. non-admin list → 403", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const res = await listRoute(await listReq("auth0|agent", ["agent"]));
    expect(res.status).toBe(403);
  });
});
