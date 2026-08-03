/**
 * One-time backfill: copy pre-cutover document objects from the old S3 bucket
 * into the Vercel Blob store, under the SAME key.
 *
 * Why this exists
 * ---------------
 * Storage moved S3 → Vercel Blob in 93f15574e (2026-07-08T04:57:17Z). That
 * commit collapsed lib/s3 into a Blob-backed facade and dropped the AWS SDK, so
 * every read now resolves the stored key against Blob. Objects written before
 * that moment still live only in S3, so their `documents` rows point at
 * something the app can no longer fetch: an agent opening an older document
 * gets a failed download, and the same applies to every getObjectBytes consumer
 * (lib/remember-form.ts, disclosure-packet merging).
 *
 * Copying under the identical key means NO database change — the existing
 * s3_key / docusign_signed_s3_key values simply start resolving again.
 *
 * Why the AWS CLI instead of @aws-sdk
 * -----------------------------------
 * The SDK was deliberately removed from package.json in the cutover. Adding it
 * back as a permanent dependency for a one-off migration would undo that, so
 * this shells out to the `aws` CLI, which whoever runs this needs credentials
 * for anyway.
 *
 * Usage
 * -----
 *   # 1. Report only — touches nothing. Start here.
 *   npx tsx --env-file=<prod-env> scripts/backfill-s3-to-blob.ts
 *
 *   # 2. Copy the missing objects.
 *   npx tsx --env-file=<prod-env> scripts/backfill-s3-to-blob.ts --apply
 *
 * Requires: DATABASE_URL (prod), BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID +
 * OIDC), AWS credentials with read on the bucket, and the `aws` CLI on PATH.
 * Override the bucket with S3_LEGACY_BUCKET if it was ever renamed.
 *
 * Idempotent: a key already present in Blob is skipped, so re-running after a
 * partial run only does what is left. Safe to run repeatedly.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@/lib/db";
import { getBlobSize, putBlob } from "@/lib/blob-storage";

const execFileAsync = promisify(execFile);

const BUCKET = process.env.S3_LEGACY_BUCKET ?? "realtourflow-documents";
const APPLY = process.argv.includes("--apply");

/**
 * Cap on a single object streamed through the CLI's stdout. Comfortably above
 * the app's own 25MB upload limit (MAX_UPLOAD_BYTES), but the pre-cap era could
 * in principle hold something larger — such an object surfaces as a fetch
 * error, never as "absent", so it gets reported rather than silently written off.
 */
const MAX_OBJECT_BYTES = 128 * 1024 * 1024;

/** The commit that retired S3 — anything older than this can only be in S3. */
const CUTOVER = new Date("2026-07-08T04:57:17Z");

type Row = {
  id: string;
  key: string;
  column: "s3_key" | "docusign_signed_s3_key";
  mime_type: string;
  created_at: Date;
};

/**
 * Every non-empty stored key, from both columns. DocuSign placeholder rows
 * carry s3_key = '' by design (their only artifact is the signed PDF), so the
 * empty-string filter drops them rather than reporting them as missing.
 */
async function loadKeys(): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT id::text AS id, s3_key AS key, 's3_key' AS column, mime_type, created_at
      FROM documents WHERE s3_key <> ''
    UNION ALL
    SELECT id::text, docusign_signed_s3_key, 'docusign_signed_s3_key', mime_type, created_at
      FROM documents
     WHERE docusign_signed_s3_key IS NOT NULL AND docusign_signed_s3_key <> ''
     ORDER BY created_at ASC
  `;
}

async function inBlob(key: string): Promise<boolean> {
  try {
    await getBlobSize(key); // head(); throws when absent
    return true;
  } catch {
    return false;
  }
}

/**
 * Fails fast when the environment can't actually reach S3.
 *
 * Without this, a missing CLI / bad credentials / denied bucket makes EVERY
 * fromS3() call fail, and the run cheerfully reports every document as "missing
 * in both" — i.e. it claims total data loss when nothing is wrong. For a tool
 * whose whole job is reporting on data loss, that false positive is worse than
 * crashing, so prove access once up front instead.
 */
async function preflight(): Promise<void> {
  try {
    await execFileAsync("aws", ["--version"]);
  } catch {
    throw new Error("the `aws` CLI is not on PATH — install it, or this run would report every document as lost");
  }
  try {
    await execFileAsync("aws", ["s3api", "head-bucket", "--bucket", BUCKET]);
  } catch (err) {
    throw new Error(
      `cannot read s3://${BUCKET} — check AWS credentials, AWS_REGION, and bucket access. ` +
        `Refusing to run, because every key would otherwise be misreported as missing. ` +
        `Underlying error: ${String(err)}`
    );
  }
  console.log(`Preflight OK: aws CLI present, s3://${BUCKET} readable.\n`);
}

