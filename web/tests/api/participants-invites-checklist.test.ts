import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  GET as listParticipantsRoute,
  POST as addParticipantRoute,
} from "@/app/api/deals/[id]/participants/route";
import { DELETE as removeParticipantRoute } from "@/app/api/deals/[id]/participants/[userId]/route";
import {
  GET as listChecklistRoute,
  POST as createChecklistRoute,
} from "@/app/api/deals/[id]/checklist/route";
import {
  PATCH as updateChecklistRoute,
  DELETE as deleteChecklistRoute,
} from "@/app/api/deals/[id]/checklist/[itemId]/route";
import {
  GET as listContingenciesRoute,
  POST as createContingencyRoute,
} from "@/app/api/deals/[id]/contingencies/route";
import {
  PATCH as updateContingencyRoute,
  DELETE as deleteContingencyRoute,
} from "@/app/api/deals/[id]/contingencies/[contingencyId]/route";
import {
  POST as createInviteRoute,
} from "@/app/api/deals/[id]/invite/route";
import { GET as getInviteRoute } from "@/app/api/invites/[token]/route";
import { POST as claimInviteRoute } from "@/app/api/invites/[token]/claim/route";
import { GET as getInviteRoleRoute } from "@/app/api/invites/role/route";
import { POST as syncRoute } from "@/app/api/users/sync/route";
import { GET as myDealsRoute } from "@/app/api/me/deals/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { resetEnvForTesting } from "@/lib/env";
import { prisma } from "@/lib/db";
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

function ctx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

