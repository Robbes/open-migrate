# Workplan 0003 — Calendar, Contacts & Files (CalDAV, CardDAV, WebDAV)

---

## Status

**Status:** 🚧 **IN PROGRESS**  
**Target Completion:** TBD  
**Branch:** `feat/0003-caldav-carddav-webdav`  
**PR:** TBD (created upon completion)

**Gates (must all pass before merge):**
- ✅ **Lint:** `pnpm lint` passes
- ✅ **Typecheck:** `pnpm typecheck` passes
- ✅ **Unit Tests:** `pnpm test` passes
- ✅ **Integration Tests:** `pnpm test:integration` passes
- ✅ **Idempotency Tests:** Property tests pass for all three data types
- ✅ **Documentation:** `docs/` updated with provider specifics and usage

---

> **Sketch for later** — refine before handing to the agent. Depends on **0001** (JMAP mail) and **0002** (IMAP/DAV mail) being green.
> This slice adds the remaining data families: calendar (CalDAV), contacts (CardDAV), and files (WebDAV).
> The same idempotency + ledger pattern applies, but using **vdirsyncer** for CalDAV/CardDAV and **rclone** for WebDAV.

## Goal / Definition of Done

Extend the migration engine to handle **three additional data types** beyond email:

1. **Calendar (CalDAV):** One-way or bidirectional sync of calendar events, respecting idempotency via ledger
2. **Contacts (CardDAV):** One-way or bidirectional sync of address book entries, respecting idempotency via ledger
3. **Files (WebDAV):** One-way mirror of files/folders, respecting idempotency via ledger

**Definition of Done:**
- All three data types can be synced from O365 (Graph/Exchange) or generic sources to JMAP/Nextcloud/Soverin targets
- **Idempotency property tests pass** for each data type (run twice → zero creates on second run)
- **Delta handling verified** (adding one item creates exactly one)
- **Non-destructive by default** (source deletions logged as drift, not propagated)
- **Provider documentation** updated with CalDAV/CardDAV/WebDAV specifics
- All gates green: lint, typecheck, unit tests, integration tests

---

## Approach

Following the established pattern from workplans 0001 and 0002:

### Core Principles
1. **Reuse proven engines:** 
   - **vdirsyncer** for CalDAV/CardDAV (battle-tested, idempotent by design)
   - **rclone** for WebDAV (robust file sync with checksum verification)
2. **Ledger-gated idempotency:** Same pattern as mail — check ledger before sync, record after
3. **Shell-out architecture:** Engines run as subprocesses, orchestrated by TypeScript wrappers
4. **Config-driven:** Same mapping config pattern, extended for new data types

### Data Type Strategies

#### Calendar (CalDAV)
- **Source:** O365 Calendar via Microsoft Graph API (primary) or CalDAV source
- **Target:** CalDAV servers (Nextcloud, Soverin, Stalwart, Proton via bridge)
- **Engine:** vdirsyncer with CalDAV backend
- **Idempotency:** UID-based, ledger tracks `calendar_uid + content_hash`
- **Special handling:** Recurring events, timezones, attachments

#### Contacts (CardDAV)
- **Source:** O365 Contacts/People via Microsoft Graph API
- **Target:** CardDAV servers (Nextcloud, Soverin, Stalwart)
- **Engine:** vdirsyncer with CardDAV backend
- **Idempotency:** UID-based, ledger tracks `contact_uid + content_hash`
- **Special handling:** vCard version compatibility (3.0 vs 4.0), photos, custom fields

#### Files (WebDAV)
- **Source:** OneDrive/SharePoint via Graph API or direct WebDAV
- **Target:** WebDAV servers (Nextcloud, ownCloud, Stalwart Files)
- **Engine:** rclone with WebDAV backend
- **Idempotency:** Size + checksum verification, ledger tracks `file_path + content_hash`
- **Special handling:** Directory structure, file permissions, large files, conflicts

### Target Support Matrix

| Data Type | JMAP | Nextcloud | Soverin | Stalwart | Proton |
|-----------|------|-----------|---------|----------|--------|
| Calendar  | ✅   | ✅        | ✅      | ✅       | ⚠️ (snapshot only) |
| Contacts  | ✅   | ✅        | ✅      | ✅       | ⚠️ (snapshot only) |
| Files     | ⚠️   | ✅        | ⚠️      | ✅       | ✅ |