type S3Result =
  | { kind: "found"; bytes: Uint8Array }
  | { kind: "absent" }
  | { kind: "error"; message: string };

/**
 * Streams the object as bytes.
 *
 * Distinguishes "S3 says this key doesn't exist" from "the fetch itself broke"
 * (throttling, a >maxBuffer object, a transient network fault). Only the former
 * means the bytes are gone; conflating them is how a transient blip turns into
 * a bogus data-loss report.
 */
async function fromS3(key: string): Promise<S3Result> {
  try {
    const { stdout } = await execFileAsync(
      "aws",
      ["s3", "cp", `s3://${BUCKET}/${key}`, "-"],
      { encoding: "buffer", maxBuffer: MAX_OBJECT_BYTES }
    );
    return { kind: "found", bytes: new Uint8Array(stdout as unknown as Buffer) };
  } catch (err) {
    const text = err instanceof Error ? `${err.message}` : String(err);
    // The CLI reports a genuine miss as 404 / "Not Found" / "does not exist";
    // anything else is a fetch failure and must NOT be read as absence.
    if (/404|Not Found|does not exist|NoSuchKey/i.test(text)) return { kind: "absent" };
    return { kind: "error", message: text };
  }
}

async function main(): Promise<void> {
  await preflight();
  const rows = await loadKeys();
  if (rows.length === 0) {
    console.log("No stored document keys at all — nothing to back fill.");
    return;
  }

  // Informational only. Every key is still checked, because "created after the
  // cutover" is an assumption about where the bytes ended up, not a guarantee —
  // and a post-cutover key that is somehow absent is exactly what we'd want to
  // hear about. The count just frames how much of the set is theoretically at risk.
  const preCutover = rows.filter((r) => r.created_at < CUTOVER);
  console.log(
    `${rows.length} stored key(s); ${preCutover.length} predate the ` +
      `${CUTOVER.toISOString()} cutover. Checking all of them.`
  );
  console.log(APPLY ? "Mode: APPLY (copying)\n" : "Mode: dry run (no writes)\n");

  const present: Row[] = [];
  const needsCopy: Row[] = [];
  const missingEverywhere: Row[] = [];
  const fetchErrors: { row: Row; err: string }[] = [];
  const failed: { row: Row; err: string }[] = [];

  for (const row of rows) {
    if (await inBlob(row.key)) {
      present.push(row);
      continue;
    }
    // Absent from Blob — the only other place it can be is the old bucket.
    const res = await fromS3(row.key);
    if (res.kind === "absent") {
      missingEverywhere.push(row);
      continue;
    }
    if (res.kind === "error") {
      // Couldn't determine — deliberately NOT counted as missing.
      fetchErrors.push({ row, err: res.message });
      console.error(`  FETCH ERROR ${row.key}: ${res.message}`);
      continue;
    }
    needsCopy.push(row);
    if (!APPLY) continue;

    try {
      await putBlob(row.key, res.bytes, row.mime_type || "application/octet-stream");
      console.log(`  copied ${row.key} (${res.bytes.byteLength} bytes)`);
    } catch (err) {
      failed.push({ row, err: err instanceof Error ? err.message : String(err) });
      console.error(`  FAILED ${row.key}: ${String(err)}`);
    }
  }

  console.log("\n─── summary ───────────────────────────────");
  console.log(`already in Blob      : ${present.length}`);
  console.log(`${APPLY ? "copied from S3     " : "would copy from S3 "}  : ${needsCopy.length}`);
  console.log(`missing in BOTH      : ${missingEverywhere.length}`);
  console.log(`undetermined (fetch) : ${fetchErrors.length}`);
  if (APPLY) console.log(`failed to copy       : ${failed.length}`);

  // These are the genuinely lost ones: a DB row whose bytes exist nowhere. They
  // need a human decision (re-upload, or delete the row), so name every one.
  if (missingEverywhere.length > 0) {
    console.log("\nMissing in both S3 and Blob — needs a decision per row:");
    for (const r of missingEverywhere) {
      console.log(`  document ${r.id} [${r.column}] ${r.key} (${r.created_at.toISOString()})`);
    }
  }
  if (fetchErrors.length > 0) {
    console.log(
      "\nCould not be read from S3 — status UNKNOWN, not lost. Re-run to retry:"
    );
    for (const f of fetchErrors) console.log(`  ${f.row.key}: ${f.err}`);
    process.exitCode = 1;
  }
  if (failed.length > 0) {
    console.log("\nCopy failures (re-run to retry — the script is idempotent):");
    for (const f of failed) console.log(`  ${f.row.key}: ${f.err}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
