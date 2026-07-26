import { describe, it, expect, afterEach } from "vitest";
import { resetEnvForTesting } from "./env";
import {
  analyzePhotos,
  buildAnalysisRequest,
  parseAnalysisResponse,
  selectPhotoUrls,
  isPhotoAnalysisEnabled,
  MAX_PHOTOS,
  PHOTO_ANALYSIS_MODEL,
  PHOTO_ANALYSIS_DISCLAIMER,
  PhotoAnalysisError,
  setPhotoAnalyzerForTesting,
  type PhotoAnalysisSubject,
} from "./photo-analysis";

afterEach(() => setPhotoAnalyzerForTesting(undefined));

describe("isPhotoAnalysisEnabled — #377 cost gate", () => {
  const orig = process.env.PROPERTY_PHOTO_AI_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.PROPERTY_PHOTO_AI_ENABLED;
    else process.env.PROPERTY_PHOTO_AI_ENABLED = orig;
    resetEnvForTesting();
  });

  function check(value: string | undefined): boolean {
    if (value === undefined) delete process.env.PROPERTY_PHOTO_AI_ENABLED;
    else process.env.PROPERTY_PHOTO_AI_ENABLED = value;
    resetEnvForTesting();
    return isPhotoAnalysisEnabled();
  }

  it("is off by default (unset or empty)", () => {
    expect(check(undefined)).toBe(false);
    expect(check("")).toBe(false);
  });

  it("is on only for explicit truthy values", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on", " true "]) {
      expect(check(v)).toBe(true);
    }
  });

  it("is off for anything else", () => {
    for (const v of ["false", "0", "no", "off", "enabled", "banana"]) {
      expect(check(v)).toBe(false);
    }
  });
});

const SUBJECT: PhotoAnalysisSubject = {
  address: "500 Subject Ln",
  city: "Hoover",
  beds: 3,
  baths: 2,
  sqft: 2000,
};

describe("selectPhotoUrls", () => {
  it("keeps http/https urls and drops junk", () => {
    const urls = selectPhotoUrls(
      ["https://a/1.jpg", "http://b/2.jpg", "not-a-url", "", "ftp://x/3.jpg"],
      ""
    );
    expect(urls).toEqual(["https://a/1.jpg", "http://b/2.jpg"]);
  });

  it("caps at MAX_PHOTOS", () => {
    const many = Array.from({ length: 20 }, (_, i) => `https://p/${i}.jpg`);
    expect(selectPhotoUrls(many, "").length).toBe(MAX_PHOTOS);
    expect(selectPhotoUrls(many, "")).toEqual(many.slice(0, MAX_PHOTOS));
  });

  it("falls back to the thumbnail when no photo urls are supplied", () => {
    expect(selectPhotoUrls([], "https://thumb/x.jpg")).toEqual(["https://thumb/x.jpg"]);
    expect(selectPhotoUrls(undefined, "https://thumb/x.jpg")).toEqual([
      "https://thumb/x.jpg",
    ]);
  });

  it("returns empty when there is nothing usable to analyze", () => {
    expect(selectPhotoUrls([], "")).toEqual([]);
    expect(selectPhotoUrls(["not-a-url"], "")).toEqual([]);
    expect(selectPhotoUrls([], "not-a-url")).toEqual([]);
  });
});

describe("buildAnalysisRequest", () => {
  it("targets the chosen model with one image block per photo + a text prompt", () => {
    const req = buildAnalysisRequest(["https://a/1.jpg", "https://a/2.jpg"], SUBJECT);
    expect(req.model).toBe(PHOTO_ANALYSIS_MODEL);

    const content = req.messages[0].content as Array<Record<string, unknown>>;
    const images = content.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images[0]).toEqual({
      type: "image",
      source: { type: "url", url: "https://a/1.jpg" },
    });
    // A single text instruction block accompanies the images.
    expect(content.filter((b) => b.type === "text")).toHaveLength(1);

    // Structured-output schema is attached so the reply is guaranteed JSON.
    expect(req.output_config?.format?.type).toBe("json_schema");
  });

  it("caches the system prompt for cross-property cost savings", () => {
    const req = buildAnalysisRequest(["https://a/1.jpg"], SUBJECT);
    const sys = req.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1].cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("parseAnalysisResponse", () => {
  const good = {
    condition: "good",
    features: ["hardwood floors", "granite counters"],
    flags: ["dated bathroom"],
    summary: "Well-kept 3BR; kitchen updated, guest bath dated.",
  };

  it("parses a well-formed structured reply", () => {
    const msg = { content: [{ type: "text", text: JSON.stringify(good) }] };
    const parsed = parseAnalysisResponse(msg);
    expect(parsed.condition).toBe("good");
    expect(parsed.features).toEqual(["hardwood floors", "granite counters"]);
    expect(parsed.flags).toEqual(["dated bathroom"]);
    expect(parsed.summary).toContain("Well-kept");
  });

  it("coerces a missing/unknown condition to 'unknown' and missing arrays to []", () => {
    const msg = {
      content: [{ type: "text", text: JSON.stringify({ summary: "n/a" }) }],
    };
    const parsed = parseAnalysisResponse(msg);
    expect(parsed.condition).toBe("unknown");
    expect(parsed.features).toEqual([]);
    expect(parsed.flags).toEqual([]);
  });

  it("throws PhotoAnalysisError on non-JSON output", () => {
    const msg = { content: [{ type: "text", text: "the roof looks fine" }] };
    expect(() => parseAnalysisResponse(msg)).toThrow(PhotoAnalysisError);
  });

  it("throws PhotoAnalysisError when there is no text block", () => {
    expect(() => parseAnalysisResponse({ content: [] })).toThrow(PhotoAnalysisError);
  });
});

describe("analyzePhotos (via injected analyzer)", () => {
  it("returns the analysis stamped with model, count, disclaimer, and a timestamp", async () => {
    setPhotoAnalyzerForTesting(async (req) => {
      const imageCount = (req.messages[0].content as unknown[]).filter(
        (b) => (b as { type: string }).type === "image"
      ).length;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              condition: "fair",
              features: ["large lot"],
              flags: ["worn carpet"],
              summary: `Analyzed ${imageCount} photos.`,
            }),
          },
        ],
      };
    });

    const result = await analyzePhotos(
      ["https://a/1.jpg", "https://a/2.jpg", "https://a/3.jpg"],
      SUBJECT
    );
    expect(result.condition).toBe("fair");
    expect(result.features).toEqual(["large lot"]);
    expect(result.photos_analyzed).toBe(3);
    expect(result.model).toBe(PHOTO_ANALYSIS_MODEL);
    expect(result.disclaimer).toBe(PHOTO_ANALYSIS_DISCLAIMER);
    expect(typeof result.analyzed_at).toBe("string");
    expect(Number.isNaN(Date.parse(result.analyzed_at))).toBe(false);
  });

  it("throws when asked to analyze zero photos (nothing to look at)", async () => {
    await expect(analyzePhotos([], SUBJECT)).rejects.toThrow(PhotoAnalysisError);
  });
});