describe("Participants", () => {
  it("agent can list and add a participant; non-owner cannot", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id });

    // Add
    const addReq = new Request(
      `http://localhost/api/deals/${deal.id}/participants`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ user_id: buyer.id, role: "buyer" }),
      }
    );
    const addRes = await addParticipantRoute(addReq, ctx({ id: deal.id }));
    expect(addRes.status).toBe(200);

    // List
    const listReq = new Request(
      `http://localhost/api/deals/${deal.id}/participants`,
      { headers: { authorization: await authHeader("auth0|a", ["agent"]) } }
    );
    const listRes = await listParticipantsRoute(listReq, ctx({ id: deal.id }));
    const list = (await listRes.json()) as { role: string }[];
    expect(list.length).toBe(1);
    expect(list[0].role).toBe("buyer");
  });

  it("agent can remove a participant", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/participants/${buyer.id}`,
      {
        method: "DELETE",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const res = await removeParticipantRoute(req, ctx({ id: deal.id, userId: buyer.id }));
    expect(res.status).toBe(200);
    const count = await prisma.deal_participants.count({ where: { deal_id: deal.id } });
    expect(count).toBe(0);
  });
});

describe("Checklist", () => {
  it("auto-seeds 17 default items when listing for an under_contract+ deal with empty list", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    const req = new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listChecklistRoute(req, ctx({ id: deal.id }));
    expect(res.status).toBe(200);
    const items = (await res.json()) as { label: string }[];
    expect(items.length).toBe(17);
  });

  it("two concurrent first loads seed the defaults exactly once (#90)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    const makeReq = async () =>
      new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      });

    // Two racing first-opens: both handlers run count() before either
    // createMany commits. Without the partial unique index + conflict-tolerant
    // seed this double-seeds (34 rows).
    const [resA, resB] = await Promise.all([
      listChecklistRoute(await makeReq(), ctx({ id: deal.id })),
      listChecklistRoute(await makeReq(), ctx({ id: deal.id })),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const count = await prisma.checklist_items.count({
      where: { deal_id: deal.id },
    });
    expect(count).toBe(17);

    // Both callers see the winner's items.
    const itemsA = (await resA.json()) as { label: string }[];
    const itemsB = (await resB.json()) as { label: string }[];
    expect(itemsA.length).toBe(17);
    expect(itemsB.length).toBe(17);
  });

  it("does NOT auto-seed for deals still in intake", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const req = new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
      headers: { authorization: await authHeader("auth0|a", ["agent"]) },
    });
    const res = await listChecklistRoute(req, ctx({ id: deal.id }));
    const items = (await res.json()) as unknown[];
    expect(items.length).toBe(0);
  });

  it("creates a custom item with next sort_order, then can update and delete it", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    // Seed first
    await listChecklistRoute(
      new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }),
      ctx({ id: deal.id })
    );

    const createReq = new Request(
      `http://localhost/api/deals/${deal.id}/checklist`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ label: "Custom: review HOA docs" }),
      }
    );
    const createRes = await createChecklistRoute(createReq, ctx({ id: deal.id }));
    const created = (await createRes.json()) as {
      id: string;
      sort_order: number;
      is_custom: boolean;
    };
    expect(created.is_custom).toBe(true);
    expect(created.sort_order).toBe(17);

    // Update — mark checked
    const updReq = new Request(
      `http://localhost/api/deals/${deal.id}/checklist/${created.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ checked: true }),
      }
    );
    const updRes = await updateChecklistRoute(
      updReq,
      ctx({ id: deal.id, itemId: created.id })
    );
    expect(updRes.status).toBe(200);
    const updated = (await updRes.json()) as { checked: boolean };
    expect(updated.checked).toBe(true);

    // Delete
    const delReq = new Request(
      `http://localhost/api/deals/${deal.id}/checklist/${created.id}`,
      {
        method: "DELETE",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const delRes = await deleteChecklistRoute(
      delReq,
      ctx({ id: deal.id, itemId: created.id })
    );
    expect(delRes.status).toBe(200);
  });

  it("non-owner without tc/admin role returns 404 (deal not found)", async () => {
    const agent = await createUser({ role: "agent" });
    const stranger = await createUser({ role: "buyer", auth0_id: "auth0|s" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    void stranger;
    const req = new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
      headers: { authorization: await authHeader("auth0|s", ["buyer"]) },
    });
    const res = await listChecklistRoute(req, ctx({ id: deal.id }));
    expect(res.status).toBe(404);
  });

  it("an intentionally emptied checklist stays empty — no re-seed on next GET (#264)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    const auth = await authHeader("auth0|a", ["agent"]);
    const getChecklist = () =>
      listChecklistRoute(
        new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
          headers: { authorization: auth },
        }),
        ctx({ id: deal.id })
      );

    // First GET seeds the 17 defaults.
    const seeded = (await (await getChecklist()).json()) as { id: string }[];
    expect(seeded.length).toBe(17);

    // Delete every item — defaults are deletable (e.g. a cash deal).
    for (const item of seeded) {
      const delRes = await deleteChecklistRoute(
        new Request(
          `http://localhost/api/deals/${deal.id}/checklist/${item.id}`,
          { method: "DELETE", headers: { authorization: auth } }
        ),
        ctx({ id: deal.id, itemId: item.id })
      );
      expect(delRes.status).toBe(200);
    }

    // Next GET must NOT resurrect the defaults (the bug: count === 0 re-seeds).
    const after = (await (await getChecklist()).json()) as unknown[];
    expect(after.length).toBe(0);
  });

  it("seeds defaults exactly once and stamps checklist_seeded_at; second GET doesn't duplicate (#264)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    const auth = await authHeader("auth0|a", ["agent"]);
    const getChecklist = () =>
      listChecklistRoute(
        new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
          headers: { authorization: auth },
        }),
        ctx({ id: deal.id })
      );

    // Before any GET the marker is unset.
    const before = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { checklist_seeded_at: true },
    });
    expect(before?.checklist_seeded_at).toBeNull();

    const first = (await (await getChecklist()).json()) as unknown[];
    expect(first.length).toBe(17);

    // The seed set the persistent marker in the same transaction.
    const stamped = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { checklist_seeded_at: true },
    });
    expect(stamped?.checklist_seeded_at).not.toBeNull();

    // A second GET does not duplicate.
    const second = (await (await getChecklist()).json()) as unknown[];
    expect(second.length).toBe(17);
    const count = await prisma.checklist_items.count({
      where: { deal_id: deal.id },
    });
    expect(count).toBe(17);
  });

  it("custom items added after emptying survive; a pre-eligible-stage deal still seeds nothing (#264)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id, stage: "under_contract" });
    const auth = await authHeader("auth0|a", ["agent"]);
    const getChecklist = (dealId: string) =>
      listChecklistRoute(
        new Request(`http://localhost/api/deals/${dealId}/checklist`, {
          headers: { authorization: auth },
        }),
        ctx({ id: dealId })
      );

    // Seed then empty.
    const seeded = (await (await getChecklist(deal.id)).json()) as {
      id: string;
    }[];
    for (const item of seeded) {
      await deleteChecklistRoute(
        new Request(
          `http://localhost/api/deals/${deal.id}/checklist/${item.id}`,
          { method: "DELETE", headers: { authorization: auth } }
        ),
        ctx({ id: deal.id, itemId: item.id })
      );
    }

    // Add one custom item to the emptied list.
    const createRes = await createChecklistRoute(
      new Request(`http://localhost/api/deals/${deal.id}/checklist`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ label: "Custom: wire earnest money" }),
      }),
      ctx({ id: deal.id })
    );
    expect(createRes.status).toBe(200);

    // Subsequent GET returns just the custom item — no defaults resurrected.
    const after = (await (await getChecklist(deal.id)).json()) as {
      label: string;
      is_custom: boolean;
    }[];
    expect(after.length).toBe(1);
    expect(after[0].label).toBe("Custom: wire earnest money");
    expect(after[0].is_custom).toBe(true);

    // A pre-eligible-stage (intake) deal seeds nothing and leaves the marker unset.
    const intakeDeal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
    });
    const intakeItems = (await (
      await getChecklist(intakeDeal.id)
    ).json()) as unknown[];
    expect(intakeItems.length).toBe(0);
    const intakeMarker = await prisma.deals.findUnique({
      where: { id: intakeDeal.id },
      select: { checklist_seeded_at: true },
    });
    expect(intakeMarker?.checklist_seeded_at).toBeNull();
  });
});

