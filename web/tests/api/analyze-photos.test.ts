import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { POST as analyzeRoute } from "@/app/api/deals/[id]/properties/[propId]/analyze-photos/route";
import { GET as listPropsRoute } from "@/app/api/deals/[id]/properties/route";
import { setVerifyOptionsForTesting } from "@/lib/auth";
import { resetEnvForTesting } from "@/lib/env";
import {
  setPhotoAnalyzerForTesting,
  MAX_PHOTOS,
  PHOTO_ANALYSIS_MODEL,
  PhotoAnalysisNotConfiguredError,
  type AnalysisRequest,
} from "@/lib/photo-analysis";
import { prisma } from "@/lib/db";
import { authHeader, getTestSigner } from "../helpers/jwt";
import { truncateAll } from "../helpers/db";
import { createUser, createDeal } from "../helpers/factories";

/** Flip the #377 cost gate on/off for a test, honoring the env cache. */
function setPhotoAiEnabled(on: boolean) {
  if (on) process.env.PROPERTY_PHOTO_AI_ENABLED = "true";
  else delete process.env.PROPERTY_PHOTO_AI_ENABLED;
  resetEnvForTesting();
}

beforeAll(async () => {
  const { verifyOpts } = await getTestSigner();
  setVerifyOptionsForTesting(verifyOpts);
  // The feature is disabled by default (#377); these tests exercise it enabled.
  setPhotoAiEnabled(true);
});

afterAll(() => setPhotoAiEnabled(false));

beforeEach(async () => {
  await truncateAll();
  setPhotoAiEnabled(true);
});

afterEach(() => setPhotoAnalyzerForTesting(undefined));

/** Fake analyzer — records the request it saw, returns a fixed structured reply. */
function fakeAnalyzer(seen?: AnalysisRequest[]) {
  setPhotoAnalyzerForTesting(async (req) => {
    seen?.push(req);
    const images = (req.messages[0].content as Array<{ type: string }>).filter(
      (b) => b.type === "image"
    ).length;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            condition: "good",
            features: ["hardwood floors"],
            flags: ["dated bathroom"],
            summary: `saw ${images} photos`,
          }),
        },
      ],
    };
  });
}

function propCtx(id: string, propId: string) {
  return { params: Promise.resolve({ id, propId }) };
}
function dealCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function analyze(
  dealId: string,
  propId: string,
  auth0: string,
  body: object | undefined,
  roles: string[] = ["agent"]
): Promise<Response> {
  const req = new Request(
    `http://localhost/api/deals/${dealId}/properties/${propId}/analyze-photos`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: await authHeader(auth0, roles),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }
  );
  return analyzeRoute(req, propCtx(dealId, propId));
}

async function seedProperty(opts: { thumbnail?: string } = {}) {
  const agent = await createUser({ role: "agent", auth0_id: "auth0|agentA" });
  const deal = await createDeal({ agent_id: agent.id, type: "buy" });
  const property = await prisma.tracked_properties.create({
    data: {
      deal_id: deal.id,
      address: "500 Subject Ln",
      city: "Hoover",
      state: "AL",
      beds: 3,
      baths: 2,
      sqft: 2000,
      thumbnail_url: opts.thumbnail ?? "",
    },
  });
  return { agent, deal, property };
}

