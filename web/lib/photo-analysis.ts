/**
 * Claude-vision photo analysis for a tracked property (#375).
 *
 * Runs a single vision pass over a property's listing photos and returns
 * structured condition / feature / flag tags for the AGENT (never the buyer —
 * see the serializer in the properties route). Deterministic plumbing around a
 * non-deterministic model call: URL selection, prompt/schema construction, and
 * response parsing are all pure and unit-tested; only `analyzePhotos` touches
 * the network, behind a `setPhotoAnalyzerForTesting` seam that mirrors
 * lib/form-ai/vision.ts so tests never hit Anthropic (CI has no key).
 *
 * Model + cost decisions (Paul, 2026-07-24): claude-opus-4-8; at most 6 photos
 * per pass (the main cost lever). Org-level spend caps are #377's job.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env";

/** Locked per the form-vision pipeline + #375 decision. */
export const PHOTO_ANALYSIS_MODEL = "claude-opus-4-8";

/**
 * Cost gate (#377). Photo-AI is parked (no UI caller), but its endpoint is live
 * and spends on our Anthropic account per call — so it is OFF unless
 * PROPERTY_PHOTO_AI_ENABLED is explicitly truthy. A disabled endpoint spends $0;
 * this is the cost guardrail for a parked paid feature (real caching/rate-limits
 * come when it's re-surfaced). Comps are unaffected — they bill the agent's MLS.
 */
export function isPhotoAnalysisEnabled(): boolean {
  const v = env().PROPERTY_PHOTO_AI_ENABLED.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Hard cap on images per analysis — extras are dropped (cost lever). */
export const MAX_PHOTOS = 6;

export const PHOTO_ANALYSIS_DISCLAIMER =
  "AI-generated from listing photos. Not a home inspection, appraisal, or " +
  "guarantee of condition — verify anything material in person.";

export const CONDITIONS = ["excellent", "good", "fair", "poor", "unknown"] as const;
export type Condition = (typeof CONDITIONS)[number];

export type PhotoAnalysisSubject = {
  address: string;
  city: string;
  beds: number;
  baths: number;
  sqft: number;
};

/** The model-derived tags (before provenance is stamped on). */
export type PhotoTags = {
  condition: Condition;
  features: string[];
  flags: string[];
  summary: string;
};

/** What gets stored on the property + returned to the agent. */
export type PhotoAnalysis = PhotoTags & {
  photos_analyzed: number;
  model: string;
  analyzed_at: string;
  disclaimer: string;
};

/** Thrown on a bad/empty model reply or nothing to analyze. */
export class PhotoAnalysisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoAnalysisError";
  }
}

/** Thrown when ANTHROPIC_API_KEY isn't configured (route maps to 503). */
export class PhotoAnalysisNotConfiguredError extends Error {
  constructor(message = "ANTHROPIC_API_KEY is not set") {
    super(message);
    this.name = "PhotoAnalysisNotConfiguredError";
  }
}

/**
 * The Anthropic messages.create body we build. Kept as a local shape (not the
 * SDK type) so the pure builder/tests don't depend on SDK internals; the real
 * caller casts it to the SDK param type at the boundary.
 */
export type AnalysisRequest = {
  model: string;
  max_tokens: number;
  system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }>;
  messages: Array<{ role: "user"; content: Array<Record<string, unknown>> }>;
  output_config?: { format?: { type: string; schema: Record<string, unknown> } };
};

/** Minimal shape of the model reply we read (SDK message is structurally compatible). */
export type AnalysisMessage = { content: Array<{ type: string; text?: string }> };

/** A pluggable analyzer: request in, model message out. */
export type PhotoAnalyzer = (req: AnalysisRequest) => Promise<AnalysisMessage>;

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  return /^https?:\/\//i.test(s.trim());
}

/**
 * Choose which URLs to analyze: caller-supplied photos (http/https only),
 * capped at MAX_PHOTOS; when none are usable, fall back to the property's
 * stored thumbnail. Returns [] when there is nothing to look at.
 */
export function selectPhotoUrls(
  photoUrls: unknown[] | undefined,
  thumbnailUrl: string
): string[] {
  const supplied = (Array.isArray(photoUrls) ? photoUrls : [])
    .filter(isHttpUrl)
    .map((u) => u.trim())
    .slice(0, MAX_PHOTOS);
  if (supplied.length > 0) return supplied;
  return isHttpUrl(thumbnailUrl) ? [thumbnailUrl.trim()] : [];
}

