# RealTourFlow — CLAUDE.md

> This file is the authoritative orientation guide for every Claude session.
> Read this before writing any code. Keep it updated whenever architecture, migrations, or
> the feature surface change.

> **When this file doesn't have what you need, check the quick reference:**
> `~/Desktop/RealTourFlow-Quick-Reference.md` (Paul's cheat sheet — lives outside the repo and
> is not version-controlled). CLAUDE.md owns the *architecture*; the quick reference owns the
> *business surface* — invite-only onboarding paths, agent/buyer/seller pitch scripts, the full
> URL reference (app, forgot-password, Mountain Mortgage 1003 application, review link), and
> the live system-enforced Fast Pass / Smooth Exit pricing. Treat it as a second source of
> truth, not a fallback.
>
> ⚠️ It also holds a plaintext production admin login. **Never type credentials into a form** —
> that is off-limits regardless of who asks; hand the login step back to Paul instead.

---

## ⛔ FIRST, EVERY SESSION: sync with `origin/main`

**Before reading code, planning, or writing a line — fetch and work from `origin/main`.**
The local checkout is routinely far behind (this has bitten us: a session once planned an
entire fix against a local `main` that was **85 commits stale**, and half the "missing" code
it set out to write already existed on the remote).

```bash
git fetch origin && git log --oneline -1 origin/main
git rev-list --left-right --count main...origin/main   # left=local-only, right=behind
```

Then, before touching anything:

1. **Branch off `origin/main`, not local `main`:**
   `git checkout -b <branch> origin/main` (stash unrelated working-tree edits first).
   Already on a branch? `git fetch origin && git rebase origin/main`.
2. **Verify every file you plan to change against `origin/main`** — not against what's on
   disk, and not against a stale memory of it. `git show origin/main:<path>` /
   `git diff main origin/main -- <paths>`. Line numbers and helpers move.
3. **Check whether the thing already exists.** Search `origin/main` before building a
   utility, endpoint, or guard — recent PRs may already have shipped it.
4. **After switching branches, regenerate the Prisma client:** `cd web && npm run prisma:generate`.
   A stale `web/app/generated/prisma` shows up as a wall of bogus typecheck errors in test
   files (`Property 'x' does not exist on type dealsSelect`), not as a schema error.

Caveats seen in this repo (iCloud-synced `.git`): `git fetch` sometimes hangs — retry it in
the background rather than assuming the refs are current. And if `next build` dies with
`ENOENT … .next/cache`, that symlink points at `/tmp/rtf-cache`, which macOS clears:
`mkdir -p /tmp/rtf-cache`.

---

## Known state (updated 2026-08-03)

Read this before reporting a "bug" — these are already understood, so you can tell a new
problem from a known one.

**Prod is genuinely small.** 5 deals, 10 users, 1 document. Almost any "this would be slow /
this would break at scale" concern is theoretical today — say so rather than implying users
are affected. Equally, a bug that only shows up under load will not reproduce here.

**Known-open, all deliberately not fixed:**
- **One stranded document** — a single pre-cutover PDF (see the storage note below). Fix is
  re-uploading it, not code.
- **`roleForEmail` / `pendingInviteRole` use raw SQL** — deliberate, index-related. See the
  Key Files table before "cleaning it up".
- **`users.email` is unique only case-SENSITIVELY** while the app matches case-insensitively
  everywhere. No collisions exist (checked 2026-08-03); the lookups order by `created_at` so
  a future one can't return an arbitrary row. Enforcing case-insensitive uniqueness is a
  deliberate non-change — it would regress #277's clean 409 to an opaque 500.
- **Legacy AWS is still billing** — ECS/ALB/ECR/RDS/S3 all undeployed but not deleted.

