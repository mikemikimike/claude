/**
 * Issue #407 — completing onboarding must move the deal off `intake`.
 *
 * Before this, submitting the questionnaire only wrote `deals.intake`. The
 * deal stayed in `intake` forever, so the client portal kept rendering the
 * "Begin my onboarding" card and the only escape was the agent advancing the
 * stage by hand.
 *
 * The advance lives in the intake WRITE path (lib/intake.ts →
 * applyIntakeToDeal), not in PATCH /api/deals/[id]/stage — that route is
 * agent-owner-only, so a client calling it 404s. Both write paths
 * (POST /api/me/intake and the intake that rides along with the invite claim)
 * therefore get it.
 *
 * Invariants asserted here:
 *   - stage moves intake → active_search,
 *   - exactly ONE deal_stage_history row, from_stage='intake', changed_by =
 *     the submitting client (CLAUDE.md: never change a stage without one),
 *   - a deal already past intake is untouched (no retreat, no history row),
 *   - `deals.intake` is still written correctly in every case,
 *   - the stage's auto-tasks are seeded, same as an agent-driven advance.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { POST as postIntake } from "@/app/api/me/intake/route";
import { POST as claimInviteRoute } from "@/app/api/invites/[token]/claim/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
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

afterAll(() => {
  setEmailForTesting(undefined);
});

const BUYER_ANSWERS = {
  firstTimeBuyer: "yes",
  bedrooms: "3",
  areas: "Hoover, Vestavia Hills",
  minBudget: 250000,
  maxBudget: 425000,
  lenderChoice: "mountain",
};

function intakeReq(body: unknown, auth: string) {
  return new Request("http://localhost/api/me/intake", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify(body),
  });
}

async function seedClientOnDeal(opts: {
  role: "buyer" | "seller";
  dealType: "buy" | "sell";
  stage?: "intake" | "active_search" | "under_contract";
  suffix?: string;
}) {
  const sfx = opts.suffix ?? opts.role;
  const agent = await createUser({ role: "agent", auth0_id: `auth0|agent-${sfx}` });
  const deal = await createDeal({
    agent_id: agent.id,
    type: opts.dealType,
    stage: opts.stage ?? "intake",
  });
  const client = await createUser({ role: opts.role, auth0_id: `auth0|client-${sfx}` });
  await prisma.deal_participants.create({
    data: { deal_id: deal.id, user_id: client.id, role: opts.role },
  });
  return { agent, deal, client };
}

describe("POST /api/me/intake — advances the deal off intake (#407)", () => {
  // Case 1 — fails against the pre-#407 code: the deal stayed in `intake`.
  it("1. a buyer intake on an `intake` deal advances it to active_search", async () => {
    const { deal, client } = await seedClientOnDeal({ role: "buyer", dealType: "buy" });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS },
        await authHeader("auth0|client-buyer", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    expect(row?.stage).not.toBe("intake");
    expect(row?.stage).toBe("active_search");

    // Case 4 — no regression on the intake JSON itself.
    const stored = row?.intake as { role: string; answers: Record<string, unknown> };
    expect(stored.role).toBe("buyer");
    expect(stored.answers).toMatchObject(BUYER_ANSWERS);
    expect(client.id).toBeTruthy();
  });

  // Case 2 — fails against the pre-#407 code: no history row was written.
  it("2. writes exactly one deal_stage_history row attributed to the submitting client", async () => {
    const { deal, client } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "hist",
    });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS },
        await authHeader("auth0|client-hist", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
      select: { from_stage: true, to_stage: true, changed_by: true },
    });
    expect(history).toHaveLength(1);
    expect(history[0].from_stage).toBe("intake");
    expect(history[0].to_stage).toBe("active_search");
    expect(history[0].changed_by).toBe(client.id);
  });

  it("3. a seller intake advances the sell deal too (and still writes the address)", async () => {
    const { deal } = await seedClientOnDeal({ role: "seller", dealType: "sell" });

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "seller",
          answers: { address: "123 Oak Lane, Birmingham, AL", desiredListDate: "ASAP" },
        },
        await authHeader("auth0|client-seller", ["seller"])
      )
    );
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, address: true, intake: true },
    });
    expect(row?.stage).toBe("active_search");
    expect(row?.address).toBe("123 Oak Lane, Birmingham, AL");
    expect(row?.intake).toBeTruthy();
  });

  // Case 3 — idempotent / no retreat.
  it("4. an intake on a deal already past intake changes nothing and writes no history", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      stage: "under_contract",
      suffix: "past",
    });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS },
        await authHeader("auth0|client-past", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    expect(row?.stage).toBe("under_contract");
    // Case 4 — the intake JSON is still written.
    const stored = row?.intake as { answers: Record<string, unknown> };
    expect(stored.answers).toMatchObject(BUYER_ANSWERS);

    const history = await prisma.deal_stage_history.count({ where: { deal_id: deal.id } });
    expect(history).toBe(0);
  });

  it("5. re-submitting an intake does not advance a second time or add a second history row", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "twice",
    });
    const auth = await authHeader("auth0|client-twice", ["buyer"]);

    const first = await postIntake(
      intakeReq({ deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS }, auth)
    );
    expect(first.status).toBe(200);
    const second = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: { ...BUYER_ANSWERS, bedrooms: "4" } },
        auth
      )
    );
    expect(second.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    expect(row?.stage).toBe("active_search");
    // The latest answers win — the re-submit is still persisted.
    const stored = row?.intake as { answers: Record<string, unknown> };
    expect(stored.answers.bedrooms).toBe("4");

    const history = await prisma.deal_stage_history.count({ where: { deal_id: deal.id } });
    expect(history).toBe(1);
  });

  it("6. seeds the active_search auto-tasks, same as an agent-driven advance", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "tasks",
    });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS },
        await authHeader("auth0|client-tasks", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const tasks = await prisma.tasks.findMany({
      where: { deal_id: deal.id, source: "ai", stage_context: "active_search" },
      select: { title: true },
    });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.some((t) => /pre-approval checklist/i.test(t.title))).toBe(true);
  });
});

describe("POST /api/invites/[token]/claim — the ride-along intake advances too (#407)", () => {
  it("7. a claim carrying an intake advances the invite's deal and logs the history row", async () => {
    setEmailForTesting({
      emails: { send: async () => ({ data: { id: "email_test" }, error: null }) },
    } as never);

    const agent = await createUser({ role: "agent", auth0_id: "auth0|inviting-agent" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const invite = await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email: "buyer@example.com",
        name: "Bob Buyer",
        role: "buyer",
        invited_by: agent.id,
      },
    });

    const req = new Request(`http://localhost/api/invites/${invite.token}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|new-buyer", []),
      },
      body: JSON.stringify({
        email: "buyer@example.com",
        name: "Bob Buyer",
        intake: { role: "buyer", answers: BUYER_ANSWERS },
      }),
    });
    const res = await claimInviteRoute(req, { params: Promise.resolve({ token: invite.token }) });
    expect(res.status).toBe(200);
    const claimed = (await res.json()) as { id: string };

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    expect(row?.stage).toBe("active_search");
    expect(row?.intake).toBeTruthy();

    const history = await prisma.deal_stage_history.findMany({
      where: { deal_id: deal.id },
      select: { from_stage: true, to_stage: true, changed_by: true },
    });
    expect(history).toHaveLength(1);
    expect(history[0].from_stage).toBe("intake");
    expect(history[0].to_stage).toBe("active_search");
    expect(history[0].changed_by).toBe(claimed.id);
  });

  it("8. a claim WITHOUT an intake leaves the deal in intake (back-compat)", async () => {
    setEmailForTesting({
      emails: { send: async () => ({ data: { id: "email_test" }, error: null }) },
    } as never);

    const agent = await createUser({ role: "agent", auth0_id: "auth0|inviting-agent-2" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake" });
    const invite = await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email: "nointake@example.com",
        name: "Nina New",
        role: "buyer",
        invited_by: agent.id,
      },
    });

    const req = new Request(`http://localhost/api/invites/${invite.token}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|no-intake", []),
      },
      body: JSON.stringify({ email: "nointake@example.com", name: "Nina New" }),
    });
    const res = await claimInviteRoute(req, { params: Promise.resolve({ token: invite.token }) });
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    expect(row?.stage).toBe("intake");
    expect(row?.intake).toBeNull();
    const history = await prisma.deal_stage_history.count({ where: { deal_id: deal.id } });
    expect(history).toBe(0);
  });
});

describe("GET /api/me/deals — exposes the intake-submitted signal (#407)", () => {
  it("9. reports intake_submitted so the portal can stop asking for onboarding", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      stage: "under_contract",
      suffix: "flag",
    });
    const { GET: getMyDeals } = await import("@/app/api/me/deals/route");

    const before = await getMyDeals(
      new Request("http://localhost/api/me/deals", {
        headers: { authorization: await authHeader("auth0|client-flag", ["buyer"]) },
      })
    );
    expect(before.status).toBe(200);
    const beforeRows = (await before.json()) as { id: string; intake_submitted: boolean }[];
    expect(beforeRows.find((r) => r.id === deal.id)?.intake_submitted).toBe(false);

    await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: BUYER_ANSWERS },
        await authHeader("auth0|client-flag", ["buyer"])
      )
    );

    const after = await getMyDeals(
      new Request("http://localhost/api/me/deals", {
        headers: { authorization: await authHeader("auth0|client-flag", ["buyer"]) },
      })
    );
    const afterRows = (await after.json()) as { id: string; intake_submitted: boolean }[];
    expect(afterRows.find((r) => r.id === deal.id)?.intake_submitted).toBe(true);
  });
});