describe("Seller checklist seeding (#261)", () => {
  const auth = () => authHeader("auth0|a", ["agent"]);
  const getChecklist = async (dealId: string) =>
    listChecklistRoute(
      new Request(`http://localhost/api/deals/${dealId}/checklist`, {
        headers: { authorization: await auth() },
      }),
      ctx({ id: dealId })
    );

  it("seeds the seller listing-prep defaults for a SELL deal at active_search, exactly once", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      type: "sell",
      stage: "active_search",
    });

    const first = (await (await getChecklist(deal.id)).json()) as {
      assigned_to: string;
      checked: boolean;
      is_custom: boolean;
    }[];
    // The six listing-prep items, all seller-assigned, none pre-checked.
    expect(first.length).toBe(6);
    expect(first.every((i) => i.assigned_to === "seller")).toBe(true);
    expect(first.every((i) => i.checked === false)).toBe(true);
    expect(first.every((i) => i.is_custom === false)).toBe(true);

    // Seeding the seller set must NOT stamp the TC marker (so the TC closing
    // set still seeds independently at under_contract+ — #264 stays intact).
    const marker = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { checklist_seeded_at: true },
    });
    expect(marker?.checklist_seeded_at).toBeNull();

    // Idempotent: a second GET at the same stage does not duplicate.
    const second = (await (await getChecklist(deal.id)).json()) as unknown[];
    expect(second.length).toBe(6);
    const count = await prisma.checklist_items.count({
      where: { deal_id: deal.id },
    });
    expect(count).toBe(6);
  });

  it("does NOT seed listing-prep for a BUY deal at active_search", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      type: "buy",
      stage: "active_search",
    });
    const items = (await (await getChecklist(deal.id)).json()) as unknown[];
    expect(items.length).toBe(0);
  });

  it("still seeds the 17 TC closing defaults for a SELL deal at under_contract (existing behavior)", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      type: "sell",
      stage: "under_contract",
    });
    const items = (await (await getChecklist(deal.id)).json()) as {
      assigned_to: string;
    }[];
    expect(items.length).toBe(17);
    // None of the TC defaults are seller-assigned.
    expect(items.some((i) => i.assigned_to === "seller")).toBe(false);
    const marker = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { checklist_seeded_at: true },
    });
    expect(marker?.checklist_seeded_at).not.toBeNull();
  });

  it("seeds the seller pre-close set for a SELL deal at pre_close alongside the TC set", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      type: "sell",
      stage: "pre_close",
    });
    const items = (await (await getChecklist(deal.id)).json()) as {
      assigned_to: string;
    }[];
    const sellerItems = items.filter((i) => i.assigned_to === "seller");
    // Five seller pre-close items, plus the 17 TC closing defaults.
    expect(sellerItems.length).toBe(5);
    expect(items.length).toBe(22);
  });
});

