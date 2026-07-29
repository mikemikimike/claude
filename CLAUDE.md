# RealTourFlow — CLAUDE.md

> This file is the authoritative orientation guide for every Claude session.
> Read this before writing any code. Keep it updated whenever architecture, migrations, or
> the feature surface change.

---

## The App: `web/` (Next.js 16 + Prisma 7 on Vercel)

**RealTourFlow is a single Next.js 16 app under `web/`** — one project serving both the UI
and the API, deployed on Vercel. There is no separate backend or frontend.

> The legacy stack — Go + chi API (`backend/`) and React + Vite SPA (`frontend/`) — has
> been **removed** from the repo. Its golang-migrate SQL was relocated to the top-level
> `migrations/` directory (still the schema source of truth). The old AWS ECS service is
> no longer deployed to by CI and is pending infrastructure teardown (see Infrastructure).

**`web/` conventions (read before coding):**
- **Next.js 16** has breaking changes — read `node_modules/next/dist/docs/` first
  (`web/AGENTS.md` mandates it). Route handlers are async `(req, ctx)` where `ctx.params`
  is a `Promise`.
- External clients expose a `setXForTesting()` seam (e.g. `web/lib/stripe.ts`,
  `web/lib/arive.ts`, `web/lib/auth0.ts`, `web/lib/docusign.ts`); tests inject fakes and
  never hit real APIs (CI has no secrets).
- **Migrations:** golang-migrate SQL in `migrations/{version}_*.{up,down}.sql`, then
  `npm run prisma:pull` to sync `web/prisma/schema.prisma`. Not `prisma migrate` (see
  Database Migrations).
- Develop on **Node 22** (`web/.nvmrc`).

---

## What This Is

RealTourFlow is a stage-based real estate deal operating system built for real estate agents.
It tracks buyer and seller deals through 7 stages (intake → post_close), manages tasks per deal,
coordinates with a transaction coordinator (TC), surfaces client portals for buyers/sellers,
and integrates with ARIVE (loan milestone sync) for Mountain Mortgage / Fast Pass buyers only.

**Owner:** Paul Leara (paul@mountain.mortgage, Mountain Mortgage)
**Target launch:** Real agents on it before end of June 2026
**Build philosophy:** Production-grade, not prototype. Build it right.

---

## Stack

| Layer | Technology |
|---|---|
| App | Next.js 16 (App Router) — serves UI **and** API in one project |
| ORM / DB access | Prisma 7 (driver-adapter, introspection-only) |
| Database | Neon serverless Postgres (`neondb`) |
| File storage | Vercel Blob (private store) via HMAC capability URLs; S3 retired |
| Auth | Auth0 (JWT RS256, JWKS validation) |
| UI | React (Server + Client Components), Tailwind 4 |
| Background jobs | pg-boss durable queue + a Vercel Cron sweep (calendar push) |
| Tests | Vitest (unit/integration) + Playwright (E2E), enforced in CI |
| Hosting | Vercel |
| CI/CD | GitHub Actions `web-ci.yml` (typecheck → lint → Vitest → build; Playwright E2E) |
| Local DB | Docker Compose (`postgres:16-alpine`) |

The legacy Go + chi backend and React + Vite frontend have been removed.

---

## Infrastructure

**Current (serves production):**

| Resource | Value |
|---|---|
| App hosting | Vercel — production domain `app.realtourflow.com` |
| Database | Neon serverless Postgres — DB `neondb`, endpoint `ep-winter-fire-apcnrqsw` (us-east-1); injected via the Vercel Production `DATABASE_URL` (a **Sensitive** var — not readable through the CLI) |
| Document storage | Vercel Blob **private** store (`BLOB_STORE_ID` set in Prod; OIDC auth at runtime). S3 retired — see the storage note below |
| Auth0 Tenant | `realtourflow-prod.us.auth0.com` (production). The old `dev-30md8ukv8qd3u27c.us.auth0.com` is the **dev** tenant — the live app authenticates against the prod tenant |
| Auth0 Audience | https://api.realtourflow.com |
| Auth0 SPA Client ID | `lEvAKBEQW00LEiUySQiIawrlu0q32tvJ` (prod tenant; the dev-tenant id was `JMIZVqGbZ6KRmJGHyowg5kopHRmHGVhe`) |
| Secrets | Vercel project env vars (Production / Preview) |

