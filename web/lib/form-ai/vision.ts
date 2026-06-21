/**
 * Flat-PDF field detection — the "Layer 3" vision path from the v2 design note.
 *
 * KEY ARCHITECTURAL CONSTRAINT: a VisionFieldDetector returns the SAME
 * `DetectedField[]` shape that the deterministic AcroForm extractor
 * (extract.ts) produces. So vision is a third *source* of detected fields —
 * alongside AcroForm extraction and the recognition library — and its output
 * flows into the EXACT SAME pipeline: the existing swappable FieldMapper assigns
 * meaning off each field's label, the rows land in uploaded_form_fields, the
 * admin reviews them, and step 5's buildTemplateSigners places the tabs. There
 * is NO parallel placement system. Flat detection only replaces the
 * position-finding that AcroForm gives for free on fillable PDFs.
 *
 * Implementation: each page is rendered to an image (by an injected PageRenderer
 * — poppler in the eval/local, a serverless-safe renderer when wired for prod)
 * and sent to Claude vision with a tool schema. The model returns, per blank,
 * its type + the printed label next to it + a bounding box in page fractions
 * (top-left origin); we convert that to a PDF-point rect (bottom-left origin),
 * matching extract.ts so downstream placement is identical.
 *
 * NOT WIRED: getVisionDetector() still throws until an accuracy eval gates it on
 * (docs/flat-pdf-vision-poc.md). Build + prove before wiring into the route.
 */
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";
import type { DetectedField, DetectedFieldType } from "./types";

export interface VisionFieldDetector {
  detect(input: { pdfBytes: Uint8Array }): Promise<DetectedField[]>;
}

export class VisionNotConfiguredError extends Error {}
export class VisionDetectorError extends Error {}

// One rendered page handed to the vision model. width/height are the PDF page
// dimensions IN POINTS (so detected fractions convert straight back to points,
// independent of the render DPI).
export type RenderedPage = {
  pageNumber: number; // 1-based
  pngBase64: string;
  widthPts: number;
  heightPts: number;
};
export type PageRenderer = (pdfBytes: Uint8Array) => Promise<RenderedPage[]>;

// Minimal structural shape of the Messages response we read (mirrors mapper.ts —
// keeps tests free of the SDK).
export type LlmMessage = {
  content: Array<{ type: string } & Record<string, unknown>>;
  stop_reason?: string | null;
};
export type MessagesCreate = (body: unknown) => Promise<LlmMessage>;

const TOOL_NAME = "report_fields";
const VALID_TYPES: DetectedFieldType[] = [
  "text",
  "checkbox",
  "signature",
  "initial",
  "date",
];

const REPORT_TOOL = {
  name: TOOL_NAME,
  description:
    "Report every fillable blank found on this page of a blank form, with its type, label, and box.",
  input_schema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: VALID_TYPES,
              description:
                "text=a write-in line/box; checkbox=a tickable box; signature=a signature line; initial=an initials line; date=a date line",
            },
            label: {
              type: "string",
              description:
                "the printed text that says what this blank is for (the caption/label nearest it), e.g. 'Buyer/Seller Name (Print)' or 'Closing Date'",
            },
            x: { type: "number", description: "left edge, fraction of page width 0..1" },
            y: { type: "number", description: "top edge, fraction of page height 0..1 (0=top)" },
            width: { type: "number", description: "box width, fraction of page width 0..1" },
            height: { type: "number", description: "box height, fraction of page height 0..1" },
          },
          required: ["type", "label", "x", "y", "width", "height"],
        },
      },
    },
    required: ["fields"],
  },
} as const;

const SYSTEM_PROMPT = [
  "You are looking at ONE page of a BLANK real-estate form (no data filled in).",
  "Find every spot a person would fill in or sign on this page:",
  "- write-in lines or boxes (text), - checkboxes, - signature lines,",
  "- initials lines, - date lines.",
  "For each blank, return:",
  "1. type — one of text, checkbox, signature, initial, date.",
  "2. label — the printed caption/text nearest the blank that says what it is for",
  "   (so it can be matched to a data field). Read it from the page.",
  "3. a bounding box as FRACTIONS of the page: x (left), y (top, 0 at the top),",
  "   width, height — each 0..1. Put the box tightly on the blank itself (the line",
  "   or box to fill), NOT on the label.",
  "Rules: include EVERY blank, including each checkbox in a group separately.",
  "Do NOT return ordinary body/paragraph text. Be precise about position — the box",
  "is used to place a real signing field. If a page has no blanks, return an empty list.",
].join("\n");

// ── Guided mode: locate a KNOWN form's EXPECTED fields (the recognition-library
// catalog) instead of detecting blind. The target set is fixed, so there's no
// over-detection, and each located field is already tied to its catalog entry +
// core key. Used when a flat upload is recognized as a known form.
export type ExpectedField = {
  label: string; // the catalog Data Label, e.g. "purchase_price"
  type: DetectedFieldType;
  page: number; // 1-based
  // Approximate location from the catalog (page fractions, top-left origin) — a
  // search hint so the model narrows to the right field among dense clusters.
  hintX?: number;
  hintY?: number;
};