describe("Contingencies", () => {
  it("agent owner can create, update and delete a contingency", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });

    const createReq = new Request(
      `http://localhost/api/deals/${deal.id}/contingencies`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ label: "Inspection", deadline: "2026-07-01" }),
      }
    );
    const createRes = await createContingencyRoute(createReq, ctx({ id: deal.id }));
    expect(createRes.status).toBe(201);
    const c = (await createRes.json()) as {
      id: string;
      status: string;
      contingency_type: string;
    };
    expect(c.status).toBe("active");
    expect(c.contingency_type).toBe("custom");

    // Patch status to waived
    const patchReq = new Request(
      `http://localhost/api/deals/${deal.id}/contingencies/${c.id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|a", ["agent"]),
        },
        body: JSON.stringify({ status: "waived" }),
      }
    );
    const patchRes = await updateContingencyRoute(
      patchReq,
      ctx({ id: deal.id, contingencyId: c.id })
    );
    const patched = (await patchRes.json()) as { status: string };
    expect(patched.status).toBe("waived");

    // List
    const listReq = new Request(
      `http://localhost/api/deals/${deal.id}/contingencies`,
      { headers: { authorization: await authHeader("auth0|a", ["agent"]) } }
    );
    const listRes = await listContingenciesRoute(listReq, ctx({ id: deal.id }));
    const list = (await listRes.json()) as { id: string }[];
    expect(list.length).toBe(1);

    // Delete
    const delReq = new Request(
      `http://localhost/api/deals/${deal.id}/contingencies/${c.id}`,
      {
        method: "DELETE",
        headers: { authorization: await authHeader("auth0|a", ["agent"]) },
      }
    );
    const delRes = await deleteContingencyRoute(
      delReq,
      ctx({ id: deal.id, contingencyId: c.id })
    );
    expect(delRes.status).toBe(204);
  });

  it("non-owner agent gets 403", async () => {
    const agent = await createUser({ role: "agent" });
    const other = await createUser({ role: "agent", auth0_id: "auth0|o" });
    const deal = await createDeal({ agent_id: agent.id });
    void other;
    const req = new Request(
      `http://localhost/api/deals/${deal.id}/contingencies`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|o", ["agent"]),
        },
        body: JSON.stringify({ label: "x" }),
      }
    );
    const res = await createContingencyRoute(req, ctx({ id: deal.id }));
    expect(res.status).toBe(403);
  });
});

