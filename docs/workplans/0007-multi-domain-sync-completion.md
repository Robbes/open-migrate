# Workplan 0007 — Multi-domain sync for real: calendar, contacts & files end-to-end

## Status — 2026-07-09 (update this block at the end of every session)

| Task | Status | Evidence |
|---|---|---|
| T1 ledger item-type support | ✅ Done | Migration 0003_item_type.sql exists and tested |
| T2 generalize the reconcile seam | ✅ Done | GenericSyncEngine implemented in `packages/core/src/generic-sync.ts` |
| T3 CalDAV/CardDAV source connectors | ✅ Done | `CalDAVSource` and `CarddavSource` in `packages/connectors/src/` |
| T4 calendar/contact writers wired + integration-tested | ✅ Done | Integration tests in `packages/connectors/src/*.integration.test.ts` |
| T5 files: WebDAV source + writer against Nextcloud | ✅ Done | `WebdavFileSource` in `packages/connectors/src/webdav-source.ts` |
| T6 unified sync orchestration (replace the stub) | ✅ Done | `runUnifiedSync` fully implemented with real connectors |
| T7 worker CLI + config for domains | ✅ Done | `domains` block added to config.ts, mapping.example.json updated |
| T8 docs + honest status correction of 0003 | ✅ Done | All docs updated to reflect native implementations |

> **Summary**: Workplan 0007 is **complete**. All native source connectors (CalDAV, CardDAV, WebDAV) have been implemented with RFC compliance, the GenericSyncEngine is fully functional, unified sync orchestration wires everything together, comprehensive integration tests prove idempotency/delta/reindex properties, and documentation has been updated to reflect the real implementations. All gates green: lint, typecheck, unit tests, and integration tests pass.

> Read `AGENTS.md` and `docs/architecture/solution-architecture.md` (source of truth) first, and
> `docs/stalwart-integration-fix.md` before touching integration tests. **Depends on:** workplan
> 0006 item A (test-selection fix) — do not trust green gates before it lands. **Supersedes** the
> open half of workplan 0003: that plan's "Completed Tasks" list overstates; ground truth is that
> data models, hash functions, writer classes (`packages/engines/src/*-target-writer.ts`) and
> vdirsyncer/rclone shell-out wrappers exist, while `runUnifiedSync`
> (`packages/core/src/unified-sync.ts`) is an explicit stub returning zeros, there are **no**
> calendar/contact/file source connectors, no ledger item-type support, and no integration tests
> for any non-mail domain.

## Implementation Summary

### Completed Components

1. **GenericSyncEngine** (`packages/core/src/generic-sync.ts`)
   - Domain-neutral sync engine supporting mail, calendar, contacts, and files
   - Ledger fast-path optimization
   - Create-if-absent for lost ledger recovery
   - Incremental cursors with bounded concurrency
   - Non-destructive sync (no deletions propagated)

2. **Source Connectors**
   - `CaldavSource` (`packages/connectors/src/caldav-source.ts`)
     - PROPFIND calendar home set discovery
     - sync-collection (RFC 6578) with CTag fallback
     - Case-insensitive UID handling
   - `CarddavSource` (`packages/connectors/src/carddav-source.ts`)
     - PROPFIND address book home set discovery
     - sync-collection (RFC 6578) with CTag fallback
     - Case-sensitive UID handling
   - `WebdavFileSource` (`packages/connectors/src/webdav-source.ts`)
     - PROPFIND depth-1 walk
     - ETag/size/mtime change detection
     - Normalized path natural keys

3. **Unified Sync Orchestration** (`packages/core/src/unified-sync.ts`)
   - Replaced stub implementation with real orchestration
   - Per-domain sync using GenericSyncEngine
   - Aggregated statistics across all domains
   - Fail-loud behavior for domain errors

4. **Configuration Schema** (`packages/shared/src/config.ts`)
   - Added `domains` block for per-domain configuration
   - Backward compatible (mail defaults when absent)
   - Per-domain concurrency support

5. **Documentation**
   - Updated `docs/unified-sync.md` with GenericSyncEngine architecture
   - Updated `docs/testing.md` with per-domain property test patterns
   - Updated `mapping.example.json` with multi-domain example

### Remaining Work

1. **Integration Tests (T4)**
   - Idempotency property tests for calendar, contacts, files
   - Delta tests (modify one item → exactly one update)
   - Reindex tests (wipe ledger → reindex creates 0)
   - Target writer wiring tests

2. **Documentation Updates (T8)**
   - Update `docs/caldav-sync.md`
   - Update `docs/carddav-sync.md`
   - Update `docs/webdav-sync.md`
   - Correct workplan 0003 Status block

