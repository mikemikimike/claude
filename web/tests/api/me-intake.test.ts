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
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * #434 — the pre-approval task creation is BEST-EFFORT: a failure there must
 * never fail or roll back the intake write. The only honest way to assert that
 * is to make the insert throw, so the seeder is wrapped here with a flag the
 * one best-effort case flips. Every other test runs the real implementation.
 */
const preApprovalSeed = vi.hoisted(() => ({ shouldThrow: false }));
vi.mock("@/lib/stage-task-seed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stage-task-seed")>();
  return {
    ...actual,
    seedPreApprovalTask: async (dealId: string) => {
      if (preApprovalSeed.shouldThrow) throw new Error("simulated task insert failure");
      return actual.seedPreApprovalTask(dealId);
    },
  };
});

import { POST as postIntake } from "@/app/api/me/intake/route";
import { POST as claimInviteRoute } from "@/app/api/invites/[token]/claim/route";
import { PATCH as advanceStageRoute } from "@/app/api/deals/[id]/stage/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { setEmailForTesting } from "@/lib/email";
import { prisma } from "@/lib/db";
import {
  PRE_APPROVAL_TASK_STAGE,
  PRE_APPROVAL_TASK_TITLE,
  seedPreApprovalTask,
  seedStageAutoTasks,
} from "@/lib/stage-task-seed";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
});

beforeEach(async () => {
  await truncateAll();
  preApprovalSeed.shouldThrow = false;
});

afterAll(() => {
  setEmailForTesting(undefined);
});

/**
 * The shared buyer questionnaire fixture.
 *
 * NOTE (#434): it carries `lenderChoice: "mountain"` and no `cashOrLoan`, which
 * `needsPreApprovalTask` reads as "financed buyer, Mountain Mortgage" — so
 * every #407 test using it now also creates a pre-approval task as a side
 * effect. That is correct behaviour, and none of those tests assert an exact
 * task count, but it means they are incidentally exercising this path too. The
 * #434 block at the bottom of this file asserts the contract explicitly; the
 * `lenderChoice` key stays here because test 12 asserts it never leaks into the
 * /api/me/deals payload.
 */
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

/**
 * Issue #409 — a cash buyer was hard-blocked by the pre-approval offer gate.
 * The questionnaire captured `cashOrLoan`, but nothing carried it onto the
 * deal, so the portal had nothing to gate on except agent-set `pre_approved`.
 */
describe("GET /api/me/deals — exposes the buyer's financing type (#409)", () => {
  async function myDeals(auth0Id: string) {
    const { GET: getMyDeals } = await import("@/app/api/me/deals/route");
    const res = await getMyDeals(
      new Request("http://localhost/api/me/deals", {
        headers: { authorization: await authHeader(auth0Id, ["buyer"]) },
      })
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      id: string;
      financing_type: string | null;
      intake?: unknown;
    }[];
  }

  // Case 1 — fails against the pre-#409 code: nothing mapped the answer onto
  // the deal, so the portal could not tell a cash buyer from a financed one.
  it("10. a 'cash' onboarding answer surfaces as financing_type='cash'", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "cash",
    });

    const before = await myDeals("auth0|client-cash");
    expect(before.find((r) => r.id === deal.id)?.financing_type).toBeNull();

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...BUYER_ANSWERS, cashOrLoan: "cash" },
        },
        await authHeader("auth0|client-cash", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const after = await myDeals("auth0|client-cash");
    expect(after.find((r) => r.id === deal.id)?.financing_type).toBe("cash");
  });

  it("11. a 'loan' onboarding answer surfaces as financing_type='loan'", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "loan",
    });

    await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...BUYER_ANSWERS, cashOrLoan: "loan" },
        },
        await authHeader("auth0|client-loan", ["buyer"])
      )
    );

    const rows = await myDeals("auth0|client-loan");
    expect(rows.find((r) => r.id === deal.id)?.financing_type).toBe("loan");
  });

  it("12. keeps the raw questionnaire answers out of the portal payload", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "noleak",
    });

    await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...BUYER_ANSWERS, cashOrLoan: "cash" },
        },
        await authHeader("auth0|client-noleak", ["buyer"])
      )
    );

    const rows = await myDeals("auth0|client-noleak");
    const row = rows.find((r) => r.id === deal.id);
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("intake");
    // The answers are read through GET /api/deals/[id]/intake, never here.
    expect(JSON.stringify(row)).not.toContain("lenderChoice");
  });
});

/**
 * Issue #434 — the pre-approval task.
 *
 * A buyer who picks Mountain Mortgage (or Fast Pass) is thrown out to the
 * external 1003 application mid-questionnaire today, losing everything they
 * typed; a buyer who ignores that link is never asked again. The fix moves the
 * ask onto the dashboard, and this is the server half: finishing onboarding
 * creates a real `tasks` row so there is something waiting for them (#435
 * renders it).
 *
 * Contract asserted here:
 *   - exactly ONE task, `role='buyer'`, `priority='high'`, `source='ai'`,
 *     `stage_context='active_search'`,
 *   - only for `lenderChoice` mountain | fastpass — never cash, never an
 *     outside lender, never a deal already `pre_approved`,
 *   - idempotent across re-submits, and best-effort: a failure creating it
 *     cannot fail or roll back the intake write,
 *   - both intake write paths get it (POST /api/me/intake and the invite
 *     claim's ride-along intake).
 */