const SYSTEM_PROMPT = `You are a real-estate photo analyst helping a buyer's agent
size up a property from its listing photos. Judge ONLY what is visible in the
photos provided — never invent rooms, defects, or features you cannot see, and
never repeat the listing's marketing language.

Return:
- condition: one of "excellent", "good", "fair", "poor", or "unknown" (use
  "unknown" if the photos don't support a judgment).
- features: notable, verifiable positives visible in the photos (e.g. "hardwood
  floors", "granite counters", "updated kitchen", "pool", "mountain view"). [] if none.
- flags: concerns or dated elements visible in the photos, stated factually and
  non-defamatorily (e.g. "dated bathroom fixtures", "worn carpet", "small yard",
  "visible wear on cabinets"). [] if none.
- summary: one or two plain sentences for the agent. If the photos are too few
  or low-quality to assess, say so.

This is an internal agent tool, not a public valuation.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    condition: { type: "string", enum: [...CONDITIONS] },
    features: { type: "array", items: { type: "string" } },
    flags: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["condition", "features", "flags", "summary"],
  additionalProperties: false,
};

/**
 * Build the messages.create body: one image block per photo, a short text
 * instruction, a cached system prompt, and a structured-output schema so the
 * reply is guaranteed parseable JSON.
 */
export function buildAnalysisRequest(
  photoUrls: string[],
  subject: PhotoAnalysisSubject
): AnalysisRequest {
  const content: Array<Record<string, unknown>> = photoUrls.map((url) => ({
    type: "image",
    source: { type: "url", url },
  }));
  content.push({
    type: "text",
    text:
      `Analyze these ${photoUrls.length} listing photo(s) of ${subject.address}, ` +
      `${subject.city} (${subject.beds} bed / ${subject.baths} bath, ${subject.sqft} sqft). ` +
      `Return condition, feature tags, flags, and a short agent summary.`,
  });

  return {
    model: PHOTO_ANALYSIS_MODEL,
    max_tokens: 1500,
    // cache_control on the (single, stable) system block → cheap across the
    // many properties an agent analyzes.
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
  };
}

function asCondition(v: unknown): Condition {
  return (CONDITIONS as readonly string[]).includes(v as string)
    ? (v as Condition)
    : "unknown";
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Parse + normalize the model's structured reply into PhotoTags. */
export function parseAnalysisResponse(msg: AnalysisMessage): PhotoTags {
  const text = msg.content.find((b) => b.type === "text" && typeof b.text === "string")?.text;
  if (!text) throw new PhotoAnalysisError("model returned no text block");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PhotoAnalysisError("model returned non-JSON output");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PhotoAnalysisError("model returned a non-object result");
  }
  const obj = raw as Record<string, unknown>;
  return {
    condition: asCondition(obj.condition),
    features: asStringArray(obj.features),
    flags: asStringArray(obj.flags),
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

let stub: PhotoAnalyzer | undefined;

/** Test seam — mirrors setVisionDetectorForTesting. Pass undefined to reset. */
export function setPhotoAnalyzerForTesting(a: PhotoAnalyzer | undefined): void {
  stub = a;
}

let real: PhotoAnalyzer | undefined;

function realAnalyzer(): PhotoAnalyzer {
  const apiKey = env().ANTHROPIC_API_KEY;
  if (!apiKey) throw new PhotoAnalysisNotConfiguredError();
  const client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
  return async (req) => {
    const msg = await client.messages.create(
      req as unknown as Anthropic.MessageCreateParamsNonStreaming
    );
    return msg as unknown as AnalysisMessage;
  };
}

function getAnalyzer(): PhotoAnalyzer {
  if (stub) return stub;
  if (!real) real = realAnalyzer();
  return real;
}

/**
 * Run the vision pass and return the stamped analysis. `photoUrls` are already
 * selected/capped by the caller (see selectPhotoUrls); refuses an empty set so
 * we never bill a no-image request.
 */
export async function analyzePhotos(
  photoUrls: string[],
  subject: PhotoAnalysisSubject
): Promise<PhotoAnalysis> {
  if (photoUrls.length === 0) {
    throw new PhotoAnalysisError("no photos to analyze");
  }
  const req = buildAnalysisRequest(photoUrls, subject);
  const msg = await getAnalyzer()(req);
  const tags = parseAnalysisResponse(msg);
  return {
    ...tags,
    photos_analyzed: photoUrls.length,
    model: PHOTO_ANALYSIS_MODEL,
    analyzed_at: new Date().toISOString(),
    disclaimer: PHOTO_ANALYSIS_DISCLAIMER,
  };
}
