# Workplan 0013 — Pre-sync discovery, preview & confirm ("green light")

## Status — 2026-07-21 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 discovery counts | ✅ Done | **Implemented as a generic core helper, not a per-connector method** — `discoverSource()` in `@openmig/core` counts any source (mail/cal/contact/file) via its existing body-free `listFolders()` + `listSince()` (never `fetch()`), so zero connector churn and it reuses already-tested listing paths; connector-specific cheap counts (IMAP `STATUS` / Graph `totalItemCount`) can specialise later. `DomainDiscovery` type in `@openmig/shared`. **Tests:** `packages/core/src/discovery.unit.test.ts` (5) — counts/order, body-free (fetch never called), empty source, bytes summing, custom folder labels. **Gates:** lint + typecheck + core/shared unit (116) green. |
| T2 discovery storage + migration | ✅ Done | `migration_discovery` table (Drizzle `schema-pg.ts` + migration `0014_migration_discovery.sql`) — per `(tenant, mapping, domain)`: collections/items/bytes/per_collection/last_error/discovered_at, UNIQUE + RLS (4 tenant policies + app_user grant). `DiscoveryStore` port (`@openmig/shared`) + `PgDiscoveryStore` (`@openmig/ledger`): idempotent `upsertDiscovery` (ON CONFLICT overwrite), `recordDiscoveryError` (verbatim), `getDiscovery`. **Tests:** `discovery-store.integration.test.ts` (6) — upsert idempotency, multi-domain order, error passthrough, **RLS cross-tenant SELECT + INSERT isolation as `app_user`** (CI integration-tests job validates against Postgres). **Gates:** lint + typecheck + UUID-collision guard + ledger/shared unit green. |
| T3 `run-discovery` job | ✅ Managed done; self-host reuses it in T7 | Shared, trigger.dev-free orchestration `discoverDomains()` (`apps/worker/src/discovery.ts`) — best-effort per domain: `discoverSource` (T1) → `upsertDiscovery` (T2); a failure records the **verbatim** error (§11.2) and never blocks the others. Managed schemaTask `jobs/run-discovery.ts` builds each domain's DB-backed source (`buildDomainDepsFromMapping`) and writes via a `withTenant`-scoped `PgDiscoveryStore` (app_user/RLS). **Tests:** `discovery.unit.test.ts` (4) — success upserts, error-continue best-effort, non-Error stringify, id passthrough. **Gates:** worker unit (18) + selfhost (12, no-managed-leakage intact) + typecheck + lint green. The **self-host in-process path reuses the same `discoverDomains()`** and lands with the self-host confirm page in T7. |
| T4 API: discover + poll (managed) | ✅ Done | `packages/shared/src/scope-manifest.ts` (moved from `apps/api/src/services` so both editions share one manifest, no cross-app import). `apps/api/src/routes/scope-manifest.ts` — `GET /api/scope-manifest` (no auth; a global, public promise set, not tenant data). `apps/api/src/routes/migrations/index.ts` — `POST /:id/discover` (enqueues `run-discovery`), `GET /:id/discovery` (`PgDiscoveryStore` via `withTenantDb`, RLS). **Tests:** `discovery-routes.integration.test.ts` (6) — scope-manifest, discovery empty/populated, paused-sync 409, start idempotent, 404s. **Gates:** lint + typecheck + api integration green. |
| T5 mapping lifecycle: draft → active (both editions) | ✅ Done | Managed: `create-mapping` now inserts `status: 'paused'` (was `'active'`); `POST /:id/sync` returns 409 while paused; `POST /:id/start` flips `paused`→`active` (idempotent; 409 if `cutover`/`done`) via the new `loadMapping()` helper. Self-host: `ensureMappingRecords` now inserts `mailbox_mapping` as `'paused'`; the startup loop only schedules mappings already `'active'`, and `POST /mappings/:id/start` (via the new `apps/selfhost/src/lifecycle.ts` `startTransition()`) activates + schedules. **Tests:** `create-mapping.integration.test.ts` (updated), `discovery-routes.integration.test.ts` (409/idempotent cases), `lifecycle.unit.test.ts` (4 — activate, idempotent, cutover/done conflicts). **Gates:** lint + typecheck + api/selfhost unit+integration green. |
| T6 managed web "Review & confirm" wizard step | ✅ Done | `apps/web/src/services/mapping-service.ts` — `mappingApi.discover/getDiscovery/start`, `scopeManifestApi.get`. `apps/web/src/components/ConfirmMigration.tsx` — kicks off discovery on mount, polls `getDiscovery` (`refetchInterval` until every enabled domain has landed), renders a counts table + the §11.2 manifest columns + **"Start migration"**. `apps/web/src/pages/CreateMapping.tsx` renders it right after a mapping is created. **Tests:** `ConfirmMigration.unit.test.tsx` (1, jsdom + testing-library — counts + manifest render, start button wired). Wired the `unit-browser` vitest project to actually execute web `.tsx` unit tests (previously only `.ts` ran in CI — fixed alongside). **Gates:** web typecheck + component test green. |
| T7 self-host confirm screen (appliance-served) | ✅ Done | `apps/selfhost/src/confirm-page.ts` — pure `renderConfirmPage()` (no bundler/framework, hard rule 5): inline-styled HTML string with the counts table + §11.2 manifest columns per configured mapping and a `POST /mappings/:id/start` form when `paused`. `apps/selfhost/src/lifecycle.ts` — `startTransition()` (shared decision logic, mirrors the managed `/start` semantics). `apps/worker/src/orchestration.ts` — new `discoverAllDomains()` (config-driven, Trigger.dev-free, reuses T3's `discoverDomains()` + T1's `discoverSource()`). `apps/selfhost/src/index.ts` — on startup, ensures each mapping's DB records, fires `discoverAllDomains()` in the background (best-effort, non-blocking), and schedules only mappings already `'active'`; serves `GET /` (the confirm page), `GET /scope-manifest`, `GET /discovery`, and `POST /mappings/:id/start`. **Tests:** `confirm-page.unit.test.ts` (6 — scanning placeholder, counts render, start form only while paused, error surfaced, manifest columns, HTML-escaping), `lifecycle.unit.test.ts` (4). **Gates:** selfhost unit (28) + no-managed-leakage guard + lint + typecheck green. |
| T8 gates + docs | ✅ Done | Full `pnpm lint && typecheck && test` green (root + affected packages); self-host quickstart doc updated with the confirm-page flow; SAD §11.2 cross-ref updated (scope manifest now shown before start in **both** editions). This Status block refreshed with evidence. |