const LOCATE_TOOL_NAME = "report_locations";
const LOCATE_TOOL = {
  name: LOCATE_TOOL_NAME,
  description:
    "For each requested field, report whether it appears on this page and, if so, its bounding box.",
  input_schema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "echo the requested field's label EXACTLY" },
            found: { type: "boolean", description: "true if this field's blank is on THIS page" },
            x: { type: "number", description: "left edge, fraction of page width 0..1 (if found)" },
            y: { type: "number", description: "top edge, fraction of page height 0..1 (if found)" },
            width: { type: "number", description: "fraction of page width 0..1" },
            height: { type: "number", description: "fraction of page height 0..1" },
          },
          required: ["label", "found", "x", "y", "width", "height"],
        },
      },
    },
    required: ["fields"],
  },
} as const;

const GUIDED_SYSTEM = [
  "You are shown ONE page of a BLANK real-estate form, plus a list of SPECIFIC",
  "fields we expect on this form (each with a label and a type). Your ONLY job is",
  "to LOCATE each requested field on THIS page. Do NOT report any other blanks.",
  "For each requested field: if its blank (line / box / checkbox) is on this page,",
  "set found=true and give its bounding box as FRACTIONS of the page (x,y from the",
  "top-left, width, height). If it is not on this page, set found=false.",
  "Echo each label EXACTLY as given. Use the label's meaning and the printed text",
  "on the page to find the right blank. Box the blank itself, not the printed label.",
  "Each field includes an approximate location (x≈, y≈ as page fractions from the",
  "top-left) from a reference copy — use it to narrow to the right region (critical",
  "when many similar checkboxes sit close together), then locate the EXACT blank on",
  "THIS page. The copy may have shifted, so refine the box; do not just echo the hint.",
].join("\n");

function clampFrac(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

// Turn a human label into a stable-ish field name (the mapper reads name first,
// nearbyText second — we set both to the label so vision fields carry the signal).
function labelToName(label: string, page: number, i: number): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug || `vfield_p${page}_${i}`;
}

// Convert one model box (page fractions, top-left origin) to a DetectedField
// (PDF points, bottom-left origin) — the inverse of buildTemplateSigners.
function toDetectedField(
  raw: Record<string, unknown>,
  page: RenderedPage,
  i: number
): DetectedField | null {
  const type = VALID_TYPES.includes(raw.type as DetectedFieldType)
    ? (raw.type as DetectedFieldType)
    : "unknown";
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const xf = clampFrac(raw.x);
  const yf = clampFrac(raw.y);
  const wf = clampFrac(raw.width);
  const hf = clampFrac(raw.height);
  // Drop degenerate boxes the model sometimes emits.
  if (wf === 0 && hf === 0 && type !== "checkbox" && type !== "signature") {
    return null;
  }
  const x = xf * page.widthPts;
  const width = wf * page.widthPts;
  const height = hf * page.heightPts;
  // top-fraction → PDF y of the box BOTTOM edge, measured from the page bottom.
  const y = page.heightPts - yf * page.heightPts - height;
  return {
    name: labelToName(label, page.pageNumber, i),
    type,
    page: page.pageNumber,
    rect: { x, y, width, height },
    nearbyText: label || undefined,
  };
}

export class ClaudeVisionDetector implements VisionFieldDetector {
  constructor(
    private readonly render: PageRenderer,
    private readonly create?: MessagesCreate,
    // Calibration: shift located fields UP by this many points to correct the
    // detector's systematic downward offset (measured ~15pt). 0 = off.
    private readonly calibrateY = 0
  ) {}

  enabled(): boolean {
    return !!env().ANTHROPIC_API_KEY;
  }

  async detect(input: { pdfBytes: Uint8Array }): Promise<DetectedField[]> {
    const pages = await this.render(input.pdfBytes);
    const create = this.create ?? this.realCreate();
    const out: DetectedField[] = [];
    // Pages are independent — one vision call each (a 13-page contract = 13 calls).
    for (const page of pages) {
      const fields = await this.detectPage(create, page);
      out.push(...fields);
    }
    return out;
  }