**Note:** Proton calendar/contacts lack open protocols — we offer **snapshot export** (vCalendar/vCard bundles) as the best achievable.

---

## Tasks

### T1 — Calendar (CalDAV) foundation

**Goal:** Implement calendar sync using vdirsyncer

**Method:**
1. Create `packages/engines/src/caldav-sync.ts` — vdirsyncer wrapper with TypeScript API
2. Implement `CalendarTargetWriter` interface (extends `TargetWriter`)
3. Define `CalendarEvent` model with UID, summary, description, start/end, recurrence, timezone
4. Implement `naturalKey = calendar_uid`, `contentHash = sha256(normalized event data)`
5. Create vdirsyncer config generator (temp files per sync job)
6. Parse vdirsyncer output for sync status

**Acceptance:**
- Can sync a calendar from source to CalDAV target
- Idempotency verified: re-run creates 0 events
- Delta handling: adding one event creates exactly one
- Recurring events handled correctly (master + instances)
- Integration test against Stalwart/Nextcloud CalDAV

**Reference:** `packages/engines/src/caldav-sync.ts`, `packages/shared/src/types/calendar.ts`

---

### T2 — Contacts (CardDAV) foundation

**Goal:** Implement contacts sync using vdirsyncer

**Method:**
1. Create `packages/engines/src/carddav-sync.ts` — vdirsyncer wrapper (can share base with CalDAV)
2. Implement `ContactTargetWriter` interface
3. Define `Contact` model with UID, name, email, phone, org, custom fields
4. Implement `naturalKey = contact_uid`, `contentHash = sha256(normalized vCard)`
5. Handle vCard version negotiation (3.0/4.0)
6. Parse vdirsyncer output for contact sync status

**Acceptance:**
- Can sync contacts from source to CardDAV target
- Idempotency verified: re-run creates 0 contacts
- Delta handling: adding one contact creates exactly one
- vCard compatibility verified (both 3.0 and 4.0 targets)
- Integration test against Stalwart/Nextcloud CardDAV

**Reference:** `packages/engines/src/carddav-sync.ts`, `packages/shared/src/types/contact.ts`

---

### T3 — Files (WebDAV) foundation

**Goal:** Implement file sync using rclone

**Method:**
1. Create `packages/engines/src/webdav-sync.ts` — rclone wrapper with TypeScript API
2. Implement `FileTargetWriter` interface
3. Define `FileItem` model with path, size, contentHash, modifiedAt, isDirectory
4. Implement `naturalKey = file_path`, `contentHash = sha256(file content)`
5. Handle directory traversal, recursive sync
6. Support exclude/include patterns
7. Parse rclone output for sync status

**Acceptance:**
- Can sync files/folders from source to WebDAV target
- Idempotency verified: re-run creates 0 files
- Delta handling: adding one file creates exactly one
- Large files handled (chunked upload, progress tracking)
- Directory structure preserved
- Integration test against Nextcloud/Stalwart WebDAV

**Reference:** `packages/engines/src/webdav-sync.ts`, `packages/shared/src/types/file.ts`

---

### T4 — Unified target writer factory

**Goal:** Extend the target writer factory to support all data types

**Method:**
1. Update `buildTargetWriter()` to accept `dataType: 'mail' | 'calendar' | 'contact' | 'file'`
2. Implement factory logic that returns appropriate writer based on:
   - Target type (jmap, imap-dav, nextcloud, etc.)
   - Data type (mail, calendar, contact, file)
3. Create unified `SyncEngine` orchestrator that can run multiple data types in parallel
4. Extend ledger schema to support all data types (or create type-specific tables)

**Acceptance:**
- Config can specify multiple data types per mapping
- Factory returns correct writer for each combination
- All data types can be synced in a single run or independently
- Ledger tracks all data types with consistent idempotency

**Reference:** `packages/connectors/src/target-factory.ts`, `packages/core/src/sync-engine.ts`

---

### T5 — Provider-specific handling

**Goal:** Document and handle provider quirks for CalDAV/CardDAV/WebDAV

**Method:**
1. Update `docs/target-providers.md` with CalDAV/CardDAV/WebDAV specifics
2. Document known issues per provider:
   - **Nextcloud:** Full support for all three, well-tested
   - **Soverin:** CalDAV/CardDAV supported, files via Nextcloud backend
   - **Stalwart:** All three supported as reference implementation
   - **Proton:** Snapshot-only for calendar/contacts (no live sync)