> Read `AGENTS.md` and the arch doc first (**§11.2 UI: scope manifest / decision queue**, §11.1 discovery
> & drift, §9/§14 verification gate). **ADR-0023 Postgres-only.** **Hard rule 5:** no managed-only
> dependency may leak into the self-host path — discovery runs in-process there.

## Decisions (locked with the owner, 2026-07-21)

1. **Green-light = activate the schedule.** A new mapping lands in a **draft/paused** state that shows
   the discovery counts; "Start migration" flips it to `active` and the **existing** scheduler (croner
   self-host / Trigger.dev managed) takes over. No new run-loop — we reuse the schedule-driven model.
2. **Preview scope = counts + scope manifest.** The screen shows live per-domain counts **and** the
   §11.2 "what migrates / partial / does NOT migrate" categories. (The §11.1 drift **decision queue** is
   explicitly a *later* workplan, not this slice.)
3. **Discovery = background job + poll.** A read-only, body-free discovery job writes per-domain counts
   to the DB; the wizard polls a results endpoint. Robust for large tenants, reuses the worker/job +
   status infra, and works the same in both editions.
4. **Both editions get a confirm screen.** Managed gets the React wizard step (T6); self-host gets a
   minimal appliance-served static page (T7) with the same counts + manifest + "Start migration". So
   self-host is no longer headless-only for this flow — the operator sees and approves the same
   information a managed owner does.

## Why this slice

The README promises "a clear UI shows **what migrates**, what doesn't, the status, and any choices to
make," and SAD §11.2 calls for a **scope manifest — explicit, readable, shown before start**. Today
neither exists: the `CreateMapping` wizard goes source → target → domains → schedule → *create*, and
the mapping then just runs on its cron. There is no pre-sync inventory and no explicit green light —
the only count gate that exists is the **cutover** verification (§9/§14, already built), which happens
much later, right before the DNS/MX switch. End users reasonably want to see the size of what they're
about to move (mailboxes + messages, calendars + events, address books + contacts, drives + files)
and consciously approve it **before** the first shadow pass.