  private async detectPage(
    create: MessagesCreate,
    page: RenderedPage
  ): Promise<DetectedField[]> {
    const body = {
      model: env().FORM_AI_MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: page.pngBase64 },
            },
            { type: "text", text: `This is page ${page.pageNumber}. Report every blank.` },
          ],
        },
      ],
      tools: [REPORT_TOOL],
      tool_choice: { type: "tool", name: TOOL_NAME },
    };

    let res: LlmMessage;
    try {
      res = await create(body);
    } catch (err) {
      throw new VisionDetectorError(
        `vision detect (page ${page.pageNumber}) failed: ${(err as Error).message}`
      );
    }
    const tool = res.content.find((b) => b.type === "tool_use");
    const raw = (tool?.input as { fields?: unknown } | undefined)?.fields;
    if (!Array.isArray(raw)) return [];
    const fields: DetectedField[] = [];
    raw.forEach((item, i) => {
      if (item && typeof item === "object") {
        const f = toDetectedField(item as Record<string, unknown>, page, i);
        if (f) fields.push(f);
      }
    });
    return fields;
  }

  /**
   * GUIDED detection for a KNOWN form: locate the given expected fields instead
   * of detecting blind. Returns at most one DetectedField per expected field —
   * keyed by the catalog label (and carrying the catalog type), so there is no
   * over-detection and each result is already tied to its core key.
   */
  async detectGuided(input: {
    pdfBytes: Uint8Array;
    expected: ExpectedField[];
  }): Promise<DetectedField[]> {
    const pages = await this.render(input.pdfBytes);
    const create = this.create ?? this.realCreate();
    const out: DetectedField[] = [];
    for (const page of pages) {
      const wanted = input.expected.filter((e) => e.page === page.pageNumber);
      if (!wanted.length) continue;
      out.push(...(await this.locatePage(create, page, wanted)));
    }
    return out;
  }

  private async locatePage(
    create: MessagesCreate,
    page: RenderedPage,
    wanted: ExpectedField[]
  ): Promise<DetectedField[]> {
    const list = wanted
      .map((e, i) => {
        const hint =
          e.hintX !== undefined && e.hintY !== undefined
            ? ` (approx x≈${e.hintX.toFixed(2)} y≈${e.hintY.toFixed(2)})`
            : "";
        return `${i + 1}. label="${e.label}" type=${e.type}${hint}`;
      })
      .join("\n");
    const body = {
      model: env().FORM_AI_MODEL,
      max_tokens: 8192,
      system: GUIDED_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: page.pngBase64 },
            },
            { type: "text", text: `Page ${page.pageNumber}. Locate these fields:\n${list}` },
          ],
        },
      ],
      tools: [LOCATE_TOOL],
      tool_choice: { type: "tool", name: LOCATE_TOOL_NAME },
    };

    let res: LlmMessage;
    try {
      res = await create(body);
    } catch (err) {
      throw new VisionDetectorError(
        `vision locate (page ${page.pageNumber}) failed: ${(err as Error).message}`
      );
    }
    const tool = res.content.find((b) => b.type === "tool_use");
    const raw = (tool?.input as { fields?: unknown } | undefined)?.fields;
    if (!Array.isArray(raw)) return [];

    // Match results back to the expected set by label — drop anything we didn't
    // ask for (so the model can't introduce over-detection), and emit one field
    // per located expected field, carrying the CATALOG type (not the model's).
    const byLabel = new Map(wanted.map((e) => [e.label, e]));
    const out: DetectedField[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (r.found !== true) continue;
      const exp = typeof r.label === "string" ? byLabel.get(r.label) : undefined;
      if (!exp) continue;
      byLabel.delete(exp.label); // one location per expected field
      const xf = clampFrac(r.x);
      const yf = clampFrac(r.y);
      const wf = clampFrac(r.width);
      const hf = clampFrac(r.height);
      const width = wf * page.widthPts;
      const height = hf * page.heightPts;
      out.push({
        name: exp.label,
        type: exp.type, // trust the verified catalog type, not the model's
        page: page.pageNumber,
        rect: {
          x: xf * page.widthPts,
          // top-fraction → PDF bottom-left y, plus the upward calibration.
          y: page.heightPts - yf * page.heightPts - height + this.calibrateY,
          width,
          height,
        },
        nearbyText: exp.label,
      });
    }
    return out;
  }

  private realCreate(): MessagesCreate {
    const apiKey = env().ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new VisionNotConfiguredError("ANTHROPIC_API_KEY is not set");
    }
    // A 13-page contract is 13 calls; one transient timeout shouldn't sink the
    // whole detect. Generous per-call timeout + retries.
    const client = new Anthropic({ apiKey, maxRetries: 4, timeout: 180_000 });
    return async (body: unknown) => {
      const msg = await client.messages.create(
        body as Anthropic.MessageCreateParamsNonStreaming
      );
      return msg as unknown as LlmMessage;
    };
  }
}

let stub: VisionFieldDetector | undefined;

/** Test seam — mirrors setFieldMapperForTesting. Pass undefined to reset. */
export function setVisionDetectorForTesting(d: VisionFieldDetector | undefined): void {
  stub = d;
}

export function getVisionDetector(): VisionFieldDetector {
  if (stub) return stub;
  // NOT WIRED: the production detector needs a serverless-safe PageRenderer and
  // an accuracy eval to gate it on (see docs/flat-pdf-vision-poc.md). Until then
  // a flat upload is not auto-detected — the route still rejects it.
  return {
    async detect() {
      throw new VisionNotConfiguredError(
        "flat-PDF vision detection is built but not wired (pending the accuracy gate + a prod page renderer)"
      );
    },
  };
}

// Exposed for the eval harness + unit tests (compose a detector over a renderer
// you control, e.g. poppler locally).
export { toDetectedField as __toDetectedFieldForTest };
