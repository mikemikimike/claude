/**
 * PHASE 0 — cross-layout guided-vision eval. Runs the REAL detectGuided locate
 * pipeline (same prompt/tool/rendering as production) against DIFFERENT-brokerage
 * purchase agreements, using the curated purchase_agreement TYPE field set (79
 * position-free fields) as the expected list.
 *
 * Honest cross-layout protocol: on a real new upload we do NOT know which page a
 * field lands on, so we query EVERY page with the FULL field list and NO position
 * hints (unlike the same-doc eval, which leaked the catalog's page + position).
 * Per (field, page) we record whether vision claims it's there + the box.
 *
 * This script only PRODUCES vision output + rendered pages. Ground-truth existence
 * and placement scoring happens separately (we have no AcroForm answer key for
 * these flat forms) — see the Phase 0 scoring workflow.
 *
 * Run from web/:  npx tsx --env-file=.env scripts/eval-phase0-crosslayout.ts
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  ClaudeVisionDetector,
  type PageRenderer,
  type RenderedPage,
  type ExpectedField,
} from "../lib/form-ai/vision";
import type { DetectedFieldType } from "../lib/form-ai/types";
import typeDef from "../lib/form-ai/purchase-agreement-type.json";

const FORMS = [
  { key: "baldwin_br", name: "Baldwin BR Residential Purchase Agreement", path: "/Users/paulleara/Downloads/New Purchase Agreement - Residential Property (BR)  (3).pdf" },
  { key: "valleymls_financed", name: "ValleyMLS Financed Sales Contract", path: "/Users/paulleara/Downloads/Financed Sales Contract (1).pdf" },
];

const OUT_ROOT = join(process.cwd(), "eval-out");
const VALID = new Set(["text", "checkbox", "signature", "initial", "date"]);
const coerce = (t: string): DetectedFieldType => (VALID.has(t) ? (t as DetectedFieldType) : "text");

type TypeField = { label: string; type: string; role: string; tier: "core" | "common"; core_key: string | null };
const FIELDS = typeDef.fields as TypeField[];

// Poppler renderer that ALSO writes the page PNGs to outDir (reused for overlays),
// memoized so detectGuided's internal re-render per page is free.
function makeRenderer(outDir: string): PageRenderer {
  let cache: RenderedPage[] | null = null;
  return async (pdfBytes) => {
    if (cache) return cache;
    mkdirSync(outDir, { recursive: true });
    const pdfPath = join(outDir, "doc.pdf");
    writeFileSync(pdfPath, Buffer.from(pdfBytes));
    const doc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const sizes = doc.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight() }));
    execFileSync("pdftoppm", ["-png", "-r", "150", pdfPath, join(outDir, "p")]);
    const pngs = readdirSync(outDir)
      .filter((f) => /^p-?\d+\.png$/.test(f))
      .sort((a, b) => {
        const n = (s: string) => Number(s.match(/p-?(\d+)\.png$/)?.[1] ?? 0);
        return n(a) - n(b);
      });
    cache = pngs.map((f, i): RenderedPage => ({
      pageNumber: i + 1,
      pngBase64: readFileSync(join(outDir, f)).toString("base64"),
      widthPts: sizes[i]?.w ?? 612,
      heightPts: sizes[i]?.h ?? 792,
    }));
    return cache;
  };
}

type Located = {
  label: string;
  type: string;
  tier: "core" | "common";
  role: string;
  core_key: string | null;
  foundPage: number;
  // top-left origin (for overlays + human reading), in PDF points.
  xTop: number;
  yTop: number;
  width: number;
  height: number;
  pageW: number;
  pageH: number;
  pngFile: string;
};

async function runForm(form: (typeof FORMS)[number]) {
  const outDir = join(OUT_ROOT, form.key);
  rmSync(outDir, { recursive: true, force: true });
  const render = makeRenderer(outDir);
  const bytes = new Uint8Array(readFileSync(form.path));
  const pages = await render(bytes);
  const detector = new ClaudeVisionDetector(render, undefined, 0);

  const located: Located[] = [];
  // Query EVERY page with the FULL field list (no page hint). detectGuided filters
  // expected by page internally, so tagging all fields page=p yields one locate
  // call for page p with all 79 fields — the real production prompt/tool.
  for (const page of pages) {
    const expected: ExpectedField[] = FIELDS.map((f) => ({
      label: f.label,
      type: coerce(f.type),
      page: page.pageNumber,
    }));
    const out = await detector.detectGuided({ pdfBytes: bytes, expected });
    for (const d of out) {
      const f = FIELDS.find((x) => x.label === d.name)!;
      const yTop = page.heightPts - (d.rect.y + d.rect.height); // bottom-left → top-left top edge
      located.push({
        label: d.name,
        type: d.type,
        tier: f.tier,
        role: f.role,
        core_key: f.core_key,
        foundPage: page.pageNumber,
        xTop: Math.round(d.rect.x),
        yTop: Math.round(yTop),
        width: Math.round(d.rect.width),
        height: Math.round(d.rect.height),
        pageW: Math.round(page.widthPts),
        pageH: Math.round(page.heightPts),
        pngFile: `p-${String(page.pageNumber).padStart(2, "0")}.png`,
      });
    }
    console.log(`  ${form.key} page ${page.pageNumber}/${pages.length}: ${out.length} located`);
  }

  // Per-label rollup: located anywhere? on which pages?
  const byLabel = new Map<string, number[]>();
  for (const l of located) {
    if (!byLabel.has(l.label)) byLabel.set(l.label, []);
    byLabel.get(l.label)!.push(l.foundPage);
  }
  const perField = FIELDS.map((f) => ({
    label: f.label,
    tier: f.tier,
    type: f.type,
    role: f.role,
    core_key: f.core_key,
    locatedPages: byLabel.get(f.label) ?? [],
    located: byLabel.has(f.label),
  }));

  const result = {
    form: form.name,
    key: form.key,
    pageCount: pages.length,
    expectedCount: FIELDS.length,
    coreCount: FIELDS.filter((f) => f.tier === "core").length,
    locatedTotal: located.length,
    locatedDistinctLabels: byLabel.size,
    located,
    perField,
  };
  writeFileSync(join(outDir, "located.json"), JSON.stringify(result, null, 2));
  console.log(`✅ ${form.key}: ${byLabel.size}/${FIELDS.length} distinct labels located (${located.length} total hits across ${pages.length} pages) → ${join(outDir, "located.json")}`);
  return result;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set (run with --env-file=.env)");
  console.log(`Phase 0 cross-layout eval — ${FIELDS.length} expected fields, ${FORMS.length} forms\n`);
  for (const form of FORMS) {
    console.log(`=== ${form.name} ===`);
    await runForm(form);
    console.log("");
  }
}
main().then(() => console.log("done")).catch((e) => { console.error(e); process.exit(1); });
