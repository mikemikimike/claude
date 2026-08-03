import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { pendingInviteRole, roleForEmail } from "@/lib/invite-role";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createDeal, createUser } from "../helpers/factories";

/**
 * lib/invite-role.ts backs two callers that must never disagree about an
 * email's role: resolveSyncRole (POST /users/sync) and GET /api/invites/role
 * (the Auth0 Post-Login Action). Both were previously covered only indirectly
 * through route tests, which hid a case-sensitivity mismatch between the two
 * lookups in this module.
 */
beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
});

async function seedInvite(
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

describe("pendingInviteRole", () => {
  it("returns the role of an open invite", async () => {
    await seedInvite("open@example.com", "buyer");
    expect(await pendingInviteRole("open@example.com")).toBe("buyer");
  });

  // Auth0 hands back a normalized address; the agent typed whatever they typed
  // into the invite form. A case miss would silently drop the invited role.
  it("matches the invited email case-insensitively", async () => {
    await seedInvite("Mixed.Case@Example.com", "seller");
    expect(await pendingInviteRole("mixed.case@example.com")).toBe("seller");
  });

  it("ignores a claimed invite", async () => {
    await seedInvite("claimed@example.com", "buyer", { claimed: true });
    expect(await pendingInviteRole("claimed@example.com")).toBeNull();
  });

  it("ignores an expired invite", async () => {
    await seedInvite("expired@example.com", "buyer", { expired: true });
    expect(await pendingInviteRole("expired@example.com")).toBeNull();
  });

  it("returns null for an unknown email and for an empty string", async () => {
    expect(await pendingInviteRole("nobody@example.com")).toBeNull();
    expect(await pendingInviteRole("")).toBeNull();
  });

  it("prefers the newest invite when several are open", async () => {
    await seedInvite("two@example.com", "buyer");
    await new Promise((r) => setTimeout(r, 5));
    await seedInvite("two@example.com", "seller");
    expect(await pendingInviteRole("two@example.com")).toBe("seller");
  });

  // deal_invites.role is a plain text column, not the user_role enum — the DB
  // is what keeps it to buyer/seller (deal_invites_role_check). Pinning that
  // here because pendingInviteRole's isValidRole() guard is only belt-and-
  // braces over this constraint: if the constraint were ever dropped, an
  // invite could start handing out `admin`.
  it("cannot store a non-client role on an invite row (DB constraint)", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await expect(
      prisma.deal_invites.create({
        data: {
          deal_id: deal.id,
          email: "escalate@example.com",
          name: "Escalate",
          role: "admin",
          invited_by: agent.id,
        },
      })
    ).rejects.toThrow(/deal_invites_role_check/);
  });
});

describe("roleForEmail", () => {
  it("prefers an existing account's role over any invite", async () => {
    await createUser({ email: "both@example.com", role: "admin" });
    await seedInvite("both@example.com", "buyer");
    expect(await roleForEmail("both@example.com")).toBe("admin");
  });

  // Must agree with pendingInviteRole — a case-sensitive account lookup here
  // would miss the user and wrongly report the invite's role instead.
  it("finds the account case-insensitively", async () => {
    await createUser({ email: "Caps@Example.com", role: "tc" });
    expect(await roleForEmail("caps@example.com")).toBe("tc");
  });

  // users.email is unique only case-SENSITIVELY, so two rows differing only by
  // case are possible (none exist today). The lookup must then be deterministic
  // — the original account wins — rather than returning whichever row the
  // planner reached first.
  it("returns the OLDEST account when two differ only by case", async () => {
    const first = await createUser({ email: "Dup@Example.com", role: "admin" });
    await prisma.users.update({
      where: { id: first.id },
      data: { created_at: new Date("2020-01-01T00:00:00Z") },
    });
    await createUser({ email: "dup@example.com", role: "buyer" });

    expect(await roleForEmail("DUP@EXAMPLE.COM")).toBe("admin");
  });

  it("falls back to an open invite when no account exists", async () => {
    await seedInvite("invited-only@example.com", "seller");
    expect(await roleForEmail("invited-only@example.com")).toBe("seller");
  });

  it('returns "" when nothing applies', async () => {
    expect(await roleForEmail("nobody@example.com")).toBe("");
    expect(await roleForEmail("")).toBe("");
  });
});