describe("Deal invites", () => {
  it("agent creates an invite, buyer claims it and becomes a participant", async () => {
    const agent = await createUser({
      role: "agent",
      auth0_id: "auth0|agent",
      name: "Agent Smith",
    });
    const deal = await createDeal({ agent_id: agent.id });

    // Create invite as agent
    const createReq = new Request(
      `http://localhost/api/deals/${deal.id}/invite`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|agent", ["agent"]),
        },
        body: JSON.stringify({
          email: "buyer@example.com",
          name: "Bob Buyer",
          role: "buyer",
        }),
      }
    );
    const createRes = await createInviteRoute(createReq, ctx({ id: deal.id }));
    expect(createRes.status).toBe(201);
    const inv = (await createRes.json()) as { token: string };

    // GET /invites/[token] is public
    const lookupReq = new Request(`http://localhost/api/invites/${inv.token}`);
    const lookupRes = await getInviteRoute(lookupReq, ctx({ token: inv.token }));
    expect(lookupRes.status).toBe(200);
    const lookup = (await lookupRes.json()) as {
      agent_name: string;
      deal_title: string;
      claimed: boolean;
    };
    expect(lookup.agent_name).toBe("Agent Smith");
    expect(lookup.claimed).toBe(false);

    // Buyer claims (no role claim in JWT — only sub).
    const claimReq = new Request(
      `http://localhost/api/invites/${inv.token}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|buyer-new", []),
        },
        body: JSON.stringify({
          email: "buyer@example.com",
          name: "Bob Buyer",
        }),
      }
    );
    const claimRes = await claimInviteRoute(claimReq, ctx({ token: inv.token }));
    // Sync requires role; claim provides role from invite, so users.role = buyer
    expect(claimRes.status).toBe(200);
    const claimedUser = (await claimRes.json()) as { id: string; role: string };
    expect(claimedUser.role).toBe("buyer");

    // Buyer is now a participant on the deal
    const participantCount = await prisma.deal_participants.count({
      where: { deal_id: deal.id, user_id: claimedUser.id },
    });
    expect(participantCount).toBe(1);
  });

  it("claim returns 410 for an expired invite", async () => {
    const agent = await createUser({ role: "agent" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email: "old@example.com",
        name: "Old",
        role: "buyer",
        invited_by: agent.id,
        expires_at: new Date(Date.now() - 1000 * 60 * 60),
      },
    });
    const invite = await prisma.deal_invites.findFirst({
      where: { email: "old@example.com" },
    });

    const req = new Request(
      `http://localhost/api/invites/${invite!.token}/claim`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|old-buyer", []),
        },
        body: JSON.stringify({ email: "old@example.com", name: "Old" }),
      }
    );
    const res = await claimInviteRoute(req, ctx({ token: invite!.token }));
    expect(res.status).toBe(410);
  });

  it("/invites/role returns role from users table or open invite, else ''", async () => {
    // The route is now shared-secret gated (#271); the Auth0 Post-Login Action
    // sends the token in the x-invite-role-token header. Set it just for this
    // lookup test and restore env afterward.
    const TOKEN = "test-invite-role-secret";
    process.env.INVITE_ROLE_SECRET = TOKEN;
    resetEnvForTesting();
    const withToken = (email: string) =>
      new Request(`http://localhost/api/invites/role?email=${email}`, {
        headers: { "x-invite-role-token": TOKEN },
      });
    try {
      await createUser({ email: "existing@example.com", role: "admin" });
      const r1 = await getInviteRoleRoute(withToken("existing@example.com"));
      expect((await r1.json()).role).toBe("admin");

      const r2 = await getInviteRoleRoute(withToken("nobody@example.com"));
      expect((await r2.json()).role).toBe("");

      // The middle branch the name promises: no users row, but an OPEN invite
      // addressed to that email resolves to the invited role.
      const agent = await createUser({ role: "agent" });
      const deal = await createDeal({ agent_id: agent.id });
      await prisma.deal_invites.create({
        data: {
          deal_id: deal.id,
          email: "pending@example.com",
          name: "Pending Client",
          role: "seller",
          invited_by: agent.id,
        },
      });
      const r3 = await getInviteRoleRoute(withToken("pending@example.com"));
      expect((await r3.json()).role).toBe("seller");
    } finally {
      delete process.env.INVITE_ROLE_SECRET;
      resetEnvForTesting();
    }
  });

  // The reported bug, end to end across both routes: an invited buyer creates
  // their account, the claim writes `buyer`, and then the very next
  // /users/sync — carrying the tenant's default `agent` claim — used to
  // overwrite it and drop them into the agent app.
  it("a later sync with a default agent claim does not undo the claimed buyer role", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|inviter" });
    const deal = await createDeal({ agent_id: agent.id });
    await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email: "newbuyer@example.com",
        name: "New Buyer",
        role: "buyer",
        invited_by: agent.id,
      },
    });
    const invite = await prisma.deal_invites.findFirstOrThrow({
      where: { email: "newbuyer@example.com" },
    });

    // 1. Brand-new Auth0 identity claims the invite (JWT has no roles yet).
    const claimRes = await claimInviteRoute(
      new Request(`http://localhost/api/invites/${invite.token}/claim`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|new-buyer", []),
        },
        body: JSON.stringify({
          email: "newbuyer@example.com",
          name: "New Buyer",
        }),
      }),
      ctx({ token: invite.token })
    );
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { id: string; role: string };
    expect(claimed.role).toBe("buyer");

    // 2. Any later page load syncs the SAME sub — now with the tenant's
    //    default agent claim baked into the token.
    const syncRes = await syncRoute(
      new Request("http://localhost/api/users/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader("auth0|new-buyer", ["agent"]),
        },
        body: JSON.stringify({
          email: "newbuyer@example.com",
          name: "New Buyer",
        }),
      })
    );
    expect(syncRes.status).toBe(200);
    expect(((await syncRes.json()) as { role: string }).role).toBe("buyer");

    // 3. And they are still on the deal.
    const participantCount = await prisma.deal_participants.count({
      where: { deal_id: deal.id, user_id: claimed.id },
    });
    expect(participantCount).toBe(1);
  });
});

describe("GET /api/me/deals", () => {
  it("returns deals where caller is a participant, including agent contact", async () => {
    const agent = await createUser({
      role: "agent",
      name: "Agent A",
      email: "agent@a.co",
    });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({ agent_id: agent.id, title: "Buyer Deal" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });

    const req = new Request("http://localhost/api/me/deals", {
      headers: { authorization: await authHeader("auth0|b", ["buyer"]) },
    });
    const res = await myDealsRoute(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string; agent_name: string }[];
    expect(body.length).toBe(1);
    expect(body[0].title).toBe("Buyer Deal");
    expect(body[0].agent_name).toBe("Agent A");
  });
});