**Legacy AWS (pending decommission — no longer deployed to):** the ECS service
`realtourflow-api` (cluster `realtourflow`), its ALB, the ECR repo, the
`/ecs/realtourflow-api` CloudWatch log group, the `realtourflow/*` Secrets Manager
secrets, and the `api.realtourflow.com` DNS record still exist and the old Go API still
answers, but CI no longer redeploys it (the `deploy.yml` workflow was deleted). Draining
and deleting that infra is an open ops task that needs AWS credentials. **File storage
has been migrated off S3 to Vercel Blob** (a private store; uploads/downloads flow through
HMAC capability-URL proxy routes — `web/lib/blob-storage.ts`). The old
`realtourflow-documents` S3 bucket + AWS SDK are retired: `web/` no longer touches S3, so
the bucket is now a decommission candidate too (any documents uploaded before the cutover
still live only in that bucket — migrate or re-upload them before deleting it).
⚠️ The production **database is Neon, not RDS**
(verified 2026-06-24 by a runtime probe — `current_database()` returned `neondb`). The AWS
RDS in account 508859666048 is **not used by the live app** and is itself a decommission
candidate (verify before deleting).

---

## Local Development

### Prerequisites
- **Node 22** (`web/.nvmrc`)
- Docker Desktop (local Postgres)
- `golang-migrate` CLI (`brew install golang-migrate`)

### Run it
```bash
make db        # start local Postgres (docker compose)
DATABASE_URL="postgres://postgres:postgres@localhost:5432/realtourflow?sslmode=disable" make migrate
make install   # cd web && npm install
make dev       # cd web && npm run dev  → http://localhost:3000
```
`make dev | test | typecheck | lint | build` target `web/`; `make migrate` runs
golang-migrate against `migrations/`.

### Environment
`web/` reads env from `web/.env.local` (gitignored). See `web/.env.example` for the keys —
Auth0 (incl. the Management API M2M for email verification), `DATABASE_URL`, Vercel Blob
(`BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` — set one for local file storage), Stripe,
ARIVE, DocuSign, Resend, calendar OAuth, and `CRON_SECRET`. Production values live in the
Vercel project env.

---

## Database Migrations

### Protocol
1. Write `migrations/{version}_{title}.up.sql` + `.down.sql` (6-digit zero-padded, e.g.
   `000034_...`). The next version is one above the highest number in `migrations/`.
2. Apply locally: `DATABASE_URL="..." make migrate`.
3. Sync Prisma: `cd web && npm run prisma:pull` (regenerates `web/prisma/schema.prisma`
   from the live schema). Commit both the SQL and the schema change.
4. CI applies the migrations to fresh throwaway DBs for the `test` and `e2e` jobs.

> **Engine:** golang-migrate (a standalone SQL runner), NOT `prisma migrate`. The SQL in
> `migrations/` is the schema source of truth; Prisma is introspection-only here.