3. Add provider detection and auto-configuration
4. Handle throttling/limits per provider

**Acceptance:**
- Documentation complete for all major providers
- Provider-specific quirks documented with workarounds
- Manual/secret-gated smoke tests pass against real accounts

**Reference:** `docs/target-providers.md`, `docs/caldav-carddav-webdav.md`

---

### T6 — Idempotency property tests

**Goal:** Extend idempotency tests to cover all three data types

**Method:**
1. Create property tests for calendar:
   - Sync calendar → re-run → 0 creates
   - Add one event → re-run → exactly 1 create
   - Modify event → re-run → update only changed
2. Create property tests for contacts:
   - Sync contacts → re-run → 0 creates
   - Add one contact → re-run → exactly 1 create
3. Create property tests for files:
   - Sync files → re-run → 0 creates
   - Add one file → re-run → exactly 1 create
   - Modify file → re-run → update only changed

**Acceptance:**
- All property tests pass against real targets (Stalwart/Nextcloud)
- Tests verify idempotency, delta handling, and non-destructive behavior
- Tests included in `pnpm test:integration`

**Reference:** `packages/ledger/src/caldav-idempotency.test.ts`, `packages/ledger/src/carddav-idempotency.test.ts`, `packages/ledger/src/webdav-idempotency.test.ts`

---

### T7 — Worker CLI & config extension

**Goal:** Extend worker CLI to support calendar/contacts/files

**Method:**
1. Extend `MappingConfig` schema to include:
   - `dataTypes: ('mail' | 'calendar' | 'contact' | 'file')[]`
   - Per-data-type configuration (source/target endpoints, credentials)
   - Sync options (one-way vs bidirectional, date ranges, filters)
2. Update worker CLI to handle multiple data types
3. Create `mapping.example.json` with all data type examples
4. Add CLI flags for selecting specific data types

**Acceptance:**
- Config can specify any combination of data types
- Worker can sync mail, calendar, contacts, and files in one run
- `mapping.example.json` provides complete reference
- CLI documentation updated

**Reference:** `apps/worker/src/index.ts`, `packages/shared/src/config.ts`

---

### T8 — Documentation & ADRs

**Goal:** Complete documentation for the new data types

**Method:**
1. Create `docs/caldav-carddav-webdav.md` with:
   - Overview of CalDAV/CardDAV/WebDAV protocols
   - Engine choices (vdirsyncer, rclone) and rationale
   - Configuration examples
   - Troubleshooting guide
2. Update `docs/testing.md` with new test patterns
3. Consider ADR if new decisions crystallize (e.g., engine choices, data models)
4. Update README.md quickstart to include all data types

**Acceptance:**
- Documentation complete and accurate
- Quickstart works for all data types
- Gates green (docs-hygiene check)

**Reference:** `docs/caldav-carddav-webdav.md`, `docs/testing.md`, `README.md`

---

## Out of scope (this slice)

- **Bidirectional sync conflict resolution** — MVP is one-way mirror; bidirectional with conflict handling is future work
- **Proton live sync** — Proton calendar/contacts lack open protocols; snapshot-only for now
- **Advanced calendar features:** 
  - Attendee management (invites, responses)
  - Free/busy queries
  - Calendar sharing
- **Advanced contact features:**
  - Contact groups/lists
  - Photo synchronization
  - vCard extensions
- **Advanced file features:**
  - File versioning
  - Conflict file creation (.sync-conflict)
  - Selective sync (folder filtering beyond basic patterns)
- **Graph-rich extraction** for calendar/contacts (beyond basic API)
- **Managed edition specifics** (Trigger.dev workflows, multi-tenant billing)

---

## Reuse vs new

**Reuses:**
- `Ledger` — same idempotency pattern, extended schema
- `Scheduler` — same orchestration layer
- `SourceConnector` — extended to support calendar/contacts/files via Graph
- Reconcile loop pattern — same architecture, different data models
- Idempotency + delta property tests — parametrized over data type

