import { z } from "zod";

// Dev fallback for the OAuth CSRF state-cookie HMAC key. Used when the env var
// is unset OR explicitly empty (e.g. copied from .env.example) — but NEVER in
// Vercel production: this string is committed, so falling back there would let
// anyone forge the OAuth state cookie. See the superRefine below.
const DEV_OAUTH_STATE_SECRET = "rtf-dev-oauth-state-secret-change-in-prod";

const MIN_OAUTH_STATE_SECRET_LENGTH = 32;

// Dev fallback for the Blob capability-URL HMAC key (lib/blob-storage.ts).
// Same contract as DEV_OAUTH_STATE_SECRET: substituted when the env var is
// unset OR empty outside Vercel production — but NEVER in production: this
// string is committed, so falling back there would let anyone forge an
// upload/download capability URL for any file in the store. See the
// superRefine below (#188).
const DEV_BLOB_CAP_SECRET = "rtf-dev-blob-cap-secret-change-in-prod";

const MIN_BLOB_CAP_SECRET_LENGTH = 32;

const shape = z.object({
  // Vercel deployment environment: "production" | "preview" | "development",
  // unset outside Vercel (local dev, vitest, CI, Playwright's `next dev`).
  // This is the signal for "are we in real production" — fail-closed checks
  // key off it.
  VERCEL_ENV: z.string().default(""),

  DATABASE_URL: z.string().url(),

  AUTH0_DOMAIN: z.string().min(1),
  AUTH0_AUDIENCE: z.string().min(1),

  // Public (SPA) client id — same value the browser uses in Providers.tsx.
  // Server-side it feeds Auth0's public dbconnections/change_password call and
  // the client_id on verification-email jobs (so links use this app's settings).
  NEXT_PUBLIC_AUTH0_CLIENT_ID: z.string().default(""),
  // Auth0 database connection that password resets go against.
  AUTH0_DB_CONNECTION: z.string().default("Username-Password-Authentication"),
  // Auth0 Management API M2M credentials (scopes: read:users, update:users).
  // Used for email-verification state + resend; empty = feature disabled.
  AUTH0_MGMT_CLIENT_ID: z.string().default(""),
  AUTH0_MGMT_CLIENT_SECRET: z.string().default(""),

  // Vercel Blob is the app's file-storage backend (S3 retired). A store must be
  // configured in every real environment. Two auth modes: a static R/W token, OR
  // OIDC (the newer store model) which the SDK derives from VERCEL_OIDC_TOKEN + the
  // store id at runtime. lib/blob-storage throws loudly if neither is present.
  BLOB_READ_WRITE_TOKEN: z.string().default(""),
  BLOB_STORE_ID: z.string().default(""),
  // HMAC key for the short-lived upload/download capability URLs that proxy
  // the private Blob store (lib/blob-storage.ts → /api/storage/blob-{put,get}).
  // A DEDICATED secret — never derived from BLOB_READ_WRITE_TOKEN or
  // BLOB_STORE_ID (#188: the store id is a visible identifier — dashboard,
  // env listings, blob hostnames — not a secret). Outside Vercel production
  // an unset/empty value falls back to a committed dev value so local dev /
  // CI / previews stay zero-config; in production (VERCEL_ENV=production) it
  // is REQUIRED with at least 32 chars — enforced by the superRefine below.
  BLOB_CAP_SECRET: z.string().default(""),

  // AES-256-GCM key for app-level encryption of at-rest secrets (lib/crypto.ts)
  // — today the per-agent SimplyRETS MLS credentials (users.mls_key /
  // mls_secret). A 32-byte key provided as 64 hex chars (`openssl rand -hex 32`)
  // or base64; parseFieldKey throws if it decodes to anything other than 32
  // bytes. REQUIRED in production before deploy: with no key, a new MLS connect
  // (which encrypts before storing) fails. Empty is fine for local dev/CI — the
  // crypto seam injects a fixed test key there — but a real connect without a
  // key throws a clear config error. Legacy plaintext rows still read fine with
  // no key (decrypt passes them through), so this isn't a fail-closed env guard.
  FIELD_ENCRYPTION_KEY: z.string().default(""),

  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),

  DOCUSIGN_INTEGRATION_KEY: z.string().default(""),
  DOCUSIGN_USER_ID: z.string().default(""),
  DOCUSIGN_ACCOUNT_ID: z.string().default(""),
  DOCUSIGN_PRIVATE_KEY: z.string().default(""),
  DOCUSIGN_BASE_URL: z.string().default(""),
  // HMAC key configured in DocuSign Admin → Connect. When set, the public
  // /api/docusign/webhook handler requires a valid X-DocuSign-Signature-* header
  // (HMAC-SHA256 over the raw body) and rejects anything else with 401.
  // Fail-closed (#176): REQUIRED in Vercel production (superRefine below makes
  // env() throw), and the webhook route rejects every POST with 401 whenever
  // the webhook is live (DOCUSIGN_WEBHOOK_URL set) or VERCEL_ENV=production
  // and no key is configured. Empty only disables verification in local
  // dev/CI/previews where the webhook isn't live (legacy/demo).
  DOCUSIGN_CONNECT_HMAC_KEY: z.string().default(""),
  // JSON map of formKey → {templateId, label, roleMapping, purpose?} for ad-hoc
  // / override forms defined entirely in env (lib/docusign-templates.ts). The
  // committed registry (lib/contract-forms.ts) is the primary source now; this
  // still works and wins on key conflict. Parsed lazily so a malformed value
  // breaks template routes with a clear error instead of every env() call.
  DOCUSIGN_TEMPLATES: z.string().default("{}"),
  // JSON map of committed-form key → DocuSign templateId, e.g.
  // {"buyer_agency_agreement":"<demo-or-prod-template-guid>"}. The committed
  // registry holds each form's structure; only its template id is env-specific,
  // so Go-Live is swapping these ids. A committed form with no id here is not
  // live (hidden from the picker, unsendable).
  DOCUSIGN_TEMPLATE_IDS: z.string().default("{}"),
  // Public webhook URL DocuSign POSTs envelope/recipient events to (e.g.
  // https://app.realtourflow.com/api/docusign/webhook). When set, every
  // envelope is created with a code-controlled eventNotification — survives
  // Go-Live with no admin-UI Connect setup. Empty = no eventNotification.
  DOCUSIGN_WEBHOOK_URL: z.string().default(""),

  ARIVE_API_URL: z.string().default(""),
  ARIVE_API_KEY: z.string().default(""),
  ARIVE_CLIENT_ID: z.string().default(""),
  ARIVE_CLIENT_SECRET: z.string().default(""),
  ARIVE_WEBHOOK_URL: z.string().default(""),
  // Shared secret the ARIVE loan-milestone webhook (/api/arive/webhook)
  // authenticates against — a token in the `x-arive-token` header or a
  // `?token=` query param must equal this value. Same fail-closed shape as
  // INDEXNOW_WEBHOOK_SECRET: empty = the endpoint is disabled (503; never
  // compare against an empty secret); wrong/missing token = 401. ARIVE exposes
  // no HMAC request-signing scheme, so a static shared secret is the gate; the
  // handler re-fetches authoritative loan state from ARIVE anyway, so the body
  // is never trusted beyond loanId (#270).
  ARIVE_WEBHOOK_SECRET: z.string().default(""),

  GOOGLE_OAUTH_CLIENT_ID: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(""),
  GOOGLE_OAUTH_REDIRECT_URL: z.string().default(""),

  // HMAC key for the short-lived, signed CSRF state cookie used by the calendar
  // OAuth connect flows (lib/oauth-state.ts). Outside Vercel production it
  // falls back to a dev value when unset or empty so local dev / CI / previews
  // work without config. In production (VERCEL_ENV=production) it is REQUIRED
  // with at least 32 chars — enforced by the superRefine below, which makes
  // env() throw instead of silently using the committed fallback.
  OAUTH_STATE_SECRET: z.string().default(""),

  MICROSOFT_OAUTH_CLIENT_ID: z.string().default(""),
  MICROSOFT_OAUTH_CLIENT_SECRET: z.string().default(""),
  MICROSOFT_OAUTH_REDIRECT_URL: z.string().default(""),
  MICROSOFT_OAUTH_TENANT: z.string().default("common"),

  // Shared secret for the cron-invoked job sweep (/api/jobs/process). When the
  // env var exists, Vercel automatically sends `Authorization: Bearer <value>`
  // on cron invocations. Empty = the sweep endpoint is disabled (503).
  CRON_SECRET: z.string().default(""),

  RESEND_API_KEY: z.string().default(""),
  // From-address for transactional email. Defaults to Resend's shared sandbox
  // sender; set to a verified-domain address (e.g. "RealTourFlow
  // <invites@realtourflow.com>") in production.
  RESEND_FROM: z.string().default("RealTourFlow <onboarding@resend.dev>"),

  // AI field-mapping for the agent form-upload pipeline (lib/form-ai). Empty key
  // disables the mapper — uploaded forms then land with every field flagged for
  // human review. The model is swappable; defaults to the latest Opus.
  ANTHROPIC_API_KEY: z.string().default(""),
  FORM_AI_MODEL: z.string().default("claude-opus-4-8"),

  // Cost gate for the Claude-vision property photo analysis (#375/#377). The
  // feature is PARKED — no UI surfaces it — but its endpoint is still live and
  // would spend on ANTHROPIC_API_KEY per call, so it is disabled by default:
  // POST /deals/:id/properties/:propId/analyze-photos returns 503 unless this is
  // set to a truthy value ("true"/"1"). Flip it in the Vercel env when photo-AI
  // is re-surfaced (and build real caching/rate-limits then). Comps are
  // unaffected — they run on the agent's own MLS credentials, not our AI bill.
  PROPERTY_PHOTO_AI_ENABLED: z.string().default(""),

  // Notion-powered marketing blog (lib/notion.ts → /blog on realtourflow.com).
  // NOTION_TOKEN is an internal-integration secret that has been shared with the
  // "Blog Posts" database; NOTION_BLOG_DATABASE_ID is that database's id. Both
  // empty = blog feature disabled (the /blog routes render an empty state).
  NOTION_TOKEN: z.string().default(""),
  NOTION_BLOG_DATABASE_ID: z.string().default(""),

  // Shared secret for the Notion "Send webhook" automation that pings IndexNow
  // the instant a blog post flips to Published (/api/indexnow/notion?token=…).
  // Empty = that webhook endpoint is disabled (503); the daily cron sweep is
  // unaffected. Kept distinct from CRON_SECRET so a token that rides in a URL
  // can't be replayed against the cron/ops endpoints.
  INDEXNOW_WEBHOOK_SECRET: z.string().default(""),

  // Shared secret gating /api/invites/role — the email→role lookup the Auth0
  // Post-Login Action calls to resolve a signing-in user's role. Without it the
  // route is an unauthenticated oracle for enumerating accounts/invites (#271).
  // The Action must send it in the `x-invite-role-token` header. Empty = the
  // route is disabled (503); a wrong/missing token → 401 (fail closed).
  INVITE_ROLE_SECRET: z.string().default(""),
});

