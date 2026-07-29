import { describe, it, expect } from "vitest";
import {
  AuthError,
  DEFAULT_TENANT_ROLE,
  decideRole,
  isClientRole,
  requireRole,
  hasRole,
  type Role,
} from "@/lib/roles";

describe("hasRole", () => {
  it("returns true when there is overlap", () => {
    expect(hasRole(["agent"], ["agent", "admin"])).toBe(true);
  });

  it("returns false when there is no overlap", () => {
    expect(hasRole(["buyer"], ["agent", "admin"])).toBe(false);
  });

  it("returns false for empty user roles", () => {
    expect(hasRole([], ["agent"])).toBe(false);
  });

  it("returns false for empty allowed roles (defensive)", () => {
    expect(hasRole(["agent"], [])).toBe(false);
  });
});

describe("requireRole", () => {
  it("returns silently when the user has an allowed role", () => {
    expect(() => requireRole(["agent"], ["agent", "admin"])).not.toThrow();
  });

  it("throws AuthError(403) when the user has no allowed role", () => {
    try {
      requireRole(["buyer"], ["agent", "admin"]);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
  });

  it("throws AuthError(403) when the user has no roles", () => {
    expect(() => requireRole([], ["agent"])).toThrow(AuthError);
  });
});

describe("isClientRole", () => {
  it("is true only for the portal roles an invite can grant", () => {
    expect(isClientRole("buyer")).toBe(true);
    expect(isClientRole("seller")).toBe(true);
    expect(isClientRole("agent")).toBe(false);
    expect(isClientRole("admin")).toBe(false);
    expect(isClientRole("tc")).toBe(false);
    expect(isClientRole("lending_partner")).toBe(false);
    expect(isClientRole(null)).toBe(false);
    expect(isClientRole(undefined)).toBe(false);
  });
});

/**
 * The invited-client-becomes-an-agent bug. The Auth0 tenant hands every new
 * signup a default `agent` role; before decideRole, /users/sync let that claim
 * overwrite the `buyer`/`seller` the invite claim had written moments earlier,
 * and the client landed in agent onboarding.
 */
describe("decideRole", () => {
  const cases: Array<{
    name: string;
    claimedRole: Role | null;
    dbRole: Role | null;
    inviteRole: Role | null;
    expected: Role | null;
  }> = [
    // Rule 2 — the regression this whole rule exists for.
    {
      name: "a default agent claim does NOT overwrite a persisted buyer",
      claimedRole: "agent", dbRole: "buyer", inviteRole: null, expected: "buyer",
    },
    {
      name: "a default agent claim does NOT overwrite a persisted seller",
      claimedRole: "agent", dbRole: "seller", inviteRole: null, expected: "seller",
    },
    // Rule 1 — explicit promotion still works (the documented CLAUDE.md path).
    {
      name: "an explicit admin claim promotes an existing agent",
      claimedRole: "admin", dbRole: "agent", inviteRole: null, expected: "admin",
    },
    {
      name: "an explicit admin claim beats even a persisted buyer",
      claimedRole: "admin", dbRole: "buyer", inviteRole: null, expected: "admin",
    },
    {
      name: "a tc claim beats a persisted agent",
      claimedRole: "tc", dbRole: "agent", inviteRole: null, expected: "tc",
    },
    // Rule 3 — safety net when the claim POST never ran or failed.
    {
      name: "an open buyer invite beats a default agent claim for a brand-new user",
      claimedRole: "agent", dbRole: null, inviteRole: "buyer", expected: "buyer",
    },
    {
      name: "an open seller invite beats a default agent claim for a brand-new user",
      claimedRole: "agent", dbRole: null, inviteRole: "seller", expected: "seller",
    },
    // Rule 3 is gated on !dbRole — an agent holding a client invite for their
    // own email must never be demoted (cf. #174).
    {
      name: "an open buyer invite does NOT demote an established agent",
      claimedRole: "agent", dbRole: "agent", inviteRole: "buyer", expected: "agent",
    },
    // Rule 4 — self-serve agent signup with no invite is intentional.
    {
      name: "a brand-new signup with no invite becomes an agent",
      claimedRole: "agent", dbRole: null, inviteRole: null, expected: "agent",
    },
    {
      name: "no claim falls back to the persisted role",
      claimedRole: null, dbRole: "agent", inviteRole: null, expected: "agent",
    },
    {
      name: "no claim falls back to a persisted buyer",
      claimedRole: null, dbRole: "buyer", inviteRole: null, expected: "buyer",
    },
    {
      name: "no claim and no row still honours an open invite",
      claimedRole: null, dbRole: null, inviteRole: "buyer", expected: "buyer",
    },
    // Removing an admin's RBAC role must still demote them on next login.
    {
      name: "dropping back to a bare agent claim demotes a former admin",
      claimedRole: "agent", dbRole: "admin", inviteRole: null, expected: "agent",
    },
    {
      name: "nothing anywhere resolves to null (caller answers 403)",
      claimedRole: null, dbRole: null, inviteRole: null, expected: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(
        decideRole({
          claimedRole: c.claimedRole,
          dbRole: c.dbRole,
          inviteRole: c.inviteRole,
        })
      ).toBe(c.expected);
    });
  }

  it("treats exactly the tenant default as the weak claim", () => {
    expect(DEFAULT_TENANT_ROLE).toBe("agent");
  });
});