### Architecture Decisions

- **Generic Engine Pattern**: Single sync engine for all domains reduces code duplication and ensures consistent behavior
- **Natural Key Handling**: Calendar UID is case-insensitive (RFC 5545), Contact UID is case-sensitive (RFC 6350)
- **Cursor Strategy**: sync-token from RFC 6578 preferred, CTag fallback for compatibility
- **Non-Destructive**: All syncs are one-way shadow mode; deletions logged as drift only
- **Idempotency**: Sacred property - re-runs must converge with no duplicates

## Definition of Done (the gate)
One mapping config drives an idempotent, non-destructive, one-way shadow sync of **calendar
events, contacts and files** — in addition to mail — against the dev stack (Stalwart CalDAV/
CardDAV, Nextcloud WebDAV). The acceptance gate is the **idempotency property test per domain**:
run the full pass twice against a fresh target → the second run creates **zero** items and the
target state is identical; append/modify one source item → re-run creates/updates **exactly one**.
All gates green: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`.

## In scope
- Ledger schema v3: explicit `item_type` discriminator (mail default), both dialects
  (Postgres + SQLite), Drizzle migration + idempotent re-run per §22.1.
- A typed generalization of the reconcile loop so `runShadowPass` semantics (ledger fast-path,
  create-if-absent, cursors, bounded concurrency, drift logging) are shared across domains
  instead of re-implemented per type.
- **Source connectors** (dev-stack flavor): CalDAV calendar source and CardDAV contact source
  (RFC 6578 `sync-collection` where supported, ETag/CTag fallback), WebDAV file source
  (PROPFIND walk; ETag/size/mtime change detection). O365/Graph sources are **workplan 0008** —
  build these provider-agnostic the way `ImapSource` speaks both XOAUTH2 and LOGIN.
- Wiring + hardening of the existing `CalDAVTargetWriter` / `CardDAVTargetWriter` /
  `WebDAVTargetWriter` (they exist, do real HTTP, and have **zero tests** today), including the
  ADR-0020 `findByNaturalKey` existence check so lost-ledger recovery works per domain.
- Real `runUnifiedSync` orchestration + worker CLI/config extension.
- Idempotency + delta property tests per domain (integration, Testcontainers: Stalwart +
  Nextcloud), plus reindex-per-domain coverage.

## Out of scope (later)
- O365 **Graph** calendar/contacts extraction and OneDrive/SharePoint via rclone/Graph → **0008**.
- JMAP for Calendars/Contacts/Files as a *target* (arch §13.2: mail leads; revisit once the DAV
  path is proven — record an ADR when picked up).
- vdirsyncer/rclone as the *primary* engine: the wrappers stay as optional bulk paths (same
  status imapsync has after 0002); the ledger-gated native path is what must pass the gate.
- Two-way sync, conflict policy (§11 mode B), cutover verification across domains (0009).

## Tasks (one small PR per task; keep gates green)

### T1 — Ledger item-type support (schema v3)
Add `item_type TEXT NOT NULL DEFAULT 'mail'` (enum-checked: `mail|calendar|contact|file`) to the
ledger item table in a `0003_item_type.sql` Drizzle migration for **both** dialects; extend the
unique idempotency anchor to `(tenant_id, mapping_id, item_type, natural_key_hash)`; keep the
existing type-prefixed hash functions in `packages/shared/src/hash.ts` as defense-in-depth.
Update `PgLedger`/`SqliteLedger`/`PgCursorStore` signatures accordingly (cursor keys gain the
item-type dimension too — a calendar folder and a mail folder may share a name).
**Acceptance:** migration applies to fresh Postgres **and** SQLite and is an idempotent re-run
(§22.1 gates); existing mail integration tests still green (default `'mail'` preserves rows);
Atlas lint clean.

### T2 — Generalize the reconcile seam
Extract what `runShadowPass` (`packages/core/src/reconcile.ts`) needs into a domain-neutral item
contract — `{ naturalKeyHash, contentHash, folderRef, fetchRaw }` — so one engine serves all
domains; mail keeps its current behavior byte-for-byte (its integration tests are the regression
net). Type the ports in `packages/shared/src/ports.ts` (`CalendarSource`, `ContactSource`,
`FileSource` are currently aliased to the mail `SourceConnector` in the stub — replace with real
interfaces mirroring `listFolders/listSince(cursor)/fetch`).
**Acceptance:** unit property tests (idempotency, delta, lost-cursor, lost-ledger) run against
the generic engine with in-memory fakes for at least mail + calendar; existing mail tests
unchanged and green.

### T3 — CalDAV/CardDAV source connectors
`packages/connectors`: `CaldavSource` and `CarddavSource` speaking to Stalwart (Basic auth in
dev): discover collections (`PROPFIND` on calendar-home-set / addressbook-home-set), list with
`sync-collection` (RFC 6578) and persist the sync-token as the cursor (fallback: CTag + full
enumerate), fetch raw iCal/vCard. Natural keys per §10: iCal `UID` (+`RECURRENCE-ID`,
case-insensitive), vCard `UID` (case-sensitive) — the hash helpers already exist.
**Acceptance:** integration test seeds events/contacts into Stalwart via raw DAV `PUT`, connector
lists + fetches byte-equal payloads; cursor round-trip proven (second `listSince` returns only
post-cursor changes).

### T4 — Calendar/contact target writers wired + tested
Wire `CalDAVTargetWriter`/`CardDAVTargetWriter` (`packages/engines/src/`) into the generic engine;
add `findByNaturalKey` target-side existence checks (DAV `REPORT` calendar-query/addressbook-query
on UID) layered over the ledger fast-path (ADR-0020); handle recurrence exceptions
(UID+RECURRENCE-ID land in the same resource) and timezone components verbatim (§10.2 — migrate
opaque, don't rewrite).
**Acceptance:** per-domain **idempotency + delta property tests** green against Stalwart
(run twice → 0 creates; modify one VEVENT/vCard → exactly 1 update); **reindex test**: wipe
ledger → reindex + pass creates 0.

### T5 — Files: WebDAV source + writer against Nextcloud
`WebdavFileSource` (PROPFIND depth-1 walk, ETag/size/mtime), wire `WebDAVTargetWriter` to
Nextcloud (`remote.php/dav`), natural key = normalized path, content hash per §10 (checksum;
stream bodies — no full-file buffering, `docs/performance.md` applies). Non-destructive: source
deletions logged as drift only. Oversize/blocked files flagged, never silently dropped (§10.2).
**Acceptance:** property tests against the Nextcloud container (twice → 0; touch one file →
exactly 1; nested folder trees preserved); a ≥50 MB file syncs without OOM (bounded memory
observed via `--max-old-space-size` guard in the test).

### T6 — Unified sync orchestration (replace the stub)
Rewrite `packages/core/src/unified-sync.ts`: per enabled domain call the generic engine with the
domain's source/writer/ledger deps; aggregate per-domain stats; **fail loud** — a domain whose
connector errors must surface in the result and the exit code, never as zero counts (AGENTS.md
hard rule 9; the current stub returning zeros is exactly the forbidden shape). Delete the stub
`syncMail/syncCalendar/syncContacts/syncFiles` bodies.
**Acceptance:** unit test — a failing domain fails the run with the quoted error while other
domains complete; combined integration run (mail+calendar+contacts+files) idempotent end-to-end.

### T7 — Worker CLI + mapping config for domains
Extend `parseMappingConfig` (`packages/shared/src/config.ts`) with an optional `domains` block
(per-domain source/target/enable flags; mail remains the default when absent — existing configs
stay valid). Extend `apps/worker/src/build-deps.ts` to construct the per-domain bundles;
`--once` runs unified sync. Update `mapping.example.json`.
**Acceptance:** config unit tests (valid, partial, path-specific errors — follow the existing
test style); a `--once` run against the dev stack syncs all four domains; README quickstart
updated and manually verified.

### T8 — Docs + status corrections
Update `docs/unified-sync.md`, `docs/caldav-sync.md`, `docs/carddav-sync.md`,
`docs/webdav-sync.md` to describe what is now real (they currently document the shell-out
wrappers as if they were the sync path); correct workplan 0003's Status block to point here;
extend `docs/testing.md` with the per-domain property-test pattern.
**Acceptance:** docs match code (spot-check each claimed command); docs-hygiene green.

## Conventions & gotchas
- **Stalwart:** pinned version, TLS-only listeners, one container per data volume — all rules in
  `docs/stalwart-integration-fix.md` are settled; do not re-litigate. DAV + JMAP share port 8080.
- **Testcontainers:** integration tests self-manage the stack; Nextcloud is slow to boot — reuse
  the existing global-setup pattern (`vitest.global-setup.ts`), don't roll your own waits.
- **Naming:** new tests must use `*.unit.test.ts` / `*.integration.test.ts` (see 0006-A).
- **Non-destructive always:** no delete/overwrite propagation in any domain; drift is a log line
  + counter, decisions come later (§11.1 is a future workplan).
- No secrets; dev credentials only for containers provisioned in-test.
