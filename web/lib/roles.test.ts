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
    tcLinked?: boolean;
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
    // Rule 3 no longer knows about TCs (#446). A `tc` role comes from claiming
    // a token, never from an email appearing in some agent's settings — for a
    // TC the role and the pipeline are one grant, so an email-only safety net
    // WAS the vulnerability.
    {
      name: "an invite-derived tc role is IGNORED — only client roles use rule 3",
      claimedRole: "agent", dbRole: null, inviteRole: "tc", expected: "agent",
    },
    // Rule 2b — once they ARE a TC, the tenant's default agent claim must not
    // take it back on their second login (#415)…
    {
      name: "a default agent claim does NOT overwrite a persisted, still-linked tc",
      claimedRole: "agent", dbRole: "tc", inviteRole: null, tcLinked: true, expected: "tc",
    },
    // …but that protection is tied to the link, so revocation actually works
    // (#446). The agent removes them in Settings → next login demotes them, no
    // hand-written UPDATE required.
    {
      name: "an UNLINKED tc is demoted by a bare agent claim — revocation works",
      claimedRole: "agent", dbRole: "tc", inviteRole: null, tcLinked: false, expected: "agent",
    },
    {
      name: "an unlinked tc with no claim at all keeps tc rather than becoming null",
      claimedRole: null, dbRole: "tc", inviteRole: null, tcLinked: false, expected: "tc",
    },
    {
      name: "an explicit Auth0 tc claim outranks the link check entirely (rule 1)",
      claimedRole: "tc", dbRole: "tc", inviteRole: null, tcLinked: false, expected: "tc",
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
          tcLinked: c.tcLinked,
        })
      ).toBe(c.expected);
    });
  }

  it("treats exactly the tenant default as the weak claim", () => {
    expect(DEFAULT_TENANT_ROLE).toBe("agent");
  });
});