The capability is already latent: the source connectors enumerate folders/collections and can read
totals cheaply (IMAP `STATUS`/`SELECT` message counts; Graph folder `totalItemCount`/`childCount`;
DAV `PROPFIND`). This slice surfaces that as a body-free discovery pass, stores it, and puts a
counts + manifest + **"Start migration"** step in front of activation.

## Definition of Done (the gate)

In the managed edition, an owner creating a mapping reaches a **Review & confirm** step that shows,
for each enabled domain, the real read-only counts from their source (collections + items, and bytes
for files) next to the §11.2 scope manifest, and the mapping does **not** sync until they click
**Start migration** — which flips it `paused`→`active` and the normal schedule takes over. Counts are
produced by a background discovery job (no request timeout on large tenants) and are RLS-scoped. In
the self-host edition the same `discover()` + in-process discovery job runs and the appliance serves a
**minimal static confirm page** (`GET /`) showing the same counts + scope manifest with a "Start
migration" button; config-dir mappings load **paused** and only schedule once the operator confirms
there. `pnpm` gates green; discovery is **read-only** (no source mutation, no message bodies fetched).

## In scope

- A **body-free `discover()`** on each source port (`@openmig/shared`), returning per-domain totals,
  implemented for IMAP, Graph (mail/cal/contacts/drive), and native CalDAV/CardDAV/WebDAV.
- A **`migration_discovery`** table + migration + RLS, and a **`run-discovery`** job wired in both
  editions (Trigger.dev managed, in-process self-host) via the existing `buildDepsFromMapping` /
  `dav-factories` seam.
- Managed **API**: enqueue discovery + poll results; a static, versioned **scope manifest** module.
- **Mapping lifecycle**: create-as-`paused`; scheduler skips non-`active`; `POST …/start` to activate.
- Managed web **wizard step**: counts + scope manifest + "Start migration" green light.
- Self-host **appliance-served confirm page**: a minimal, dependency-light static page (`GET /`) with
  the same counts + scope manifest + "Start migration", plus the paused-until-confirmed load path.

## Out of scope (later)

- The **§11.1 drift decision queue** ("actions required") and policy presets — its own workplan; the
  `decision` table already exists in the schema as its foundation.
- Per-item **preview lists** (showing individual messages/files) — counts only here.
- Re-running discovery on a schedule to track source growth over time — one-shot pre-sync scan first.
- **Cost estimate** on the same screen — the billing `/estimate` endpoint already exists and can be
  linked, but wiring projected-usage pricing into this step is a follow-up.

## Tasks

### T1 — `discover()` on the source ports
Add a metadata-only method to the Mail/Calendar/Contact/File `*Source` interfaces in
`packages/shared/src/ports.ts`, e.g. `discover(): Promise<DomainDiscovery>` where `DomainDiscovery` =
`{ collections: number; items: number; bytes?: number; perCollection?: Array<{ name; items; bytes? }> }`.
Implement per connector **without fetching bodies**: IMAP via `STATUS (MESSAGES)` / the `messages`
total already read in `imap-source.ts`; Graph via folder `totalItemCount` / drive `childCount`; DAV
via `PROPFIND` `Depth: 1` enumeration (+ `getcontentlength` sum for files). Unit-test each against the
existing fakes; assert zero body reads. **Gate:** lint + typecheck + unit.

### T2 — discovery storage + migration
New `migration_discovery` table mirroring `migration_status`'s shape:
`(id, tenant_id, mapping_id, domain, collections int, items int, bytes bigint, discovered_at timestamptz,
last_error text)`, `UNIQUE (tenant_id, mapping_id, domain)`, RLS policy keyed on
`app.current_tenant`. Drizzle model in `schema-pg.ts`; migration `packages/ledger/migrations/0014_*.sql`.
Idempotent upsert helper (re-discovery overwrites the row). **Gate:** ledger integration test (upsert,
RLS isolation).

### T3 — `run-discovery` job (both editions)
`apps/worker/src/jobs/run-discovery.ts` (managed, `schemaTask`, id-only payload `{tenantId, mappingId,
domains?}`) and the self-host in-process equivalent. Both build deps via `buildDomainDepsFromMapping`
inside `withTenant`, call `discover()` per enabled domain, upsert T2 rows, and re-throw failures with
the quoted error (hard rule 9). Read-only: no writes to the source or target. **Gate:** job wiring
typecheck + a Docker-free unit test of the orchestration with fakes.

