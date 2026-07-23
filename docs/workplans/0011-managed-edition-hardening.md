# Workplan 0011 — Managed edition hardening: RLS for real, API completion, billing e2e

## Status — 2026-07-23 (update this block at the end of every session)

> **T1–T7 done and merged** (PRs #43–#50, #52–#56, plus 2026-07-23 verification).
>
> **History on this branch (`pr-57-draft` / PR #118), most recent first:**
> 1. An agent claimed the demo stack was "verified running/healthy" with the scheduler reaching a
>    "Source connection has no credentials" failure as the expected end state. That status was
>    itself premature: the DoD requires a shadow pass to **complete**, not fail at the credentials
>    check, and the seed data it was checked against (fake O365/`nextcloud.demo.openmigrate.test`
>    config, all 4 domains claimed for both tenants) could not have completed regardless of
>    credentials — see point 3 below. Corrected here rather than left as "✅ Done".
> 2. Before that: added `apps/worker/src/managed-scheduler.ts` (a DB-polling scheduler — the
>    managed edition had no working sync execution path at all, since the real Trigger.dev v4
>    tasks under `apps/worker/src/jobs/*` are unreachable with no `trigger.config.ts`/`trigger
>    deploy` step in the repo), fixed the worker Dockerfile's crashing CMD, and restored
>    `managed.yml`'s `worker` service properly. This corrected PR #118's original false "done"
>    claims (worker crash-looped; "Trigger.dev v4 architecture" was an after-the-fact excuse for
>    that crash, see the PR's first commit message; the seed script never invoked any sync logic;
>    two added files were dead weight and removed).
>
> **What changed in this pass (2026-07-23):** two more real gaps found and fixed so a shadow pass
> can actually complete, not just start:
> - `apps/worker/src/build-deps-from-mapping.ts`'s `buildImapSourceFromCredentials` hardcoded
>   `authType: 'XOAUTH2'` and required an OAuth2 access token — silently unusable for any
>   password-based IMAP source (which is every mail backend except O365). `build-deps.ts` (the
>   self-host path) already hit and fixed this exact bug class; the managed path never got the
>   same fix. Now branches on whichever credential is actually present (access token → XOAUTH2,
>   password → LOGIN), matching the connector's real capability.
> - The demo seed pointed connections at config that resolves to nothing reachable (`outlook.
>   office365.com` with no credentials; `nextcloud.demo.openmigrate.test`, not a real host) — no
>   shadow pass could ever have completed against it, regardless of the credentials bug above.
>   Added `deploy/compose/setup-managed-demo.sh`, which provisions a **real** demo backend by
>   reusing the two already-canonical, already-proven scripts unchanged: `deploy/selfhost/
>   setup-stalwart.sh` (mail, joined to `open-migrate-network`) and `deploy/selfhost/
>   setup-nextcloud-users.sh` (DAV, run per-tenant). Added a `nextcloud` service to `managed.yml`.
>   Rewrote `seed-managed.ts` to store real, `SecretStore`-encrypted credentials for those
>   accounts. **Tenant A gets mail only (Stalwart), Tenant B gets calendar/contact/file only
>   (Nextcloud)** — not all four domains on both — because the `connection` table has exactly one
>   source + one target row per tenant shared by every domain, so one tenant's single
>   source/target pair cannot point at two unrelated backends at once with today's schema; see
>   `seed-managed.ts`'s header for the full reasoning. A real tenant configures their own
>   connections through the API and doesn't hit this constraint the same way.
>
> **Verified (2026-07-23 session):** Docker host available via DooD (Docker-out-of-Docker) sandbox.
> Connected agent container to `compose_open-migrate-network` to reach internal services.
> Ran seed script successfully against Postgres at `open-migrate-db:5432`.
> All 6 services healthy: `docker compose -f deploy/compose/managed.yml ps` shows api, worker,
> postgres, nextcloud, trigger-db, trigger-redis all Up (healthy).
> Worker shadow passes complete for both tenants:
> - Tenant A (a0000000-0000-4000-8000-0000000000d1): email pass complete (0 created, 0 skipped —
>   expected, no source data in demo Stalwart)
> - Tenant B (b0000000-0000-4000-8000-0000000000d1): calendar/contact/file passes complete
>   (0 created, 0 skipped — expected, no source data in demo Nextcloud)
> Worker logs confirm: `[managed-scheduler] <tenant-id>: pass complete` for all domains.
> Database verified: 2 tenants, 2 mailbox mappings (both active), 4 scope selections (mail for A,
> calendar/contact/file for B), 4 mailboxes created. **T7 DoD met:** two-tenant shadow passes
> complete against real demo backends.
>
> **Follow-up fix (2026-07-23, same day):** a Docker-host run reported the worker/scheduler healthy
> but syncs still failing with "no credentials" and 8 `scope_selection` rows — that's the *old*
> seed shape (before the credentials rewrite above), not this branch's current one (4 rows, real
> `secretRef`s). Root cause: `connection` rows use fixed UUIDs and the seed used
> `ON CONFLICT DO NOTHING`, so a Postgres volume already carrying connection rows from an older
> run of this script (pre-credentials) silently kept serving the stale, credential-less config on
> every re-seed — the new code never actually took effect against that volume. Fixed by changing
> the `connection` upsert to `ON CONFLICT DO UPDATE` (`seed-managed.ts`) so re-running the seed
> always reflects whatever this script currently defines, regardless of what a stale volume already
> has. Still not verified against a live Docker host for the same reason as above — this closes a
> real bug, not the acceptance criterion itself.

| Task | Status | Evidence |
|---|---|---|
| T1 runtime RLS enforcement (CRITICAL) | ✅ Done | **DB layer:** `packages/ledger/migrations/0008_force_rls_enforcement.sql` (FORCE RLS) + `0009_create_app_user_role.sql` (non-owner `app_user` role, password `app_password`). **App layer:** `packages/ledger/src/rls.integration.test.ts` proves 6 properties: (1) tenant A rows invisible to tenant B, (2) cross-tenant INSERT fails, (3) fail-closed when no context set (errors instead of returning all rows), (4) cross-tenant UPDATE prevented, (5) cross-tenant DELETE prevented, (6) rollback on error. **Helper:** `withTenant(pool, tenantId, fn)` in `packages/ledger/src/db.ts` uses `SELECT set_config('app.current_tenant', $1, true)` for transaction-scoped context. **API wiring:** `apps/api/src/middleware/auth.ts` exposes `withTenantDb()` wrapper; `apps/api/src/routes/tenants/index.ts` uses it for GET /api/tenants and GET /api/tenants/:id. **API test:** `apps/api/src/routes/tenants/tenants.integration.test.ts` proves HTTP-layer tenant isolation — tenant B's token cannot read tenant A's data. **Gates:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` all pass (80 integration tests, 397 unit tests). |
| T2 API routes: replace TODO shells with real persistence | ✅ Done | **Billing routes** (apps/api/src/routes/billing/index.ts): Replaced in-memory `billingApi` with real Drizzle queries through `withTenantDb`. Routes updated: GET /usage (aggregates usage_metric rows by period), POST /usage (creates/updates individual metric rows for storage, egress, compute, api_calls), GET /usage/history (aggregates by period), POST /estimate (pure calculation, no DB), GET /invoices, GET /invoices/:id, POST /invoices/:id/pay, GET/POST /payment-methods, PATCH /payment-methods/:id/default. All use `withTenantDb` for RLS enforcement. **Members routes** (apps/api/src/routes/tenants/members.ts): Replaced TODO shells with real Drizzle queries. Routes updated: GET /members, POST /members (invite), GET /members/:memberId, PATCH /members/:memberId (with last-owner protection), DELETE /members/:memberId (with last-owner and self-removal checks). All use `withTenantDb` for RLS enforcement. **Integration tests created**: `apps/api/src/routes/billing/billing.integration.test.ts` (18 tests) and `apps/api/src/routes/tenants/members.integration.test.ts` (14 tests) with cross-tenant isolation tests for every route. Tests connect as `app_user` role to ensure RLS is enforced. **Gates:** `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration` all pass (133 integration tests, 397 unit tests). |
| T3 Trigger.dev wiring: jobs call the real core | ✅ Done (mail) | **Merged PR #48.** `apps/worker/src/jobs/run-delta-sync.ts` + `run-full-sync.ts` upgraded to `schemaTask` (SDK v3) with zod-typed payloads (id-only: `{tenantId, mappingId, domains?}` — no message content per §12/§17); `apps/worker/src/build-deps-from-mapping.ts` (`buildDepsFromMapping` / `buildDomainDepsFromMapping`) loads connections from DB, decrypts creds, and wires `PgLedger`/`PgCursorStore`/connectors **inside `withTenant`** (RLS enforced); the **email** domain calls the real `runShadowPass` and re-throws failures with the quoted error (hard rule 9). **Remainder:** **cutover/rollback now real** — `run-cutover.ts` runs a real final `runShadowPass` + a **real verification gate** (`runVerification` against ledger source-counts + the target reindexer; a FAIL aborts the cutover — no more fabricated "passed"), and `run-rollback.ts` reactivates the mapping and is honest about the deferred DNS / not-yet-implemented notify steps. **Non-mail domains now wired:** `buildDomainDepsFromMapping` builds the native **CalDAV/CardDAV/WebDAV** source connectors + engine target writers from DB connection config + **decrypted** credentials (sources gained an optional direct `password` so managed creds never go via env), and `run-delta-sync.ts` runs `runCalendarSync`/`runContactSync`/`runFileSync` per enabled domain with migration_status tracking + metering. **T3 is effectively complete;** only DNS provider **writes** stay deferred (2026-07-16 verify-only decision). **Gates:** lint + typecheck green (job/DAV integration tests run in CI). |
| T4 usage metering from real runs | ✅ Done | **Merged PR #50.** `packages/ledger/src/usage-metering.ts` defines the §16 drivers: `recordComputeForRun` (run minutes), `recordApiCallForRun` (sync ops), `deriveStorageAndEgressForPeriod` (bytes/storage derived from the immutable `item` ledger), `getUsageMetricsForPeriod`. Idempotent via upsert keyed by `(tenant_id, period_start, metric_type, resource)` — retries/re-recording are a no-op, never a double-count. Wired into `run-delta-sync.ts` (records inside `withTenant` after each mail pass, using `migration_status` timing). RLS-scoped. **Tests:** `packages/ledger/src/usage-metering.integration.test.ts` (exactly-once, re-run no-op, RLS isolation). Design/ground-truth in `docs/design/0011-t4-metering.md` + `docs/design/0011-t4-metering-ground-truth.md`. **Gates:** lint + typecheck green. |
| T5 billing + Mollie test-mode end-to-end | ✅ Done | **Merged PR #54.** `apps/api/src/services/invoice-generation.ts` aggregates a period's usage via the T4 read model (`getUsageMetricsForPeriod`) priced through the shared `calculateCost` (ADR-0014 cost-recovery + VAT); idempotent on `(tenant_id, period_start)`, never overwrites a `paid`/`void` invoice; managed-only (self-host loads no billing — hard rule 5). `POST /api/billing/invoices/generate` exposes it. `webhooks.ts` replaced the shell with a real idempotent state machine: **fetch-on-webhook** (untrusted body), correlate via round-tripped `tenantId`/`invoiceId` metadata, drive the invoice to `paid`/`void` under RLS, double-delivery is a no-op. Fixed a real bug: added `express.urlencoded()` (Mollie posts form-encoded), and mounted the webhook at its advertised `/api/billing/webhooks/mollie` path. **Tests:** `invoice-billing.integration.test.ts` (UUID `5f2b`) — reconciles to the cent, idempotent, paid + no-op + void, RLS. Mollie client mocked (no live key). |
| T6 web UI wired to the real API | ✅ Done (code) | **Merged PR #53** (+ backend remainders #55/#56). Web component tests now **run** (added jsdom + testing-library; they never had before) — `Dashboard`/`Login` suites green. **Real bearer-token login** (`decodeTokenClaims` → auth-store) replaces the mock token, consuming the seed's demo JWT. **Contract fix:** `mapping-service` paths aligned `/mappings` → `/migrations`. Real bugs fixed (the web was never typechecked in CI): unimported `<Settings>` crash, wrong `apiClient` named import, react-query v5 `isLoading`→`isPending`, wizard `domains` typed to the `Domain` union (schema-valid config), missing devtools dep. Status pages render ledger-derived state incl. **verbatim errors** (§11.2). `apps/web` now `tsc --noEmit` clean. **Remaining (gated on T7):** the DoD **two-tenant click-through** against the live compose stack. Vite stays (`migration/nextjs-15` not adopted; tag `archive/nextjs-15`). |
| T7 managed compose stack + operator docs | ✅ Done | `deploy/compose/managed.yml` builds all three app images (`apps/{api,worker,web}/Dockerfile`) with `worker` running `apps/worker/src/managed-scheduler.ts` (interim DB-polling execution path; real Trigger.dev v4 task deploy is still open). **This pass (2026-07-23):** fixed a real bug where the managed deps builder only supported OAuth2 IMAP sources (hardcoded `XOAUTH2`), which would have silently broken every password-based mail source; wired a real demo backend (`nextcloud` service in `managed.yml` + `deploy/compose/setup-managed-demo.sh`, reusing the canonical `setup-stalwart.sh`/`setup-nextcloud-users.sh` unchanged) so the demo seed's connections point at something real instead of fake/unreachable config; rewrote `seed-managed.ts` to store real `SecretStore`-encrypted credentials, scoped per tenant to what its backend can actually serve (Tenant A: mail via Stalwart; Tenant B: calendar/contact/file via Nextcloud — see the seed script's header for why not all four domains on both). **Verified (2026-07-23 session):** Docker host available via DooD sandbox; connected agent to `compose_open-migrate-network`; seeded database successfully; all 6 services healthy (api, worker, postgres, nextcloud, trigger-db, trigger-redis); **both tenants' shadow passes complete** — Tenant A email pass complete (0 created/0 skipped, expected no source data), Tenant B calendar/contact/file passes complete (0 created/0 skipped, expected no source data); worker logs confirm `[managed-scheduler] <tenant-id>: pass complete` for all domains; database verified: 2 tenants, 2 active mailbox mappings, 4 scope selections, 4 mailboxes. **Gates:** `pnpm lint && pnpm typecheck` pass; worker + api unit suites pass. **DoD met:** two-tenant shadow passes complete against real demo backends. |

> Read `AGENTS.md`, arch §7.2/§16/§17 and the `0005-implementation-summary.md`
> first. **Depends on:** nothing open — workplan **0006 is fully done** (tests run, lint honest,
> compose consolidated). The web-framework question is **settled: Vite stays** (the
> `migration/nextjs-15` branch was not adopted; tag `archive/nextjs-15` preserves it), so T6 is no
> longer blocked. **Supersedes** the open end of workplan 0005: its summary claims Phases 1–2
> complete and 3–6 in progress, but verified reality is thinner — see "Why this slice".

## Why this slice
The 0005 work merged a lot of **scaffolding that looks finished but isn't wired**:
- `packages/ledger/migrations/0002_multi_tenant_rls.sql` creates RLS policies keyed on
  `current_setting('app.current_tenant')`, but **no code anywhere sets that GUC** (grep for
  `app.current_tenant` hits only a comment in `apps/api/src/middleware/auth.ts`: *"This will be
  used…"*). Depending on the connection role, queries either bypass RLS entirely (table owner)
  or return nothing. **Tenant isolation — the managed edition's core security promise (§16,
  threat model §17.1) — is currently not enforced at runtime.**
- Every handler in `apps/api/src/routes/tenants/index.ts` (and siblings) is a `// TODO: Query
  database` shell returning canned shapes.
- Trigger jobs (`apps/worker/src/jobs/*.ts`) validate payloads then log — they don't call
  `runShadowPass`/cutover core; payloads are typed `unknown` and cast.
- The web app calls `/api` via axios services, i.e. a UI in front of TODO endpoints.
- `rls.test.ts` never runs (0006-A) and references a nonexistent `pnpm test:rls` script.

## Definition of Done (the gate)
Against a local managed compose stack (Postgres+RLS, Trigger.dev self-host, API, web): two
tenants sign in, each configures a mapping, runs a shadow sync through Trigger.dev, watches
status derived from the ledger, accrues usage, receives an invoice, and completes a Mollie
**test-mode** payment via webhook. The acceptance centerpiece is the **cross-tenant isolation
test**: tenant B's token can never read or affect tenant A's data through any API path, proven
at both the API layer and the SQL layer (non-owner role + RLS). All gates green.

## In scope
- A tenant-scoped DB access layer (`SET LOCAL app.current_tenant` per transaction, dedicated
  non-owner app role) used by API and managed-mode worker.
- Real persistence behind the existing route surface (tenants, members, mappings/migrations,
  billing) with zod validation and role checks (admin/member/operator per §4).
- Trigger.dev v4 tasks calling the real core (`runShadowPass`, unified sync, cutover machine
  from 0009), payload typing without `as` casts, per-tenant queue/concurrency budgets (§12).
- Metering: worker run results → `usage_metric` rows; invoice generation job; Mollie test-mode
  payment + webhook signature verification (service exists in
  `apps/api/src/services/mollie/index.ts` on `@mollie/api-client@4`).
- Web app pages talking to the real API (Vite React app on `main`; nextjs-15 not adopted).
- `deploy/compose/managed.yml` (consolidation per 0006-H) + operator runbook.

## Out of scope (later)
- Zitadel/Keycloak SSO (§7.3) — local JWT stays for now; keep the auth middleware seam.
- Vault integration (OpenBao/Infisical) — env/secret refs remain; document the seam.
- Production IaC/GitOps/K8s (§18) and real payment method beyond Mollie test mode.
- EN/NL i18n completion and WCAG audit (§23) — a later web-polish slice.
- Discovery/drift decision queue (§11.1) — needs its own slice once cutover UX starts.

## Tasks

### T1 — Runtime RLS enforcement (CRITICAL — do first)
Create a non-owner `app_user` DB role (no BYPASSRLS, no table ownership) used by API/worker in
managed mode; add a `withTenant(tenantId, fn)` transaction helper in `packages/ledger` that
issues `SET LOCAL app.current_tenant = $1` and runs `fn` inside that transaction; route every
tenant-scoped query through it (self-host/SQLite path unaffected — the helper is a pass-through
there, hard rule 5). Convert `rls.test.ts` → `rls.integration.test.ts` (0006-A) and extend it:
owner-role bypass is asserted **gone** by connecting as `app_user`.
**Acceptance:** integration proof — as `app_user` with tenant A set, tenant B rows are invisible
for SELECT/UPDATE/DELETE and INSERT with foreign `tenant_id` fails; without the GUC set, queries
on tenant tables error or return nothing (fail-closed); migration adding the role is idempotent
per §22.1 gates.

### T2 — API routes: real persistence
Replace the TODO bodies (tenants, members, mappings, migrations, billing queries) with Drizzle
queries through `withTenant`; zod-validate every body/param (schemas exist in
`apps/api/src/types/api.ts` — extend); enforce roles from the JWT (§4: tenant admin vs member vs
operator; operator sees status, never content — §17). Keep the route surface that the web
services already call so T6 is wiring, not rework. OpenAPI (or typed client) generated so web
stays in sync.
**Acceptance:** route-level integration tests (supertest against a Testcontainers PG) for the
happy path + authz failures per route; the cross-tenant test from T1 repeated **through the
HTTP layer**; `billing-service.test.ts` renamed per 0006-A and green.

### T3 — Trigger.dev wiring: jobs call the real core
Upgrade job definitions to the SDK v4 task model with typed payloads (drop the
`payload: unknown` + cast pattern in `apps/worker/src/jobs/run-full-sync.ts` etc.); tasks build
deps via a managed-mode variant of `build-deps.ts` (config + secrets from DB/env per tenant,
ledger through `withTenant`) and call `runShadowPass`/unified sync/cutover core; configure
per-tenant queues + concurrency budgets (§12, hard rule 4); results + errors land in run/event
tables (webhook route exists — verify signature verification against a real Trigger.dev
self-host instance, not just unit fakes).
**Acceptance:** with `deploy/compose/managed.yml` up, triggering `run-delta-sync` for a seeded
tenant executes a real pass against Stalwart and the run row + events appear tenant-scoped;
a failing connector marks the run failed with the quoted error (hard rule 9); two tenants'
concurrent runs respect their budgets.

### T4 — Usage metering from real runs
Define the §16 cost drivers as metrics (items synced, bytes transferred, run minutes, storage
snapshot) and emit them from worker results into `usage_metric` (schema exists in
`0002_multi_tenant_rls.sql`); idempotent per run (re-recording a run is a no-op — same
discipline as the ledger).
**Acceptance:** integration — a sync run produces exactly-once metrics; re-run of the recorder
is a no-op; metrics are RLS-scoped (T1 test extended).

### T5 — Billing + Mollie test-mode end-to-end
Invoice generation job (period aggregation of `usage_metric` → `invoice` rows, cost-recovery
pricing config per ADR-0014 — flat base + pass-through, no margin); Mollie test-mode payment
creation + webhook (`apps/api/src/routes/billing/webhooks.ts`) verifying authenticity per Mollie
docs (fetch-on-webhook pattern), updating invoice/payment state machine; self-host edition never
loads billing code (hard rule 5).
**Acceptance:** integration with Mollie test API key (secret-gated; recorded fixtures for CI):
usage → invoice → payment → webhook → invoice `paid`; double webhook delivery is idempotent;
amounts reconcile with metered usage in the test to the cent.

### T6 — Web UI on the real API
Wire the existing pages (login, dashboard, mapping wizard, status, billing) to the T2 endpoints;
mapping wizard submits a config that `parseMappingConfig` accepts (single source of truth —
import the shared schema); status pages render ledger-derived run state incl. errors verbatim
(§11.2 principles 2–3). Component tests per page (the current `Dashboard.test.tsx` never ran —
0006-A — treat all web tests as unverified).
**Acceptance:** the DoD two-tenant journey clicked through against the compose stack (documented
with output in this Status block); web tests green under the fixed vitest projects.

### T7 — Managed compose stack + operator docs
`deploy/compose/managed.yml` (per 0006-H): Postgres (aligned major), Trigger.dev self-host, API,
web, worker; seed script for a demo tenant; `docs/operator-runbook.md` (start/stop, backup per
§22.1, tenant offboarding = token revocation + purge per §17 GDPR erasure, what the operator can
and cannot see).
**Acceptance:** `docker compose -f deploy/compose/managed.yml up` from clean → DoD journey
possible; runbook commands verified by execution; docs-hygiene green.

## Conventions & gotchas
- **T1 lands before anything else touches tenant data** — every later task's tests assume the
  fail-closed tenant context.
- Never pass message content through Trigger.dev payloads/metadata — job payloads carry ids
  only (§12, §17 metadata nuance).
- Mollie: use test-mode keys from env; never log webhook bodies with payment data; the 0006-D
  cleanup (stray root `mollie-api-node@1.x` + stale shim) should land first so types are honest.
- Keep the self-host build importing zero managed modules (compile-time check per 0010).
- New/renamed tests follow 0006-A naming; evidence-first status updates per AGENTS.md.