describe("POST analyze-photos — happy path", () => {
  it("analyzes the supplied photos and stores the result on the property", async () => {
    const { deal, property } = await seedProperty();
    fakeAnalyzer();

    const res = await analyze(deal.id, property.id, "auth0|agentA", {
      photo_urls: ["https://p/1.jpg", "https://p/2.jpg", "https://p/3.jpg"],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: Record<string, unknown> };
    expect(body.analysis.condition).toBe("good");
    expect(body.analysis.features).toEqual(["hardwood floors"]);
    expect(body.analysis.photos_analyzed).toBe(3);
    expect(body.analysis.model).toBe(PHOTO_ANALYSIS_MODEL);
    expect(body.analysis.disclaimer).toContain("Not a home inspection");

    const row = await prisma.tracked_properties.findUnique({ where: { id: property.id } });
    expect((row?.photo_analysis as Record<string, unknown>).condition).toBe("good");
  });

  it("caps the analysis at MAX_PHOTOS", async () => {
    const { deal, property } = await seedProperty();
    const seen: AnalysisRequest[] = [];
    fakeAnalyzer(seen);

    const photo_urls = Array.from({ length: 10 }, (_, i) => `https://p/${i}.jpg`);
    const res = await analyze(deal.id, property.id, "auth0|agentA", { photo_urls });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: { photos_analyzed: number } };
    expect(body.analysis.photos_analyzed).toBe(MAX_PHOTOS);

    const images = (seen[0].messages[0].content as Array<{ type: string }>).filter(
      (b) => b.type === "image"
    );
    expect(images).toHaveLength(MAX_PHOTOS);
  });

  it("falls back to the thumbnail when no photo_urls are sent", async () => {
    const { deal, property } = await seedProperty({ thumbnail: "https://thumb/x.jpg" });
    const seen: AnalysisRequest[] = [];
    fakeAnalyzer(seen);

    const res = await analyze(deal.id, property.id, "auth0|agentA", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { analysis: { photos_analyzed: number } };
    expect(body.analysis.photos_analyzed).toBe(1);
    const imgUrl = (seen[0].messages[0].content as Array<Record<string, unknown>>).find(
      (b) => b.type === "image"
    );
    expect((imgUrl?.source as { url: string }).url).toBe("https://thumb/x.jpg");
  });

  it("422s when there are no photos and no thumbnail", async () => {
    const { deal, property } = await seedProperty({ thumbnail: "" });
    fakeAnalyzer();
    const res = await analyze(deal.id, property.id, "auth0|agentA", { photo_urls: [] });
    expect(res.status).toBe(422);
  });
});

describe("POST analyze-photos — access control (agent-only)", () => {
  it("404s for a buyer participant, leaking no analysis", async () => {
    const { deal, property } = await seedProperty();
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyer" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    fakeAnalyzer();

    const res = await analyze(deal.id, property.id, "auth0|buyer", {
      photo_urls: ["https://p/1.jpg"],
    }, ["buyer"]);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("condition");
  });

  it("404s for a different agent", async () => {
    const { deal, property } = await seedProperty();
    await createUser({ role: "agent", auth0_id: "auth0|agentB" });
    fakeAnalyzer();
    const res = await analyze(deal.id, property.id, "auth0|agentB", {
      photo_urls: ["https://p/1.jpg"],
    });
    expect(res.status).toBe(404);
  });

  it("404s on malformed ids instead of 500ing", async () => {
    const { deal, property } = await seedProperty();
    fakeAnalyzer();
    expect((await analyze("nope", property.id, "auth0|agentA", {})).status).toBe(404);
    expect((await analyze(deal.id, "nope", "auth0|agentA", {})).status).toBe(404);
  });
});

describe("POST analyze-photos — cost gate (#377)", () => {
  it("503s and never touches the analyzer when the feature is disabled", async () => {
    const { deal, property } = await seedProperty();
    // A spy analyzer that would fail the test if the model were ever called.
    let called = false;
    setPhotoAnalyzerForTesting(async () => {
      called = true;
      return { content: [{ type: "text", text: "{}" }] };
    });

    setPhotoAiEnabled(false);
    const res = await analyze(deal.id, property.id, "auth0|agentA", {
      photo_urls: ["https://p/1.jpg"],
    });
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/disabled/i);
    expect(called).toBe(false);
  });
});

describe("POST analyze-photos — failure modes", () => {
  it("503s when photo analysis is not configured (missing API key)", async () => {
    const { deal, property } = await seedProperty();
    setPhotoAnalyzerForTesting(async () => {
      throw new PhotoAnalysisNotConfiguredError();
    });
    const res = await analyze(deal.id, property.id, "auth0|agentA", {
      photo_urls: ["https://p/1.jpg"],
    });
    expect(res.status).toBe(503);
  });

  it("502s when the model returns unparseable output", async () => {
    const { deal, property } = await seedProperty();
    setPhotoAnalyzerForTesting(async () => ({
      content: [{ type: "text", text: "the roof looks fine, no JSON here" }],
    }));
    const res = await analyze(deal.id, property.id, "auth0|agentA", {
      photo_urls: ["https://p/1.jpg"],
    });
    expect(res.status).toBe(502);
  });

  it("502s when the model call throws", async () => {
    const { deal, property } = await seedProperty();
    setPhotoAnalyzerForTesting(async () => {
      throw new Error("anthropic timeout");
    });
    const res = await analyze(deal.id, property.id, "auth0|agentA", {
      photo_urls: ["https://p/1.jpg"],
    });
    expect(res.status).toBe(502);
  });
});

describe("photo_analysis privacy on the property serializer", () => {
  async function listProps(dealId: string, auth0: string, roles: string[]) {
    const req = new Request(`http://localhost/api/deals/${dealId}/properties`, {
      headers: { authorization: await authHeader(auth0, roles) },
    });
    return listPropsRoute(req, dealCtx(dealId));
  }

  it("returns photo_analysis to the owning agent but hides it from a buyer", async () => {
    const { deal, property } = await seedProperty();
    const buyer = await createUser({ role: "buyer", auth0_id: "auth0|buyerP" });
    await prisma.deal_participants.create({
      data: { deal_id: deal.id, user_id: buyer.id, role: "buyer" },
    });
    fakeAnalyzer();
    await analyze(deal.id, property.id, "auth0|agentA", { photo_urls: ["https://p/1.jpg"] });

    const agentRes = await listProps(deal.id, "auth0|agentA", ["agent"]);
    const agentRows = (await agentRes.json()) as Record<string, unknown>[];
    expect(agentRows[0].photo_analysis).not.toBeNull();
    expect((agentRows[0].photo_analysis as Record<string, unknown>).condition).toBe("good");

    const buyerRes = await listProps(deal.id, "auth0|buyerP", ["buyer"]);
    const buyerRows = (await buyerRes.json()) as Record<string, unknown>[];
    expect("photo_analysis" in buyerRows[0]).toBe(false);
    expect(JSON.stringify(buyerRows)).not.toContain("dated bathroom");
  });
});