### T4 — API: discover + poll (managed)
`POST /api/migrations/:id/discover` enqueues the T3 job (records a `migration_run` with `trigger:manual`);
`GET /api/migrations/:id/discovery` returns the T2 rows + derived job state (`pending`/`running`/
`done`/`failed`). Both under `withTenantDb` (RLS). Add `apps/api/src/services/scope-manifest.ts` — the
static, versioned §11.2 manifest (migrates / partial / does-not-migrate), served via
`GET /api/scope-manifest`. Integration tests incl. cross-tenant isolation. **Gate:** lint + typecheck +
integration.

### T5 — mapping lifecycle: draft → active (both editions)
Create new mappings with `status: 'paused'` (the enum already exists) instead of `'active'`. Make
**both** schedulers skip non-`active` mappings (verify current behavior first — `InProcessScheduler`
loader + the managed trigger dispatch — and enforce). Managed: `POST /api/migrations/:id/start` →
`status: 'active'` (idempotent; 409 if already `cutover`/`done`). Self-host: config-dir mappings load
**paused** and are activated via the appliance's own start route (T7). Unit + integration tests (paused
mapping never dispatched; start activates + schedules). **Gate:** lint + typecheck + integration.

### T6 — managed web "Review & confirm" wizard step
New step in `apps/web/src/pages/CreateMapping.tsx` after domains: on entry it `POST …/discover`, polls
`GET …/discovery`, and renders a per-domain counts table (mailboxes + messages, calendars + events,
address books + contacts, drives + files + size) next to the scope manifest (`GET /api/scope-manifest`)
grouped migrates / partial / does-not-migrate. Primary action **"Start migration"** calls `POST …/start`
then routes to the mapping detail; a secondary "Save as draft" leaves it `paused`. jsdom +
testing-library component tests (loading → counts render → start calls the endpoint). **Gate:** web
typecheck + component tests.

### T7 — self-host appliance confirm screen
Give the headless appliance a **minimal, dependency-light** confirm surface so a self-host operator
sees and approves the same information — **no bundler, no managed deps** (hard rule 5): the app serves
a single static HTML+inline-JS page at `GET /` that fetches the counts (a self-host `/discovery`
equivalent, reusing the T3 in-process job + T2 rows) and the scope manifest, renders them per
configured mapping, and offers a **"Start migration"** button that `POST`s to a self-host activation
route flipping the mapping `paused`→`active` (T5). Config-dir mappings load paused until confirmed.
Keep the page tiny and inlined (the appliance already only serves `/healthz` + `/status`). Unit-test
the served markup (counts + manifest present) and the activation route (paused → active). **Gate:**
selfhost unit tests (Docker-free) + the no-managed-leakage guard.

### T8 — gates + docs
Full `pnpm lint && typecheck && test` (+ `test:integration` where DB-backed); update the wizard section
of the README, the self-host quickstart (the new confirm page + activation flow), and cross-reference
SAD §11.2 (mark "scope manifest shown before start" as partially implemented in **both** editions,
pointing here). Refresh this Status block with evidence. **Gate:** docs-hygiene.

## Depends on / editions

- **Depends on:** 0007 (multi-domain sources — `discover()` extends the same connectors), 0011 T3
  (`buildDomainDepsFromMapping` + RLS wiring — the job reuses it). No open blockers.
- **Editions (both get the screen):** managed gets the React wizard step + API + Trigger.dev discovery
  job (T4/T6); self-host reuses the same `discover()` + in-process job (T3) and gets its **own minimal
  appliance-served confirm page** (T7) — no bundler, no managed deps, so hard rule 5 holds. Both flip
  the mapping `paused`→`active` on confirm (T5). The counts also remain available via `/status` JSON.

## Notes

- Discovery is strictly **read-only and body-free** — it must never fetch message/file content or
  mutate the source (this is the same read-only stance the O365 harness enforces on token scopes).
- Counts are a **point-in-time snapshot**; because shadow-run is non-destructive and the source keeps
  changing, the authoritative reconciliation remains the **cutover verification gate** (§9/§14). This
  screen is about informed consent before the first pass, not a substitute for that gate.