**New:**
- Three engine wrappers: `vdirsyncer` (CalDAV/CardDAV), `rclone` (WebDAV)
- Three data models: `CalendarEvent`, `Contact`, `FileItem`
- Three target writer implementations
- Unified `SyncEngine` orchestrator
- Provider-specific handling for CalDAV/CardDAV/WebDAV

**ADRs:**
- If engine choices (vdirsyncer/rclone) need formalization, create ADR
- If data model decisions differ significantly from mail pattern, document in ADR

---

## Testing strategy

### Unit Tests
- Data model serialization/deserialization
- Natural key + content hash computation
- vdirsyncer/rclone config generation
- Provider-specific folder/mapping logic

### Integration Tests
- End-to-end sync against Stalwart (CalDAV/CardDAV)
- End-to-end sync against Nextcloud (CalDAV/CardDAV/WebDAV)
- Idempotency property tests for each data type
- Delta handling tests
- Large file handling (rclone)

### Manual/Secret-Gated Tests
- Real Soverin account (CalDAV/CardDAV)
- Real Nextcloud instance (all three)
- Proton snapshot export (if applicable)

---

## Definition of Done (final gates)

**All of the following must be true before merging:**

1. ✅ **Code Quality:**
   - `pnpm lint` passes (no warnings)
   - `pnpm typecheck` passes (no errors)

2. ✅ **Tests:**
   - `pnpm test` passes (all unit tests)
   - `pnpm test:integration` passes (all integration tests)
   - Idempotency property tests green for calendar, contacts, files
   - Delta handling tests green for all three data types

3. ✅ **Documentation:**
   - `docs/caldav-carddav-webdav.md` created
   - `docs/target-providers.md` updated with CalDAV/CardDAV/WebDAV info
   - `docs/testing.md` updated with new test patterns
   - `README.md` quickstart includes all data types
   - `mapping.example.json` complete with all data type examples

4. ✅ **Architecture:**
   - All three data types follow the same idempotency pattern as mail
   - Non-destructive by default verified
   - Ledger schema extended appropriately
   - Target factory supports all combinations

5. ✅ **Operational:**
   - No secrets in code/repo
   - Docker hygiene (no leftover containers/volumes)
   - Workplan Status block updated with evidence
   - No blocking issues or TODOs left unaddressed

6. ✅ **PR Process:**
   - Branch created: `feat/0003-caldav-carddav-webdav`
   - All CI gates green on PR
   - PR description includes evidence of testing
   - Ready for merge to `main`

---

## Implementation notes

### vdirsyncer Setup
```bash
# Install vdirsyncer (system package or pip)
# For testing, use system installation
pip install vdirsyncer

# Configuration generated per sync job in temp directory
# Sync output parsed for status
```

### rclone Setup
```bash
# Install rclone (system package or binary)
# Configure remote via rclone config (non-interactive)
# Sync commands orchestrated via CLI
```

### Ledger Extensions
```sql
-- Option 1: Single table with type discriminator
ALTER TABLE ledger ADD COLUMN item_type TEXT NOT NULL DEFAULT 'mail';

-- Option 2: Separate tables per type (recommended for clarity)
CREATE TABLE ledger_calendar (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  mapping_id UUID NOT NULL,
  natural_key_hash BYTEA NOT NULL,
  content_hash BYTEA NOT NULL,
  target_id TEXT,
  status TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, mapping_id, natural_key_hash)
);

-- Similar for contacts and files
```

### Cursor Strategy
- **Calendar:** Use CalDAV `sync-token` (RFC 6578)
- **Contacts:** Use CardDAV `sync-token` (RFC 6578)
- **Files:** Use rclone's built-in state files / checksum tracking

---

## Timeline estimate

| Task | Estimated Effort | Dependencies |
|------|------------------|--------------|
| T1 — Calendar foundation | 2-3 days | 0001, 0002 complete |
| T2 — Contacts foundation | 1-2 days | T1 |
| T3 — Files foundation | 2-3 days | 0001, 0002 complete |
| T4 — Unified factory | 1 day | T1, T2, T3 |
| T5 — Provider handling | 1 day | T1, T2, T3 |
| T6 — Idempotency tests | 1-2 days | T1, T2, T3 |
| T7 — CLI extension | 1 day | T4 |
| T8 — Documentation | 1 day | All tasks |

**Total:** ~10-14 days (can be parallelized)

---

*Plan created based on workplan 0001 and 0002 patterns, following the established architecture and ADRs.*