const schema = shape
  // Fail closed in production: the committed dev fallback must never sign
  // real OAuth state cookies. env() is lazy (called at request time, not
  // import time), so a missing secret surfaces as a thrown ZodError on the
  // first request that touches env() — the message below lands in the
  // function logs and names the variable.
  .superRefine((vals, ctx) => {
    if (
      vals.VERCEL_ENV === "production" &&
      vals.OAUTH_STATE_SECRET.length < MIN_OAUTH_STATE_SECRET_LENGTH
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["OAUTH_STATE_SECRET"],
        message:
          `OAUTH_STATE_SECRET must be set to a random value of at least ` +
          `${MIN_OAUTH_STATE_SECRET_LENGTH} characters when ` +
          `VERCEL_ENV=production — refusing to fall back to the committed ` +
          `dev secret. Set OAUTH_STATE_SECRET in the Vercel project ` +
          `environment variables.`,
      });
    }

    // Fail closed in production for the public DocuSign webhook (#176): with
    // no HMAC key the handler would trust any POST — an attacker who learns
    // an envelopeId could forge "completed" status, BAA-signed state, and
    // archival. Mirror the OAUTH_STATE_SECRET guard: require the key whenever
    // VERCEL_ENV=production. (Outside production the webhook route itself
    // rejects unsigned POSTs with 401 when DOCUSIGN_WEBHOOK_URL is set.)
    if (
      vals.VERCEL_ENV === "production" &&
      vals.DOCUSIGN_CONNECT_HMAC_KEY.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DOCUSIGN_CONNECT_HMAC_KEY"],
        message:
          `DOCUSIGN_CONNECT_HMAC_KEY must be set when VERCEL_ENV=production ` +
          `— without it the public /api/docusign/webhook would trust ` +
          `unsigned POSTs (forged envelope completion). Generate the HMAC ` +
          `key in DocuSign Admin → Connect and set it in the Vercel project ` +
          `environment variables.`,
      });
    }

    // Fail closed in production for the Blob capability-URL signing key
    // (#188): hmacSecret() used to degrade to BLOB_STORE_ID — a visible
    // identifier (Vercel dashboard, env listings, blob hostnames), not a
    // secret — letting anyone who learns the store id forge a valid
    // upload/download capability for any key. Mirror the OAUTH_STATE_SECRET
    // guard: require a dedicated random secret whenever VERCEL_ENV=production.
    if (
      vals.VERCEL_ENV === "production" &&
      vals.BLOB_CAP_SECRET.length < MIN_BLOB_CAP_SECRET_LENGTH
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["BLOB_CAP_SECRET"],
        message:
          `BLOB_CAP_SECRET must be set to a random value of at least ` +
          `${MIN_BLOB_CAP_SECRET_LENGTH} characters when ` +
          `VERCEL_ENV=production — Blob capability URLs must never be ` +
          `signed with the store id or the committed dev fallback. ` +
          `Generate one (e.g. \`openssl rand -hex 32\`) and set ` +
          `BLOB_CAP_SECRET in the Vercel project environment variables.`,
      });
    }
  })
  // Dev/test/preview convenience: unset or empty resolves to the dev value.
  // Unreachable in production — the refine above already rejected anything
  // shorter than 32 chars there.
  .transform((vals) => ({
    ...vals,
    OAUTH_STATE_SECRET: vals.OAUTH_STATE_SECRET || DEV_OAUTH_STATE_SECRET,
    BLOB_CAP_SECRET: vals.BLOB_CAP_SECRET || DEV_BLOB_CAP_SECRET,
  }));

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    cached = schema.parse(process.env);
  }
  return cached;
}

/**
 * Test seam — drops the cached parse so the next `env()` re-reads `process.env`.
 * Call after mutating `process.env` in a test so the change is observed; the
 * cache is a per-process snapshot otherwise.
 */
export function resetEnvForTesting(): void {
  cached = undefined;
}
