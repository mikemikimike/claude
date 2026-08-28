import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { POST as clientInviteRoute } from "@/app/api/me/client-invite/route";
import { GET as clientInviteGetRoute } from "@/app/api/invites/[token]/route";
import { POST as claimInviteRoute } from "@/app/api/invites/[token]/claim/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
import { prisma } from "@/lib/db";
import { upsertUser } from "@/lib/users";
import type { Role } from "@/lib/roles";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(() => {
  // Reset the seam so a stub never leaks into other suites.
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

function inviteReq(sub: string, roles: string[], body: unknown) {
  return (async () =>
    new Request(`http://localhost/api/me/client-invite`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(sub, roles),
      },
      body: JSON.stringify(body),
    }))();
}

describe("POST /api/me/client-invite — Resend email", () => {
  it("1. creates an agent-owned deal + claimable invite and emails the /invite/<token> link", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await inviteReq("auth0|agent", ["agent"], {
      email: "buyer@example.com",
      name: "Bob Buyer",
      role: "buyer",
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; inviteUrl: string; dealId: string };
    expect(out.ok).toBe(true);
    // Account-first: the link points at the tokened /invite/<token> flow.
    expect(out.inviteUrl).toMatch(/\/invite\/[0-9a-f-]{36}$/i);

    // A deal_invites row was created, tied to a new deal the inviting agent owns.
    const invites = await prisma.$queryRaw<
      { email: string; role: string; deal_id: string; invited_by: string }[]
    >`SELECT email, role, deal_id, invited_by FROM deal_invites`;
    expect(invites).toHaveLength(1);
    expect(invites[0].email).toBe("buyer@example.com");
    expect(invites[0].role).toBe("buyer");
    expect(invites[0].invited_by).toBe(agent.id);

    const deals = await prisma.$queryRaw<
      { id: string; agent_id: string; type: string }[]
    >`SELECT id, agent_id, type::text AS type FROM deals`;
    expect(deals).toHaveLength(1);
    expect(deals[0].agent_id).toBe(agent.id);
    expect(deals[0].type).toBe("buy");
    expect(deals[0].id).toBe(invites[0].deal_id);
    expect(out.dealId).toBe(deals[0].id);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("buyer@example.com");
    expect(sent[0].html).toContain("/invite/");
  });

  it("2. seller role creates a 'sell' deal + invite", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|seller-agent" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await inviteReq("auth0|seller-agent", ["agent"], {
      email: "seller@example.com",
      name: "Sam Seller",
      role: "seller",
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { inviteUrl: string };
    expect(out.inviteUrl).toMatch(/\/invite\/[0-9a-f-]{36}$/i);
    expect(sent).toHaveLength(1);

    const rows = await prisma.$queryRaw<{ type: string; role: string }[]>`
      SELECT d.type::text AS type, di.role
      FROM deal_invites di JOIN deals d ON d.id = di.deal_id
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("sell");
    expect(rows[0].role).toBe("seller");
  });

  it("3. admin role is allowed", async () => {
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await inviteReq("auth0|admin", ["admin"], {
      email: "buyer@example.com",
      name: "Bob Buyer",
      role: "buyer",
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("4. still returns 200 when the email send throws", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const { client } = fakeEmail({ throwOnSend: true });
    setEmailForTesting(client);

    const req = await inviteReq("auth0|agent", ["agent"], {
      email: "buyer@example.com",
      name: "Bob Buyer",
      role: "buyer",
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(200);
  });

  it("5. non-agent/admin role → 403 and no email sent", async () => {
    await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await inviteReq("auth0|buyer", ["buyer"], {
      email: "x@example.com",
      name: "X",
      role: "buyer",
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it("6. missing fields → 400 and no email sent", async () => {
    await createUser({ role: "agent", auth0_id: "auth0|agent" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await inviteReq("auth0|agent", ["agent"], {
      email: "buyer@example.com",
      name: "Bob Buyer",
      // role omitted
    });
    const res = await clientInviteRoute(req);
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Issue #174 — claiming a client invite must never rewrite an existing
// account's role, and an elevated user (agent/admin/tc) previewing the link
// must not burn the invite for the real client.
// ---------------------------------------------------------------------------

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

/** Seeds an agent + deal + a claimable deal_invites row for `email`. */
async function seedInvite(opts: {
  email: string;
  role?: "buyer" | "seller";
  agentAuth0Id?: string;
}) {
  const agent = await createUser({
    role: "agent",
    auth0_id: opts.agentAuth0Id ?? "auth0|inviting-agent",
  });
  const deal = await createDeal({ agent_id: agent.id });
  const invite = await prisma.deal_invites.create({
    data: {
      deal_id: deal.id,
      email: opts.email,
      name: "Invited Client",
      role: opts.role ?? "buyer",
      invited_by: agent.id,
    },
  });
  return { agent, deal, invite };
}

async function claimReq(sub: string, roles: string[], token: string, body: unknown) {
  return new Request(`http://localhost/api/invites/${token}/claim`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: await authHeader(sub, roles),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/invites/[token]/claim — existing accounts (#174)", () => {
  it("1. the inviting agent claiming their own buyer invite → 409, role unchanged, invite not burned", async () => {
    const { agent, deal, invite } = await seedInvite({
      email: "buyer@example.com",
      agentAuth0Id: "auth0|the-agent",
    });

    const req = await claimReq("auth0|the-agent", ["agent"], invite.token, {
      email: "buyer@example.com",
      name: "Bob Buyer",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(409);

    // The agent was NOT demoted to buyer.
    const agentRow = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { role: true },
    });
    expect(agentRow?.role).toBe("agent");

    // The invite is still claimable by the real client.
    const invRow = await prisma.deal_invites.findUnique({
      where: { id: invite.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invRow?.claimed_at).toBeNull();
    expect(invRow?.claimed_by).toBeNull();

    // The agent did not become a participant on their own deal.
    const participants = await prisma.deal_participants.count({
      where: { deal_id: deal.id },
    });
    expect(participants).toBe(0);
  });

  it.each(["admin", "tc", "lending_partner"] as const)(
    "2. an existing %s claiming a client invite → 409, role unchanged",
    async (role) => {
      const { invite } = await seedInvite({ email: "client@example.com" });
      const elevated = await createUser({ role, auth0_id: `auth0|elevated-${role}` });

      const req = await claimReq(`auth0|elevated-${role}`, [role], invite.token, {
        email: "client@example.com",
        name: "Invited Client",
      });
      const res = await claimInviteRoute(req, ctx(invite.token));
      expect(res.status).toBe(409);

      const row = await prisma.users.findUnique({
        where: { id: elevated.id },
        select: { role: true },
      });
      expect(row?.role).toBe(role);

      const invRow = await prisma.deal_invites.findUnique({
        where: { id: invite.id },
        select: { claimed_at: true },
      });
      expect(invRow?.claimed_at).toBeNull();
    }
  );

  it("3. an existing buyer claims → participant added, role stays buyer, account not rewritten", async () => {
    const { deal, invite } = await seedInvite({ email: "invited@example.com" });
    const buyer = await createUser({
      role: "buyer",
      auth0_id: "auth0|existing-buyer",
      email: "personal@example.com",
      name: "Betty Buyer",
    });

    const req = await claimReq("auth0|existing-buyer", ["buyer"], invite.token, {
      email: "invited@example.com",
      name: "Invited Client",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; role: string };
    expect(out.id).toBe(buyer.id);
    expect(out.role).toBe("buyer");

    // Account untouched: role, email and name all preserved.
    const row = await prisma.users.findUnique({
      where: { id: buyer.id },
      select: { role: true, email: true, name: true },
    });
    expect(row?.role).toBe("buyer");
    expect(row?.email).toBe("personal@example.com");
    expect(row?.name).toBe("Betty Buyer");

    // Participant row added and the invite is claimed by the buyer.
    const participants = await prisma.deal_participants.findMany({
      where: { deal_id: deal.id },
      select: { user_id: true, role: true },
    });
    expect(participants).toHaveLength(1);
    expect(participants[0].user_id).toBe(buyer.id);
    expect(participants[0].role).toBe("buyer");

    const invRow = await prisma.deal_invites.findUnique({
      where: { id: invite.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invRow?.claimed_at).not.toBeNull();
    expect(invRow?.claimed_by).toBe(buyer.id);
  });

  it("4. an existing seller claiming a buyer invite keeps role=seller (no overwrite)", async () => {
    const { deal, invite } = await seedInvite({ email: "cross@example.com", role: "buyer" });
    const seller = await createUser({
      role: "seller",
      auth0_id: "auth0|existing-seller",
      email: "cross@example.com",
    });

    const req = await claimReq("auth0|existing-seller", ["seller"], invite.token, {
      email: "cross@example.com",
      name: "Sam Seller",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);

    const row = await prisma.users.findUnique({
      where: { id: seller.id },
      select: { role: true },
    });
    expect(row?.role).toBe("seller");

    // Participant row carries the invite's role for this deal.
    const participants = await prisma.deal_participants.findMany({
      where: { deal_id: deal.id, user_id: seller.id },
      select: { role: true },
    });
    expect(participants).toHaveLength(1);
    expect(participants[0].role).toBe("buyer");
  });

  it("5. a brand-new user claims → account created with the invite's role (happy path intact)", async () => {
    const { deal, invite } = await seedInvite({ email: "new@example.com" });

    const req = await claimReq("auth0|brand-new", [], invite.token, {
      email: "new@example.com",
      name: "Nina New",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: string; role: string; email: string };
    expect(out.role).toBe("buyer");
    expect(out.email).toBe("new@example.com");

    const participants = await prisma.deal_participants.count({
      where: { deal_id: deal.id, user_id: out.id },
    });
    expect(participants).toBe(1);

    const invRow = await prisma.deal_invites.findUnique({
      where: { id: invite.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invRow?.claimed_at).not.toBeNull();
    expect(invRow?.claimed_by).toBe(out.id);
  });
});

// ---------------------------------------------------------------------------
// Issue #175 — the onboarding questionnaire rides along with the claim so the
// invite's deal gets the client's intake (and a seller's property address)
// atomically, and the agent's "client joined" email carries highlights.
// ---------------------------------------------------------------------------

describe("POST /api/invites/[token]/claim — intake persistence (#175)", () => {
  it("1. buyer claim with intake persists it on the invite's deal", async () => {
    const { deal, invite } = await seedInvite({ email: "buyer@example.com" });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    const answers = {
      bedrooms: "4+",
      areas: "Homewood",
      minBudget: 300000,
      maxBudget: 500000,
      lenderChoice: "fastpass",
    };
    const req = await claimReq("auth0|new-buyer", [], invite.token, {
      email: "buyer@example.com",
      name: "Bob Buyer",
      intake: { role: "buyer", answers },
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { intake: true },
    });
    const stored = row?.intake as {
      role: string;
      submitted_at: string;
      answers: Record<string, unknown>;
    };
    expect(stored.role).toBe("buyer");
    expect(stored.answers).toMatchObject(answers);
  });

  it("2. seller claim with intake writes the property address onto the deal", async () => {
    const { deal, invite } = await seedInvite({
      email: "seller@example.com",
      role: "seller",
    });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    const req = await claimReq("auth0|new-seller", [], invite.token, {
      email: "seller@example.com",
      name: "Sam Seller",
      intake: {
        role: "seller",
        answers: {
          address: "789 Maple Dr, Hoover, AL 35226",
          desiredListDate: "ASAP",
        },
      },
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { address: true, intake: true },
    });
    expect(row?.address).toBe("789 Maple Dr, Hoover, AL 35226");
    expect(row?.intake).toBeTruthy();
  });

  it("3. the agent-notification email includes intake highlights (budget, areas, lender)", async () => {
    const { invite } = await seedInvite({ email: "buyer@example.com" });
    const { client, sent } = fakeEmail();
    setEmailForTesting(client);

    const req = await claimReq("auth0|new-buyer", [], invite.token, {
      email: "buyer@example.com",
      name: "Bob Buyer",
      intake: {
        role: "buyer",
        answers: {
          areas: "Vestavia Hills",
          minBudget: 250000,
          maxBudget: 400000,
          lenderChoice: "mountain",
        },
      },
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);

    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain("Vestavia Hills");
    expect(sent[0].html).toContain("$250K");
    expect(sent[0].html).toContain("$400K");
    expect(sent[0].html).toContain("Mountain Mortgage");
  });

  it("4. claim without intake still works and leaves deals.intake null (back-compat)", async () => {
    const { deal, invite } = await seedInvite({ email: "plain@example.com" });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    const req = await claimReq("auth0|plain-new", [], invite.token, {
      email: "plain@example.com",
      name: "Plain Client",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { intake: true },
    });
    expect(row?.intake).toBeNull();
  });

  it("5. malformed intake (answers not an object) → 400, nothing written, invite not burned", async () => {
    const { deal, invite } = await seedInvite({ email: "bad@example.com" });
    const { client } = fakeEmail();
    setEmailForTesting(client);

    const req = await claimReq("auth0|bad-new", [], invite.token, {
      email: "bad@example.com",
      name: "Bad Payload",
      intake: { role: "buyer", answers: "not-an-object" },
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(400);

    const invRow = await prisma.deal_invites.findUnique({
      where: { id: invite.id },
      select: { claimed_at: true },
    });
    expect(invRow?.claimed_at).toBeNull();

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { intake: true },
    });
    expect(row?.intake).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Issue #396 — same latent bug as the agent claim: a NEW Auth0 subject whose
// email already belongs to a DIFFERENT users row must get the readable 409,
// not an unhandled EmailConflictError escaping withAuth as a 500.
// ---------------------------------------------------------------------------

describe("POST /api/invites/[token]/claim — email collision (#396)", () => {
  it("a new sub presenting an already-used email → 409, invite not burned", async () => {
    const { deal, invite } = await seedInvite({ email: "dup@example.com" });
    // The address already has an account under a DIFFERENT Auth0 sub — the
    // client went through signup a second time.
    const original = await createUser({
      role: "buyer",
      auth0_id: "auth0|original",
      email: "dup@example.com",
      name: "Original Owner",
    });

    const req = await claimReq("auth0|second", [], invite.token, {
      email: "dup@example.com",
      name: "Second Identity",
    });
    const res = await claimInviteRoute(req, ctx(invite.token));
    expect(res.status).toBe(409);
    const text = (await res.text()).toLowerCase();
    expect(text).toContain("an account with this email already exists");

    // No partial state: invite still claimable, no participant row, no second
    // users row, and the original account untouched.
    const invRow = await prisma.deal_invites.findUnique({
      where: { id: invite.id },
      select: { claimed_at: true, claimed_by: true },
    });
    expect(invRow?.claimed_at).toBeNull();
    expect(invRow?.claimed_by).toBeNull();

    const participants = await prisma.deal_participants.count({
      where: { deal_id: deal.id },
    });
    expect(participants).toBe(0);

    const owners = await prisma.users.findMany({
      where: { email: "dup@example.com" },
      select: { id: true, auth0_id: true },
    });
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(original.id);
    expect(owners[0].auth0_id).toBe("auth0|original");
  });
});

describe("upsertUser — keepExistingRole (#174)", () => {
  it("does not overwrite an existing row's role when keepExistingRole is set", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|keep-role" });

    const user = await upsertUser({
      auth0Id: "auth0|keep-role",
      email: agent.email,
      name: agent.name,
      role: "buyer" as Role,
      keepExistingRole: true,
    });
    expect(user.role).toBe("agent");

    const row = await prisma.users.findUnique({
      where: { id: agent.id },
      select: { role: true },
    });
    expect(row?.role).toBe("agent");
  });

  it("still sets the role on first insert when keepExistingRole is set", async () => {
    const user = await upsertUser({
      auth0Id: "auth0|fresh-insert",
      email: "fresh@example.com",
      name: "Fresh User",
      role: "buyer" as Role,
      keepExistingRole: true,
    });
    expect(user.role).toBe("buyer");
  });
});

// ---------------------------------------------------------------------------
// Issue #278 — the client-invite GET must signal expiry so the /invite/[token]
// landing page can render an "ask your agent to resend" state BEFORE any Auth0
// account is created. Mirrors the agent-invite GET: 410 when expires_at < now
// AND the invite is unclaimed; a claimed invite still shows its claimed state.
// ---------------------------------------------------------------------------

/** Seeds an agent + deal + a deal_invites row with explicit expiry/claim state. */
async function seedInviteRow(opts: { expiresAt: Date; claimedAt?: Date | null }) {
  const agent = await createUser({ role: "agent" });
  const deal = await createDeal({ agent_id: agent.id, title: "123 Main St" });
  const invite = await prisma.deal_invites.create({
    data: {
      deal_id: deal.id,
      email: "client@example.com",
      name: "Invited Client",
      role: "buyer",
      invited_by: agent.id,
      expires_at: opts.expiresAt,
      claimed_at: opts.claimedAt ?? null,
      claimed_by: opts.claimedAt ? agent.id : null,
    },
  });
  return { agent, deal, invite };
}

function getReq(token: string) {
  return new Request(`http://localhost/api/invites/${token}`);
}

describe("GET /api/invites/[token] — expiry (#278)", () => {
  const past = () => new Date(Date.now() - 60_000); // 1 min ago
  const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days out

  it("1. an unclaimed invite whose expires_at is in the past → 410", async () => {
    const { invite } = await seedInviteRow({ expiresAt: past() });
    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    expect(res.status).toBe(410);
  });

  it("2. an unclaimed, unexpired invite → normal 200 payload", async () => {
    const { invite } = await seedInviteRow({ expiresAt: future() });
    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      token: string;
      claimed: boolean;
      deal_title: string;
      email: string;
      role: string;
    };
    expect(out.token).toBe(invite.token);
    expect(out.claimed).toBe(false);
    expect(out.deal_title).toBe("123 Main St");
    expect(out.email).toBe("client@example.com");
    expect(out.role).toBe("buyer");
  });

  it("3. an expired but already-claimed invite still returns its claimed state (claim wins over expiry)", async () => {
    const { invite } = await seedInviteRow({ expiresAt: past(), claimedAt: new Date() });
    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { claimed: boolean };
    expect(out.claimed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #425 — the landing page skips its "create account / log in" chooser and sends
// a brand-new invitee straight to Auth0 signup. It can only do that if the GET
// tells it whether the invited email already has a RealTourFlow account, so
// `has_account` is part of the contract, not a nicety.
// ---------------------------------------------------------------------------

describe("GET /api/invites/[token] — has_account (#425)", () => {
  const future = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  it("1. reports has_account=false when the invited email has no user row", async () => {
    const { invite } = await seedInviteRow({ expiresAt: future() });
    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { has_account: boolean };
    expect(out.has_account).toBe(false);
  });

  it("2. reports has_account=true when an account already exists for that email", async () => {
    const { invite } = await seedInviteRow({ expiresAt: future() });
    await createUser({ role: "buyer", email: "client@example.com" });

    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    const out = (await res.json()) as { has_account: boolean };
    expect(out.has_account).toBe(true);
  });

  it("3. matches case-insensitively — a case difference must not send them to signup", async () => {
    // users.email is unique only case-SENSITIVELY and the agent types the
    // invite address by hand, so `Client@Example.com` and `client@example.com`
    // are the same person. Reporting has_account=false here would auto-walk an
    // existing account into Auth0's signup form.
    const { invite } = await seedInviteRow({ expiresAt: future() });
    await createUser({ role: "buyer", email: "CLIENT@Example.COM" });

    const res = await clientInviteGetRoute(getReq(invite.token), ctx(invite.token));
    const out = (await res.json()) as { has_account: boolean };
    expect(out.has_account).toBe(true);
  });
});
