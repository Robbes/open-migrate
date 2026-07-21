# Workplan 0013 — Pre-sync discovery, preview & confirm ("green light")

## Status — 2026-07-21 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 `discover()` on the source ports | ⬜ Not started | Body-free per-domain count method on the Mail/Calendar/Contact/File source interfaces (`packages/shared/src/ports.ts`) + connector impls (IMAP STATUS, Graph folder `totalItemCount`, DAV PROPFIND). Unit tests against fakes. |
| T2 discovery storage + migration | ⬜ Not started | `migration_discovery` table (per tenant/mapping/domain: collections, items, bytes, `discovered_at`) + Drizzle model + RLS policy; migration `0014_*.sql`. Idempotent upsert on `(tenant_id, mapping_id, domain)`. |
| T3 `run-discovery` job (both editions) | ⬜ Not started | Read-only discovery job that runs `discover()` across enabled domains inside `withTenant` and writes T2 rows. Managed: Trigger.dev `schemaTask`. Self-host: in-process. Honest error passthrough (§11.2). |
| T4 API: discover + poll (managed) | ⬜ Not started | `POST /api/migrations/:id/discover` (enqueue) + `GET /api/migrations/:id/discovery` (counts + job state) under RLS. Static **scope manifest** served from a shared module. Integration tests incl. cross-tenant isolation. |
| T5 mapping lifecycle: draft → active | ⬜ Not started | New mappings created **paused** (pre-confirm); scheduler must NOT dispatch non-`active` mappings (verify + enforce in both schedulers); `POST /api/migrations/:id/start` flips `paused`→`active`. Unit + integration tests. |
| T6 web "Review & confirm" wizard step | ⬜ Not started | After source/target/domains, a step that triggers discovery, polls, and renders per-domain counts + the §11.2 scope manifest, with a **"Start migration"** button = the green light (calls `/start`). jsdom + testing-library component tests. |
| T7 gates + docs | ⬜ Not started | `pnpm lint && typecheck && test (&& test:integration)` green; wizard/README docs; SAD §11.2 cross-ref updated ("scope manifest shown before start" now partially implemented). |

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
the self-host edition the same `discover()` + in-process discovery job runs and the counts appear in
`/status` before the first sync. `pnpm` gates green; discovery is **read-only** (no source mutation,
no message bodies fetched).

## In scope

- A **body-free `discover()`** on each source port (`@openmig/shared`), returning per-domain totals,
  implemented for IMAP, Graph (mail/cal/contacts/drive), and native CalDAV/CardDAV/WebDAV.
- A **`migration_discovery`** table + migration + RLS, and a **`run-discovery`** job wired in both
  editions (Trigger.dev managed, in-process self-host) via the existing `buildDepsFromMapping` /
  `dav-factories` seam.
- Managed **API**: enqueue discovery + poll results; a static, versioned **scope manifest** module.
- **Mapping lifecycle**: create-as-`paused`; scheduler skips non-`active`; `POST …/start` to activate.
- Web **wizard step**: counts + scope manifest + "Start migration" green light.
- Self-host: discovery counts surfaced in `/status`; activation is the operator enabling the mapping.

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

### T5 — mapping lifecycle: draft → active
Create new mappings with `status: 'paused'` (the enum already exists) instead of `'active'`. Make
**both** schedulers skip non-`active` mappings (verify current behavior first — `InProcessScheduler`
loader + the managed trigger dispatch — and enforce). Add `POST /api/migrations/:id/start` →
`status: 'active'` (idempotent; 409 if already `cutover`/`done`). Self-host: the appliance only
schedules `active` mappings from the config dir. Unit + integration tests (paused mapping never
dispatched; start activates + schedules). **Gate:** lint + typecheck + integration.

### T6 — web "Review & confirm" wizard step
New step in `apps/web/src/pages/CreateMapping.tsx` after domains: on entry it `POST …/discover`, polls
`GET …/discovery`, and renders a per-domain counts table (mailboxes + messages, calendars + events,
address books + contacts, drives + files + size) next to the scope manifest (`GET /api/scope-manifest`)
grouped migrates / partial / does-not-migrate. Primary action **"Start migration"** calls `POST …/start`
then routes to the mapping detail; a secondary "Save as draft" leaves it `paused`. jsdom +
testing-library component tests (loading → counts render → start calls the endpoint). **Gate:** web
typecheck + component tests.

### T7 — gates + docs
Full `pnpm lint && typecheck && test` (+ `test:integration` where DB-backed); update the wizard section
of the README/quickstart, and cross-reference SAD §11.2 (mark "scope manifest shown before start" as
partially implemented, pointing here). Refresh this Status block with evidence. **Gate:** docs-hygiene.

## Depends on / editions

- **Depends on:** 0007 (multi-domain sources — `discover()` extends the same connectors), 0011 T3
  (`buildDomainDepsFromMapping` + RLS wiring — the job reuses it). No open blockers.
- **Editions:** managed gets the full wizard + API + Trigger.dev discovery job; self-host reuses the
  same `discover()` + in-process job and surfaces counts in `/status` (no wizard — the operator's act
  of enabling the mapping is the green light). Hard rule 5 holds: discovery has no managed-only deps.

## Notes

- Discovery is strictly **read-only and body-free** — it must never fetch message/file content or
  mutate the source (this is the same read-only stance the O365 harness enforces on token scopes).
- Counts are a **point-in-time snapshot**; because shadow-run is non-destructive and the source keeps
  changing, the authoritative reconciliation remains the **cutover verification gate** (§9/§14). This
  screen is about informed consent before the first pass, not a substitute for that gate.