describe("pre-approval task on onboarding (#434)", () => {
  /** The pre-approval task rows on a deal, whatever else was seeded alongside. */
  function preApprovalTasks(dealId: string) {
    return prisma.tasks.findMany({
      where: { deal_id: dealId, title: PRE_APPROVAL_TASK_TITLE },
      select: {
        id: true,
        title: true,
        role: true,
        priority: true,
        source: true,
        stage_context: true,
        status: true,
        due_date: true,
      },
    });
  }

  const MOUNTAIN = { ...BUYER_ANSWERS, cashOrLoan: "loan", lenderChoice: "mountain" };

  // Case 1 — fails against the pre-#434 code: nothing created a task at all.
  it("13. a Mountain Mortgage buyer gets exactly one high-priority client task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "mtn",
    });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: MOUNTAIN },
        await authHeader("auth0|client-mtn", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const tasks = await preApprovalTasks(deal.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].role).toBe("buyer");
    expect(tasks[0].priority).toBe("high");
    expect(tasks[0].source).toBe("ai");
    expect(tasks[0].stage_context).toBe(PRE_APPROVAL_TASK_STAGE);
    expect(tasks[0].status).toBe("pending");
    // A due date, so the overdue/health/calendar machinery has real data —
    // same treatment every other auto-task gets (#187).
    expect(tasks[0].due_date).not.toBeNull();
  });

  // Case 2 — Fast Pass is Mountain Mortgage wrapped in the concierge service.
  it("14. a Fast Pass buyer gets the same task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "fp",
    });

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...MOUNTAIN, lenderChoice: "fastpass" },
        },
        await authHeader("auth0|client-fp", ["buyer"])
      )
    );
    expect(res.status).toBe(200);
    expect(await preApprovalTasks(deal.id)).toHaveLength(1);
  });

  // Case 3 — a cash buyer has nothing to get pre-approved for, and a stray
  // high-priority task would hold their deal at Property Search.
  it("15. a cash buyer gets no pre-approval task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "cashbuyer",
    });

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...MOUNTAIN, cashOrLoan: "cash" },
        },
        await authHeader("auth0|client-cashbuyer", ["buyer"])
      )
    );
    expect(res.status).toBe(200);
    expect(await preApprovalTasks(deal.id)).toHaveLength(0);
  });

  // Case 4 — an outside lender's pre-approval is not ours to chase.
  it("16. an outside-lender buyer gets no pre-approval task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "otherlender",
    });

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "buyer",
          answers: { ...MOUNTAIN, lenderChoice: "other" },
        },
        await authHeader("auth0|client-otherlender", ["buyer"])
      )
    );
    expect(res.status).toBe(200);
    expect(await preApprovalTasks(deal.id)).toHaveLength(0);
  });

  // Case 5 — idempotency. The onboarding wizard can be re-run, and the client
  // portal re-posts the intake after a claim, so this path IS re-entered.
  it("17. re-submitting the intake never creates a second task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "again",
    });
    const auth = await authHeader("auth0|client-again", ["buyer"]);

    expect(
      (await postIntake(intakeReq({ deal_id: deal.id, role: "buyer", answers: MOUNTAIN }, auth)))
        .status
    ).toBe(200);
    expect(
      (
        await postIntake(
          intakeReq(
            { deal_id: deal.id, role: "buyer", answers: { ...MOUNTAIN, bedrooms: "4" } },
            auth
          )
        )
      ).status
    ).toBe(200);

    expect(await preApprovalTasks(deal.id)).toHaveLength(1);
  });

  // Case 6 — the agent already has the letter; don't ask for it again.
  it("18. an already pre-approved deal gets no task", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "preapp",
    });
    await prisma.deals.update({
      where: { id: deal.id },
      data: { pre_approved: true },
    });

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: MOUNTAIN },
        await authHeader("auth0|client-preapp", ["buyer"])
      )
    );
    expect(res.status).toBe(200);
    expect(await preApprovalTasks(deal.id)).toHaveLength(0);
  });

  // Case 7 — best-effort. A missing task is recoverable; a lost onboarding is
  // not, so the task creation must sit OUTSIDE the intake's transaction.
  it("19. a failing task insert still writes the intake and still returns 200", async () => {
    const { deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "boom",
    });
    preApprovalSeed.shouldThrow = true;

    const res = await postIntake(
      intakeReq(
        { deal_id: deal.id, role: "buyer", answers: MOUNTAIN },
        await authHeader("auth0|client-boom", ["buyer"])
      )
    );
    expect(res.status).toBe(200);

    const row = await prisma.deals.findUnique({
      where: { id: deal.id },
      select: { stage: true, intake: true },
    });
    const stored = row?.intake as { answers: Record<string, unknown> };
    expect(stored.answers).toMatchObject(MOUNTAIN);
    // The #407 advance is committed too — the failure is contained to the task.
    expect(row?.stage).toBe("active_search");
    expect(await preApprovalTasks(deal.id)).toHaveLength(0);
  });

  it("20. a seller intake never gets one, even naming Mountain Mortgage", async () => {
    const { deal } = await seedClientOnDeal({
      role: "seller",
      dealType: "sell",
      suffix: "sellerlender",
    });

    const res = await postIntake(
      intakeReq(
        {
          deal_id: deal.id,
          role: "seller",
          answers: { address: "9 Elm St", lenderChoice: "mountain" },
        },
        await authHeader("auth0|client-sellerlender", ["seller"])
      )
    );
    expect(res.status).toBe(200);
    expect(await preApprovalTasks(deal.id)).toHaveLength(0);
  });

  it("21. the invite-claim ride-along intake creates it too", async () => {
    setEmailForTesting({
      emails: { send: async () => ({ data: { id: "email_test" }, error: null }) },
    } as never);

    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent-claim434" });
    const deal = await createDeal({ agent_id: agent.id, stage: "intake", type: "buy" });
    const invite = await prisma.deal_invites.create({
      data: {
        deal_id: deal.id,
        email: "mtnbuyer@example.com",
        name: "Molly Mountain",
        role: "buyer",
        invited_by: agent.id,
      },
    });

    const req = new Request(`http://localhost/api/invites/${invite.token}/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader("auth0|claim-434", []),
      },
      body: JSON.stringify({
        email: "mtnbuyer@example.com",
        name: "Molly Mountain",
        intake: { role: "buyer", answers: MOUNTAIN },
      }),
    });
    const res = await claimInviteRoute(req, {
      params: Promise.resolve({ token: invite.token }),
    });
    expect(res.status).toBe(200);

    const tasks = await preApprovalTasks(deal.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].role).toBe("buyer");
  });

  /**
   * The consequence Paul signed off on: an unresolved pre-approval HOLDS the
   * deal at Property Search. #445 narrowed the forward-advance gate to exempt
   * `source='ai'` tasks that predate the deal's last departure from the stage —
   * on a FIRST departure there is no such history row, so nothing is exempt and
   * this task gates. The agent can complete it or force through.
   */
  it("22. an open pre-approval task gates the first advance out of active_search", async () => {
    const { agent, deal } = await seedClientOnDeal({
      role: "buyer",
      dealType: "buy",
      suffix: "gate",
    });

    expect(
      (
        await postIntake(
          intakeReq(
            { deal_id: deal.id, role: "buyer", answers: MOUNTAIN },
            await authHeader("auth0|client-gate", ["buyer"])
          )
        )
      ).status
    ).toBe(200);

    // Clear every OTHER high-priority blocker (the stage's own auto-tasks) so
    // the 422 below can only be about the pre-approval task.
    await prisma.tasks.updateMany({
      where: { deal_id: deal.id, title: { not: PRE_APPROVAL_TASK_TITLE } },
      data: { status: "completed" },
    });

    const res = await advanceStageRoute(
      new Request(`http://localhost/api/deals/${deal.id}/stage`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: await authHeader(agent.auth0_id, ["agent"]),
        },
        body: JSON.stringify({ stage: "offer_active" }),
      }),
      { params: Promise.resolve({ id: deal.id }) }
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      gate: boolean;
      blocking_tasks: { title: string; source: string }[];
    };
    expect(body.gate).toBe(true);
    expect(body.blocking_tasks.map((t) => t.title)).toEqual([PRE_APPROVAL_TASK_TITLE]);
    expect(body.blocking_tasks[0].source).toBe("ai");
  });

  /**
   * Guard-rail on the shared seeder. `seedStageAutoTasks` no-ops when the deal
   * already has ANY `source='ai'` task for the stage, so a pre-approval task
   * sitting there first would silently swallow the agent's three active_search
   * auto-tasks. The seeder ignores this one title for exactly that reason.
   */
  it("23. a pre-approval task present first does not suppress the stage auto-tasks", async () => {
    const agent = await createUser({ role: "agent", auth0_id: "auth0|agent-seedorder" });
    const deal = await createDeal({
      agent_id: agent.id,
      stage: "intake",
      type: "buy",
      title: "Ordering Test",
    });

    await seedPreApprovalTask(deal.id);
    expect(await preApprovalTasks(deal.id)).toHaveLength(1);

    await seedStageAutoTasks(deal.id, "active_search", { type: "buy", clientName: "Ordering Test" });

    const seeded = await prisma.tasks.findMany({
      where: {
        deal_id: deal.id,
        source: "ai",
        stage_context: "active_search",
        title: { not: PRE_APPROVAL_TASK_TITLE },
      },
      select: { title: true },
    });
    expect(seeded).toHaveLength(3);
    expect(seeded.some((t) => /pre-approval checklist/i.test(t.title))).toBe(true);
  });
});
