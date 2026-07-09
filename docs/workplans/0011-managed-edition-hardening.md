# Workplan 0011 — Managed edition hardening: RLS for real, API completion, billing e2e

## Status — 2026-07-09 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 runtime RLS enforcement (CRITICAL) | ⬜ Pending | — |
| T2 API routes: replace TODO shells with real persistence | ⬜ Pending | — |
| T3 Trigger.dev wiring: jobs call the real core | ⬜ Pending | — |
| T4 usage metering from real runs | ⬜ Pending | — |
| T5 billing + Mollie test-mode end-to-end | ⬜ Pending | — |
| T6 web UI wired to the real API | ⬜ Pending | — |
| T7 managed compose stack + operator docs | ⬜ Pending | — |

> Read `AGENTS.md`, arch §7.2/§16/§17 and the restored workplan `0005-managed-edition.md`
> (see 0006-C) first. **Depends on:** 0006 items A (trustworthy tests), G (web framework
> decision — blocks T6 only) and I (lint honesty). **Supersedes** the open end of workplan 0005:
> its summary claims Phases 1–2 complete and 3–6 in progress, but verified reality is thinner —
> see "Why this slice".

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
- Web app pages talking to the real API (framework per 0006-G decision).
- `deploy/compose/managed.yml` (consolidation per 0006-H) + operator runbook.

## Out of scope (later)
- Zitadel/Keycloak SSO (§7.3) — local JWT stays for now; keep the auth middleware seam.
- Vault integration (OpenBao/Infisical) — env/secret refs remain; document the seam.
- Production IaC/GitOps/K8s (§18) and real payment method beyond Mollie test mode.
- EN/NL i18n completion and WCAG audit (§23) — with the web epic after 0006-G.
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

### T6 — Web UI on the real API *(blocked on 0006-G)*
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
