# Workplan 0013 — Pre-sync discovery, preview & confirm ("green light")

## Status — 2026-07-21 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 discovery counts | ✅ Done | **Implemented as a generic core helper, not a per-connector method** — `discoverSource()` in `@openmig/core` counts any source (mail/cal/contact/file) via its existing body-free `listFolders()` + `listSince()` (never `fetch()`), so zero connector churn and it reuses already-tested listing paths; connector-specific cheap counts (IMAP `STATUS` / Graph `totalItemCount`) can specialise later. `DomainDiscovery` type in `@openmig/shared`. **Tests:** `packages/core/src/discovery.unit.test.ts` (5) — counts/order, body-free (fetch never called), empty source, bytes summing, custom folder labels. **Gates:** lint + typecheck + core/shared unit (116) green. |
| T2 discovery storage + migration | ⬜ Not started | `migration_discovery` table (per tenant/mapping/domain: collections, items, bytes, `discovered_at`) + Drizzle model + RLS policy; migration `0014_*.sql`. Idempotent upsert on `(tenant_id, mapping_id, domain)`. |
| T3 `run-discovery` job (both editions) | ⬜ Not started | Read-only discovery job that runs `discover()` across enabled domains inside `withTenant` and writes T2 rows. Managed: Trigger.dev `schemaTask`. Self-host: in-process. Honest error passthrough (§11.2). |
| T4 API: discover + poll (managed) | ⬜ Not started | `POST /api/migrations/:id/discover` (enqueue) + `GET /api/migrations/:id/discovery` (counts + job state) under RLS. Static **scope manifest** served from a shared module. Integration tests incl. cross-tenant isolation. |
| T5 mapping lifecycle: draft → active (both editions) | ⬜ Not started | New mappings created **paused** (pre-confirm); scheduler must NOT dispatch non-`active` mappings (verify + enforce in both schedulers); managed `POST /api/migrations/:id/start` **and** a self-host activation route both flip `paused`→`active`. Self-host loads config-dir mappings as paused until confirmed. Unit + integration tests. |
| T6 managed web "Review & confirm" wizard step | ⬜ Not started | After source/target/domains, a step that triggers discovery, polls, and renders per-domain counts + the §11.2 scope manifest, with a **"Start migration"** button = the green light (calls `/start`). jsdom + testing-library component tests. |
| T7 self-host confirm screen (appliance-served) | ⬜ Not started | A minimal, dependency-light **static page the appliance serves** (`GET /`) that renders the same discovery counts + scope manifest per configured mapping and a **"Start migration"** button → self-host activation endpoint. Self-host mappings load **pending/paused** and only schedule after confirm (§11.2 parity with managed). Hard rule 5: no bundler/managed deps — inline HTML/JS. Unit test the served markup + the activation route. |
| T8 gates + docs | ⬜ Not started | `pnpm lint && typecheck && test (&& test:integration)` green; wizard + self-host quickstart docs; SAD §11.2 cross-ref updated ("scope manifest shown before start" now partially implemented, both editions). |

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