**Recently fixed — don't "re-discover" these:**
- Invited clients becoming agents (role precedence — `decideRole`, #388)
- No logout anywhere (#388)
- Fast Pass charging $2,977 against an advertised $1,787 (#389) — nobody was ever billed the
  wrong amount; it was caught before any enrollment
- Both email lookups falling back to sequential scans (#393, #394)

**The environment will fight you.** This repo lives on an iCloud-synced volume:
`git fetch` intermittently hangs or dies on duplicate `refs/remotes/origin/main 2` files
(delete them and retry), `tsc`/`eslint` sometimes take >10 minutes or stall entirely, and
`next build` fails with `ENOENT .next/cache` whenever macOS clears `/tmp/rtf-cache`
(`mkdir -p /tmp/rtf-cache`). None of these are code problems. When a local check stalls, CI
is the reliable verifier.

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
| Auth0 Tenant | **`realtourflow-prod.us.auth0.com`** — the live app authenticates here (verified 2026-08-01 by driving `app.realtourflow.com` in a browser). `dev-30md8ukv8qd3u27c.us.auth0.com` is the **dev** tenant; a local `npm run dev` uses it, so a login working locally proves nothing about prod |
| Auth0 Audience | https://api.realtourflow.com |
| Auth0 SPA Client ID | **`lEvAKBEQW00LEiUySQiIawrlu0q32tvJ`** (prod tenant). The dev-tenant id is `JMIZVqGbZ6KRmJGHyowg5kopHRmHGVhe` |
| Auth0 Allowed Logout URLs | `https://app.realtourflow.com`, `http://localhost:3000` — **required**; a `returnTo` not on this list strands the user on an Auth0 error page instead of returning them to the app |
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
the bucket is now a decommission candidate too.
> 📌 **Open, but tiny — exactly ONE stranded document.** The cutover (`93f15574e`,
> 2026-07-08T04:57:17Z) made every read resolve the stored key against Blob, but nothing
> copied the existing objects across, so any `documents` row older than that points at an
> S3-only object and fails to open. **Measured against prod 2026-08-03: 1 document row in the
> entire database, and it is the affected one** — a 398KB "Buyer Agency Agreement" PDF from
> 2026-06-09. Nobody is realistically hitting this.
> Fix: re-upload that one PDF through the app. Then the `realtourflow-documents` bucket can
> be deleted. `web/scripts/backfill-s3-to-blob.ts` exists for the general case (copies each
> object into Blob under the identical key, so no DB change; report-only by default) but is
> overkill for a single file and **has never been run** — it needs AWS read credentials.
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

> ✅ **Prod migrations are AUTOMATIC — do not apply them by hand.** The
> `.github/workflows/prod-migrate.yml` action (#208) runs `golang-migrate up` against prod
> Neon on every push to `main` that touches `migrations/**`, and prints the schema version
> before and after. Merging a PR with a migration applies it within a minute or so.
> **As of 2026-08-03 prod Neon is at version 62.**
>
> Two consequences worth internalising before you touch `migrations/`:
> - **Merging = migrating.** There is no separate "deploy the migration" step to forget, and
>   equally no chance to review it against prod first. A destructive migration reaches
>   production the moment the PR merges.
> - **Check the next free number against `origin/main`, not your local tree.** Two branches
>   open at once will both pick the same number, and golang-migrate refuses to load a
>   directory containing a duplicate version — which takes down *every* CI job before a
>   single test runs, on every open PR. This has already happened once (see the fetch-first
>   rule at the top of this file).
>
> A one-off manual run is still possible with
> `migrate -path migrations -database "$PROD_DATABASE_URL" up`. The Neon connection string
> lives in `web/.env.neon` as `NEON_DIRECT_URL` (gitignored); the Vercel var is Sensitive and
> unreadable via the CLI.

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

### Role precedence — the JWT claim does NOT always win

The tenant grants every brand-new signup a default `agent` role (self-serve agent signup is
intentional). That made the claim unreliable as a statement of identity: an invited buyer's
role was written correctly by the invite claim, then overwritten with `agent` by the very next
`/users/sync`, dropping them into the agent app. `POST /api/users/sync` now resolves the role
through **`decideRole()` in `web/lib/roles.ts`** — the single place this rule lives (don't add
a second guard in `upsertUser` or the route):

1. An explicit **non-default** claim (`admin`, `tc`, `seller`, `buyer`, `lending_partner`) wins.
2. A persisted **`buyer`/`seller`/`tc`** is never overwritten by a default `agent` claim.
3. For a user with **no row yet**, a pending invite for their email beats the default claim —
   the safety net when the claim POST never ran. Two sources, checked in this order by
   `pendingRoleForEmail()` (`web/lib/invite-role.ts`):
   - an open (unclaimed, unexpired) `deal_invites` row → `buyer`/`seller`
   - an agent's unlinked TC assignment (`users.tc_contact` with `tc_user_id IS NULL`) → `tc`
4. Otherwise the claim, else the persisted role. No role anywhere = 403.

**To make someone an admin or TC:** unchanged — assign the role in the Auth0 prod tenant
(User Management → Users → *Roles* tab), then have them log out and back in. Rule 1 honours it.

**To move a client or TC to agent:** the `agent` claim alone will not do it (rule 2). Update
the row (`UPDATE users SET role='agent' WHERE …`) **and then** have them re-login — once
`users.role` is no longer an invited role, rule 4 honours the claim again. (Same caveat for
*demoting* a TC: revoking the Auth0 `tc` role is no longer sufficient on its own.)

### TC onboarding — the invite is the agent's own `tc_contact` row (#415)

There is deliberately **no `tc_invites` table**. When an agent saves a TC in Settings
(`PUT /api/me/tc`), the `users.tc_contact` JSON on their own row *is* the pending invite:

- `PUT /api/me/tc` links any account whose email matches (by **email alone** — requiring
  `role='tc'` is what made this unfixable, since the tenant hands every signup `agent`), and
  emails a real invite via `sendTcInviteEmail` when there is no account. Best-effort; the
  response's `invited` says whether it went out.
- The invite link carries **no token** — it points at the app root and is bound to the email.
- On signup, rule 3 above gives them `tc`; `linkTcContacts()` (`web/lib/users.ts`), called
  from `POST /api/users/sync`, sets the agent's `tc_user_id`. That also repairs TCs typed in
  before the fix, on their next login.
- `POST /api/deals/:id/participants` with `role: 'tc'` and an unknown email sends the **same**
  invite (202) rather than 404ing, and 409s instead of replacing an already-assigned TC.
- ⚠️ `lower(tc_contact->>'email')` has **no functional index** (that needs a migration). It is
  a seq scan over `users`, on first-sync role resolution and on every sync's backfill. Free at
  today's size; index it (mirroring 000061/000062) before `users` grows.

---

## Auth Architecture

Auth0 JWT is the source of truth end-to-end.
- `Auth0Provider` is configured in `web/components/Providers.tsx` (reads `NEXT_PUBLIC_AUTH0_*`).
- On login the client calls `POST /api/users/sync` to upsert the user; the response
  (DB UUID, name, email, role) drives the client identity store.
- Server routes validate every protected request via JWKS — `web/lib/auth.ts` plus
  `withAuth` in `web/lib/http.ts`.
- Roles: `agent`, `buyer`, `seller`, `admin`, `tc`, `lending_partner`. Server-side scoping
  is the security boundary; client-side role gating is UX only. See **Role precedence** above
  for how `/users/sync` picks one.
- Forgot-password and resend-verification live under `web/app/api/auth/*`
  (`web/lib/auth0.ts` wraps the public change-password endpoint + the Management API).
- **Logout:** `useLogout()` (`web/hooks/useLogout.ts`) is the single exit for every role,
  surfaced by `UserMenu` (`web/components/layout/UserMenu.tsx`) in all four shells, the
  onboarding wizard, and the `RootRedirect` error screens. It tears down local state (auth
  store, token getter, pending-invite keys) *before* redirecting. `returnTo` must be listed in
  the Auth0 application's **Allowed Logout URLs** — `https://app.realtourflow.com`,
  `http://localhost:3000`, and the preview origins — or Auth0 strands the user on its own
  error page.

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
| `web/lib/users.ts` / `web/lib/roles.ts` / `web/lib/auth.ts` | `resolveUserId`/`upsertUser`/`resolveSyncRole`, `hasRole`/`decideRole`, JWKS verification |
| `web/lib/invite-role.ts` | Email→role lookups (`pendingInviteRole`, `roleForEmail`). ⚠️ **Raw SQL on purpose** — `lower(email) = lower($1)` matches the functional indexes in migrations 000061/000062. Prisma's `mode: "insensitive"` emits `ILIKE`, which no btree can serve; "simplifying" it back silently restores a sequential scan on the login path |
| `web/hooks/useLogout.ts` / `web/components/layout/UserMenu.tsx` | The only logout path, in every role shell + onboarding + the RootRedirect error screens |
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
4. **Migrations:** applied to prod Neon **automatically** by `prod-migrate.yml` on merge —
   nothing to do, but see the Database Migrations note: merging *is* migrating.
5. **Smoke test** on `app.realtourflow.com`: log in (Auth0 → `/api/users/sync` 200), create
   a deal, advance a stage, reload to confirm persistence.
6. **Update this file** when architecture, migrations, or the feature surface change.

---

## Calendar OAuth Setup (Google + Microsoft)

Settings → Integrations lets agents connect Google Calendar / Outlook so RealTourFlow
pushes closing dates + task deadlines into their calendar. The code path is built
(`oauth_tokens` table, refresh-on-expiry, fan-out from stage advance / ARIVE sync / task
create+update via the pg-boss queue). What's left is registering the OAuth apps + adding
credentials.

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