> ⚠️ **Production application is a known gap.** The retired ECS server used to auto-run
> `migrate.Up()` on startup; with ECS no longer deployed to (`deploy.yml` deleted), **new**
> migrations no longer reach prod Neon automatically. Until a replacement exists (a CI /
> Vercel deploy step, or the deferred switch to `prisma migrate deploy`), apply new
> migrations to prod manually:
> `migrate -path migrations -database "$PROD_DATABASE_URL" up` — where `$PROD_DATABASE_URL`
> is the Neon `neondb` connection string (pull it from the Neon console; the Vercel var is
> Sensitive and can't be read via the CLI). **As of 2026-06-24, prod Neon is at version 45**
> — migrations 000034–000045 were applied manually that day (prod had drifted behind to 33,
> so 34–37, which back already-shipped launch features, were applied alongside 38–45).

---

## API Endpoints

Routes are Next.js App Router handlers under `web/app/api/**/route.ts`, mounted at `/api`.
Protected routes require `Authorization: Bearer <Auth0 JWT>`. This lists the **core**
surface — it is not exhaustive; browse `web/app/api/` for everything else (vendors, MLS,
TC settings, doc-templates, participants, fastpass/smoothexit, disclosure-packet,
password-reset, verification, jobs/process, docusign, stripe/arive webhooks, …).

| Method | Path | Auth | Operation | Notes |
|---|---|---|---|---|
| GET | /health | — | Health | Returns `{"status":"ok"}` |
| POST | /users/sync | ✅ | SyncUser | Upserts user from JWT; requires role in Auth0 custom claim |
| GET | /users | ✅ | ListUsers | Admin-only; all platform users ordered by role, name |
| GET | /deals | ✅ | ListDeals | Agent's deals ordered by updated_at desc |
| POST | /deals | ✅ | CreateDeal | Creates deal at intake stage |
| GET | /deals/:dealId | ✅ | GetDeal | Ownership-checked |
| PATCH | /deals/:dealId/stage | ✅ | AdvanceStage | Writes deal_stage_history row |
| GET | /deals/:dealId/tasks | ✅ | ListTasks | Ownership-checked via deal |
| POST | /deals/:dealId/tasks | ✅ | CreateTask | Auto-tasks posted here on stage advance; optional `assigned_to` |
| PATCH | /tasks/:taskId/status | ✅ | UpdateTaskStatus | Ownership-checked via deal join |
| GET | /deals/:dealId/messages | ✅ | ListMessages | `?channel=client_thread\|internal`; joins sender name/role |
| POST | /deals/:dealId/messages | ✅ | CreateMessage | Returns full message with sender info |
| GET | /deals/:dealId/documents | ✅ | ListDocuments | Ownership-checked; returns docs with uploader name |
| POST | /deals/:dealId/documents/upload-url | ✅ | GetUploadURL | Blob upload capability URL (`/api/storage/blob-put`) + s3_key |
| POST | /deals/:dealId/documents | ✅ | CreateDocument | Confirms upload; stores name, s3_key, mime_type, file_size |
| GET | /documents/:documentId/download-url | ✅ | GetDownloadURL | Blob download capability URL (`/api/storage/blob-get`); ownership-checked first |
| DELETE | /documents/:documentId | ✅ | DeleteDocument | DB record + best-effort Blob delete |
| GET | /vendors | ✅ | ListVendors | Agent-scoped; ordered by category, sort_order |
| POST/PATCH/DELETE | /vendors[/:vendorId] | ✅ | Vendor CRUD | Agent-scoped |
| GET | /me/deals | ✅ | ListMyDeals | Deals where the JWT user is a participant; includes agent contact |
| GET | /deals/:dealId/participants | ✅ | ListParticipants | Agent or any participant |
| POST | /deals/:dealId/participants | ✅ | AddParticipant | Agent-only; body `{user_id\|email, role}` |
| DELETE | /deals/:dealId/participants/:userId | ✅ | RemoveParticipant | Agent-only |
| GET/POST/PATCH/DELETE | /deals/:dealId/checklist[/:itemId] | ✅ | Checklist | TC/admin/agent/participant; auto-seeds defaults at under_contract+ |

### Auth0 JWT custom claims
The Post-Login Action injects roles into the JWT:
```
https://realtourflow.com/roles: ["agent"]  // or buyer, seller, admin, tc, lending_partner
```
`SyncUser` reads this claim. A user with no role gets 403.

**Where roles actually come from:** the Post-Login Action reads `event.authorization.roles`
— i.e. **Auth0 RBAC role assignments** (the user's *Roles* tab in the Auth0 dashboard), NOT
`app_metadata`. `web/` never writes roles to Auth0; it only mirrors the claim into
`users.role` on sync. So the assignment lives in Auth0 RBAC (or, for a freshly-invited agent
whose token has no claim yet, the DB role persisted by the invite-claim path).

**To change someone's role (e.g. make an admin):** assign the role in the Auth0 prod tenant
(User Management → Users → *Roles* tab), then have them **log out and back in** — the role is
baked into the JWT at login, and `POST /api/users/sync` overwrites `users.role` from the
fresh claim (`web/lib/users.ts` — `role = EXCLUDED.role`). There is **no in-app admin
promotion and no email allowlist**; admin is granted only via Auth0 RBAC. A DB-only
`UPDATE users SET role=...` is not durable — the next login's JWT claim overwrites it.

---

## Auth Architecture

Auth0 JWT is the source of truth end-to-end.
- `Auth0Provider` is configured in `web/components/Providers.tsx` (reads `NEXT_PUBLIC_AUTH0_*`).
- On login the client calls `POST /api/users/sync` to upsert the user; the response
  (DB UUID, name, email, role) drives the client identity store.
- Server routes validate every protected request via JWKS — `web/lib/auth.ts` plus
  `withAuth` in `web/lib/http.ts`.
- Roles: `agent`, `buyer`, `seller`, `admin`, `tc`, `lending_partner`. Server-side scoping
  is the security boundary; client-side role gating is UX only.
- Forgot-password and resend-verification live under `web/app/api/auth/*`
  (`web/lib/auth0.ts` wraps the public change-password endpoint + the Management API).

---

## Feature Status

The app is wired to the real API + database end-to-end. (The old `frontend/` mock-data
inventory was retired with that stack.) Features ported into `web/` during EPIC #56 and the
fast-follow milestone, now live:

| Feature | Endpoint(s) / module |
|---|---|
| Vendor directory | `/api/vendors` |
| MLS / SimplyRETS creds + listing search | `/api/me/mls`, `/api/deals/:id/listings/search` |
| Agent doc-templates | `/api/me/doc-templates` |
| TC settings | `/api/me/tc`, `/api/me/agents` |
| Property mutations (status / notes / offer-request / delete) | `/api/deals/:id/properties/:propId` |
| Agent invites | `/api/admin/agent-invites`, `/api/agent-invites/:token` |
| Fast Pass collect / Smooth Exit enroll | `/api/deals/:id/fastpass/collect`, `/api/deals/:id/smoothexit` |
| Notification emails (message / doc / task) | `web/lib/notification-email.ts` (Resend, best-effort) |
| Password reset + email verification | `/api/auth/password-reset`, `/api/auth/verification` |
| Durable calendar push | pg-boss queue (`web/lib/queue.ts`) + `/api/jobs/process` cron sweep |
| Disclosure packet (merge PDFs + e-sign) | `/api/deals/:id/disclosure-packet` |

---

## Key Files

| File | Purpose |
|---|---|
| `web/app/api/**/route.ts` | API route handlers (one directory per resource) |
| `web/lib/http.ts` | `withAuth`, `json`, `error` helpers |
| `web/lib/db.ts` | Prisma client (lazy driver-adapter) |
| `web/lib/users.ts` / `web/lib/roles.ts` / `web/lib/auth.ts` | `resolveUserId`/`upsertUser`, `hasRole`, JWKS verification |
| `web/lib/s3.ts` | Storage facade (Blob-backed) — capability URLs + get/put/delete object; `setStorageForTesting` seam lives in `blob-storage.ts` |
| `web/lib/blob-storage.ts` | Vercel Blob backend + HMAC capability signing; `/api/storage/blob-{put,get}` proxy the private-store uploads/downloads |
| `web/lib/{stripe,arive,docusign,simplyrets,auth0,email}.ts` | External clients (each with a `setXForTesting()` seam) |
| `web/lib/{jobs,queue,calendar}.ts` | Calendar push + durable pg-boss queue |
| `web/lib/{disclosures,docusign-documents}.ts` | Disclosure-packet merge + shared DocuSign envelope send |
| `web/prisma/schema.prisma` | Prisma schema (introspected — never hand-author tables) |
| `web/components/pages/agent/DealDetail.tsx` | Deal detail + tabs (tasks, docs, messages, vendors, participants) |
| `web/tests/setup/{global-setup,db}.ts` | Test DB bootstrap (runs golang-migrate from `migrations/`) |
| `migrations/` | golang-migrate SQL (schema source of truth) |
| `web/AGENTS.md` | "This is not the Next.js you know" — read the Next 16 docs first |

---

## Deploy Protocol

`web/` deploys via Vercel (the project tracks `main`).
1. **Pre-push:** `make typecheck && make lint && make test` green. For new migrations,
   `make migrate` locally + `npm run prisma:pull`.
2. **PR → CI** (`web-ci.yml`): typecheck → lint → Vitest → production build, plus the
   Playwright E2E job. Merge on green.
3. **Vercel** builds + deploys `web/` on merge to `main`.
4. **Migrations:** apply to prod Neon per the Database Migrations note (not automatic).
5. **Smoke test** on `app.realtourflow.com`: log in (Auth0 → `/api/users/sync` 200), create
   a deal, advance a stage, reload to confirm persistence.
6. **Update this file** when architecture, migrations, or the feature surface change.

---

## Calendar OAuth Setup (Google + Microsoft)

Settings → Integrations lets agents connect Google Calendar / Outlook so RealTourFlow
pushes closing dates + task deadlines into their calendar. The code path is built
(`oauth_tokens` table, refresh-on-expiry, fan-out from stage advance / ARIVE sync / task
create+update via the pg-boss queue).

> ✅ **DONE / LIVE (configured ~June 2026).** The Google Cloud OAuth client and the Microsoft
> Azure app registration are both created and their credentials (`GOOGLE_OAUTH_*`,
> `MICROSOFT_OAUTH_*`) are set in the Vercel Production env. Calendar connect works in
> production — do **not** tell anyone this is still "pending." The setup steps below are kept
> only as reference for reproducing it in a new environment.

### Google Cloud — OAuth client
1. https://console.cloud.google.com/apis/credentials → Create OAuth 2.0 Client ID, **Web application**
2. Authorized redirect URIs:
   - Production: `https://app.realtourflow.com/api/integrations/google-calendar/callback`
   - Local: `http://localhost:3000/api/integrations/google-calendar/callback`
3. Enable the **Google Calendar API**
4. Consent-screen scopes: `auth/calendar.events`, `auth/userinfo.email`, `openid`
5. Copy the Client ID + Secret

### Microsoft Azure — App registration
1. https://portal.azure.com → App registrations → New registration
2. Accounts in any org directory + personal Microsoft accounts (`common` tenant)
3. Redirect URI (Web):
   - Production: `https://app.realtourflow.com/api/integrations/microsoft-calendar/callback`
   - Local: `http://localhost:3000/api/integrations/microsoft-calendar/callback`
4. API permissions → Microsoft Graph → Delegated: `Calendars.ReadWrite`, `User.Read`, `offline_access`
5. Certificates & secrets → New client secret → copy the Application (client) ID + secret value

### Credentials
Add to `web/.env.local` (and the Vercel project env for prod):
```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URL=https://app.realtourflow.com/api/integrations/google-calendar/callback
MICROSOFT_OAUTH_CLIENT_ID=...
MICROSOFT_OAUTH_CLIENT_SECRET=...
MICROSOFT_OAUTH_REDIRECT_URL=https://app.realtourflow.com/api/integrations/microsoft-calendar/callback
MICROSOFT_OAUTH_TENANT=common
```
(Use the `http://localhost:3000/...` redirect URLs locally.)

### How event push works
- `oauth_tokens` stores per-agent access/refresh tokens; `calendar_event_map` records the
  external event ID so updates patch the same event instead of duplicating.
- Triggers: deal stage advance, ARIVE sync (when key dates update), task create/update.
- Push is durable: enqueued to pg-boss, attempted inline, and retried by the
  `/api/jobs/process` cron sweep on transient failure. Idempotent via `calendar_event_map`.

---

## Design Principles (Don't Drift From These)

- **ARIVE scope:** ARIVE integration is only for deals where the buyer uses Mountain
  Mortgage / Fast Pass (`arive_linked = true`). Outside-lender deals are manual updates.
- **Role enforcement:** all data scoping is server-side. Client-side role gating is UX
  convenience, never a security control.
- **Stage history:** every stage transition — advance or retreat — writes a
  `deal_stage_history` row. Never update stage without it.
- **UUIDs only:** the database uses UUIDs; never send placeholder/mock IDs to the API.
- **Migration discipline:** never alter a production table by hand — every schema change is
  a numbered migration in `migrations/`, then `npm run prisma:pull`.
- **Debug via Vercel logs:** whenever there's a bug or a reported issue, check the Vercel
  logs first (runtime logs / build logs for the affected deployment) before guessing — the
  app runs on Vercel, so the real error and stack trace are there. Use the Vercel MCP
  (`get_runtime_logs` / `get_runtime_errors` / `get_deployment_build_logs`) or `vercel logs`.
