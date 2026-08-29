/**
 * Per-item inspection follow-up tracking (#429, slices a+b).
 *
 * Access rules deliberately differ from the checklist's single gate: the
 * checklist lets any participant tick items, but inspection items are the
 * agent's record of what they are chasing on the buyer's behalf. The buyer
 * (a participant) READS them; only the deal's agent, their linked TC, and
 * admins write. Anyone else must not learn the deal exists — 404, not 403.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import {
  GET as listItemsRoute,
  POST as createItemRoute,
} from "@/app/api/deals/[id]/inspection-items/route";
import {
  PATCH as updateItemRoute,
  DELETE as deleteItemRoute,
} from "@/app/api/deals/[id]/inspection-items/[itemId]/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
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

type ApiItem = {
  id: string;
  deal_id: string;
  document_id: string | null;
  sort_order: number;
  category: string;
  description: string;
  severity: string;
  status: string;
  owner: string;
  notes: string | null;
  resolved_at: string | null;
};

function listReq(dealId: string, auth: string) {
  return new Request(`http://localhost/api/deals/${dealId}/inspection-items`, {
    headers: { authorization: auth },
  });
}

function createReq(dealId: string, auth: string, body: unknown) {
  return new Request(`http://localhost/api/deals/${dealId}/inspection-items`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

function patchReq(dealId: string, itemId: string, auth: string, body: unknown) {
  return new Request(
    `http://localhost/api/deals/${dealId}/inspection-items/${itemId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    }
  );
}

function deleteReq(dealId: string, itemId: string, auth: string) {
  return new Request(
    `http://localhost/api/deals/${dealId}/inspection-items/${itemId}`,
    { method: "DELETE", headers: { authorization: auth } }
  );
}

describe("Inspection items — agent CRUD (case 1)", () => {
  it("agent can create items on their deal and list them back in entry order", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "under_contract",
    });
    const auth = await authHeader("auth0|a", ["agent"]);

    const first = await createItemRoute(
      createReq(deal.id, auth, {
        category: "Roof",
        description: "Cracked flashing above the chimney",
        severity: "major",
        owner: "seller",
      }),
      ctx({ id: deal.id })
    );
    expect(first.status).toBe(200);
    const firstItem = (await first.json()) as ApiItem;
    expect(firstItem.description).toBe("Cracked flashing above the chimney");
    expect(firstItem.severity).toBe("major");
    expect(firstItem.status).toBe("open");
    expect(firstItem.sort_order).toBe(0);
    expect(firstItem.resolved_at).toBeNull();

    const second = await createItemRoute(
      createReq(deal.id, auth, { description: "GFCI outlet missing in kitchen" }),
      ctx({ id: deal.id })
    );
    expect(second.status).toBe(200);
    const secondItem = (await second.json()) as ApiItem;
    // Defaults, and an appended sort_order so report order is preserved.
    expect(secondItem.category).toBe("General");
    expect(secondItem.severity).toBe("moderate");
    expect(secondItem.owner).toBe("seller");
    expect(secondItem.sort_order).toBe(1);

    const listed = await listItemsRoute(
      listReq(deal.id, auth),
      ctx({ id: deal.id })
    );
    expect(listed.status).toBe(200);
    const items = (await listed.json()) as ApiItem[];
    expect(items.map((i) => i.description)).toEqual([
      "Cracked flashing above the chimney",
      "GFCI outlet missing in kitchen",
    ]);
  });

  it("rejects a create with no description", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);

    const res = await createItemRoute(
      createReq(deal.id, auth, { category: "Roof", description: "   " }),
      ctx({ id: deal.id })
    );
    expect(res.status).toBe(400);
    expect(await prisma.deal_inspection_items.count()).toBe(0);
  });

  it("rejects an unknown severity / status / owner value", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);

    const res = await createItemRoute(
      createReq(deal.id, auth, {
        description: "Something",
        severity: "catastrophic",
      }),
      ctx({ id: deal.id })
    );
    expect(res.status).toBe(400);

    const created = await createItemRoute(
      createReq(deal.id, auth, { description: "Something" }),
      ctx({ id: deal.id })
    );
    const item = (await created.json()) as ApiItem;
    const bad = await updateItemRoute(
      patchReq(deal.id, item.id, auth, { status: "mostly_done" }),
      ctx({ id: deal.id, itemId: item.id })
    );
    expect(bad.status).toBe(400);
  });

  it("stamps resolved_at on close-out and clears it on reopen", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);

    const created = await createItemRoute(
      createReq(deal.id, auth, { description: "Loose stair railing" }),
      ctx({ id: deal.id })
    );
    const item = (await created.json()) as ApiItem;

    const resolved = await updateItemRoute(
      patchReq(deal.id, item.id, auth, {
        status: "resolved",
        notes: "Handyman re-anchored the post",
      }),
      ctx({ id: deal.id, itemId: item.id })
    );
    expect(resolved.status).toBe(200);
    const resolvedItem = (await resolved.json()) as ApiItem;
    expect(resolvedItem.status).toBe("resolved");
    expect(resolvedItem.resolved_at).not.toBeNull();
    expect(resolvedItem.notes).toBe("Handyman re-anchored the post");

    // 'waived' is terminal too — an item dropped for a credit is closed out.
    const waived = await updateItemRoute(
      patchReq(deal.id, item.id, auth, { status: "waived" }),
      ctx({ id: deal.id, itemId: item.id })
    );
    const waivedItem = (await waived.json()) as ApiItem;
    expect(waivedItem.resolved_at).not.toBeNull();

    const reopened = await updateItemRoute(
      patchReq(deal.id, item.id, auth, { status: "requested" }),
      ctx({ id: deal.id, itemId: item.id })
    );
    const reopenedItem = (await reopened.json()) as ApiItem;
    expect(reopenedItem.status).toBe("requested");
    expect(reopenedItem.resolved_at).toBeNull();
  });

  it("agent can delete an item, and cannot patch one belonging to another deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const dealA = await createDeal({ agent_id: agent.id });
    const dealB = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);

    const created = await createItemRoute(
      createReq(dealA.id, auth, { description: "Furnace filter" }),
      ctx({ id: dealA.id })
    );
    const item = (await created.json()) as ApiItem;

    // Same agent, wrong deal in the path: the item must not be reachable.
    const crossDeal = await updateItemRoute(
      patchReq(dealB.id, item.id, auth, { status: "resolved" }),
      ctx({ id: dealB.id, itemId: item.id })
    );
    expect(crossDeal.status).toBe(404);
    const untouched = await prisma.deal_inspection_items.findUnique({
      where: { id: item.id },
    });
    expect(untouched?.status).toBe("open");

    const del = await deleteItemRoute(
      deleteReq(dealA.id, item.id, auth),
      ctx({ id: dealA.id, itemId: item.id })
    );
    expect(del.status).toBe(200);
    expect(await prisma.deal_inspection_items.count()).toBe(0);
  });

  it("links an item to the source inspection report document", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);
    const doc = await prisma.documents.create({
      data: {
        deal_id: deal.id,
        uploaded_by: agent.id,
        name: "Inspection Report.pdf",
        s3_key: `deals/${deal.id}/inspection.pdf`,
      },
      select: { id: true },
    });

    const res = await createItemRoute(
      createReq(deal.id, auth, {
        description: "Water staining in the basement",
        document_id: doc.id,
      }),
      ctx({ id: deal.id })
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as ApiItem).document_id).toBe(doc.id);
  });

  it("rejects a document_id belonging to a different deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const dealA = await createDeal({ agent_id: agent.id });
    const dealB = await createDeal({ agent_id: agent.id });
    const auth = await authHeader("auth0|a", ["agent"]);
    const doc = await prisma.documents.create({
      data: {
        deal_id: dealB.id,
        uploaded_by: agent.id,
        name: "Other deal report.pdf",
        s3_key: `deals/${dealB.id}/inspection.pdf`,
      },
      select: { id: true },
    });

    const res = await createItemRoute(
      createReq(dealA.id, auth, {
        description: "Water staining",
        document_id: doc.id,
      }),
      ctx({ id: dealA.id })
    );
    expect(res.status).toBe(400);
  });
});

describe("Inspection items — buyer is read-only (case 2)", () => {
  it("a buyer participant can list items but cannot create, patch, or delete", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|b" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "under_contract",
    });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    const agentAuth = await authHeader("auth0|a", ["agent"]);
    const buyerAuth = await authHeader("auth0|b", ["buyer"]);

    const created = await createItemRoute(
      createReq(deal.id, agentAuth, { description: "Attic insulation thin" }),
      ctx({ id: deal.id })
    );
    const item = (await created.json()) as ApiItem;

    // Read: allowed.
    const listed = await listItemsRoute(
      listReq(deal.id, buyerAuth),
      ctx({ id: deal.id })
    );
    expect(listed.status).toBe(200);
    const items = (await listed.json()) as ApiItem[];
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Attic insulation thin");

    // Write: refused. 403, not 404 — the buyer legitimately sees this deal.
    const create = await createItemRoute(
      createReq(deal.id, buyerAuth, { description: "I want a new roof" }),
      ctx({ id: deal.id })
    );
    expect(create.status).toBe(403);

    const patch = await updateItemRoute(
      patchReq(deal.id, item.id, buyerAuth, { status: "resolved" }),
      ctx({ id: deal.id, itemId: item.id })
    );
    expect(patch.status).toBe(403);

    const del = await deleteItemRoute(
      deleteReq(deal.id, item.id, buyerAuth),
      ctx({ id: deal.id, itemId: item.id })
    );
    expect(del.status).toBe(403);

    // Nothing the buyer sent changed the data.
    const rows = await prisma.deal_inspection_items.findMany({
      where: { deal_id: deal.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("open");
  });
});

describe("Inspection items — scoping (case 3)", () => {
  it("a non-participant gets 404 on every verb", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "agent", auth0_id: "auth0|stranger" });
    const deal = await createDeal({ agent_id: agent.id });
    const agentAuth = await authHeader("auth0|a", ["agent"]);
    const strangerAuth = await authHeader("auth0|stranger", ["agent"]);

    const created = await createItemRoute(
      createReq(deal.id, agentAuth, { description: "Sump pump inoperable" }),
      ctx({ id: deal.id })
    );
    const item = (await created.json()) as ApiItem;

    for (const res of [
      await listItemsRoute(listReq(deal.id, strangerAuth), ctx({ id: deal.id })),
      await createItemRoute(
        createReq(deal.id, strangerAuth, { description: "nope" }),
        ctx({ id: deal.id })
      ),
      await updateItemRoute(
        patchReq(deal.id, item.id, strangerAuth, { status: "resolved" }),
        ctx({ id: deal.id, itemId: item.id })
      ),
      await deleteItemRoute(
        deleteReq(deal.id, item.id, strangerAuth),
        ctx({ id: deal.id, itemId: item.id })
      ),
    ]) {
      expect(res.status).toBe(404);
    }

    expect(await prisma.deal_inspection_items.count()).toBe(1);
  });

  it("an unauthenticated request is rejected", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const deal = await createDeal({ agent_id: agent.id });
    const res = await listItemsRoute(
      new Request(`http://localhost/api/deals/${deal.id}/inspection-items`),
      ctx({ id: deal.id })
    );
    expect(res.status).toBe(401);
  });

  it("a TC linked to the deal's agent can write; an unlinked TC gets 404", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    const linkedTc = await createUser({ role: "tc", auth0_id: "auth0|tc1" });
    await createUser({ role: "tc", auth0_id: "auth0|tc2" });
    await prisma.users.update({
      where: { id: agent.id },
      data: { tc_user_id: linkedTc.id },
    });
    const deal = await createDeal({ agent_id: agent.id });

    const linked = await createItemRoute(
      createReq(deal.id, await authHeader("auth0|tc1", ["tc"]), {
        description: "Deck joist hangers missing",
      }),
      ctx({ id: deal.id })
    );
    expect(linked.status).toBe(200);

    const unlinked = await createItemRoute(
      createReq(deal.id, await authHeader("auth0|tc2", ["tc"]), {
        description: "not my deal",
      }),
      ctx({ id: deal.id })
    );
    expect(unlinked.status).toBe(404);
  });

  it("an admin can write on any deal", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|a" });
    await createUser({ role: "admin", auth0_id: "auth0|admin" });
    const deal = await createDeal({ agent_id: agent.id });

    const res = await createItemRoute(
      createReq(deal.id, await authHeader("auth0|admin", ["admin"]), {
        description: "Radon test recommended",
      }),
      ctx({ id: deal.id })
    );
    expect(res.status).toBe(200);
  });
});
