# Testing

Canonical doc. Summarises the testing approach; full rationale in
`architecture/solution-architecture.md` §22 / §22.1. For everything Stalwart-specific
(two-phase startup, provisioning, TLS-only listeners, known traps) the authoritative reference is
`docs/stalwart-integration-fix.md` — read it before changing the integration setup.

## Test pyramid
- **Unit** (vitest): pure logic — reconcile decisions, idempotency keying, special-use/folder
  mapping, Pattern S/D resolution. No I/O.
- **Connector contract tests**: each source/target adapter against a recorded/standard contract.
- **Integration** (Testcontainers for Node): the global setup spins up the full stack
  programmatically — **Postgres**, **Stalwart v0.16.10 (official image, two-phase
  startup: recovery-mode provisioning, then normal serving)**, and **Nextcloud** (CalDAV/CardDAV/
  WebDAV target). No env vars or pre-running dev stack required; ports are dynamic. Tests exercise
  the ledger, the IMAP/JMAP/imap-dav mail path, and — since issue #114 — the CalDAV/CardDAV/WebDAV
  **target-write** path (see "Multi-domain target-write coverage" below), all with the
  idempotency + delta property (first pass creates N, second pass creates 0).
- **E2E** (docker compose, manual): the real SMB O365 source (read-only, least-privilege) into a
  disposable target; full slice.

## Running tests locally

### Unit tests (no dependencies)
```bash
pnpm test
```

### Integration tests (requires Docker only)
```bash
pnpm test:integration
```
Testcontainers manages everything: fresh Postgres, fresh Stalwart (two-phase: recovery-mode
provisioning of `dev.local` + `source@dev.local` / `target@dev.local` via `stalwart-cli apply`,
then a normal-mode container on the same data volume), schema migration, and teardown including
volume cleanup. Stalwart binds **TLS listeners only** (IMAPS 993, HTTPS 443, SMTPS 465, POP3S 995)
plus unencrypted management/JMAP HTTP on 8080; there is **no plaintext IMAP 143** — the IMAP
client connects to 993 with `rejectUnauthorized: false` for the self-signed test certificate.

The optional `deploy/compose/dev.yml` stack (Postgres + Nextcloud) remains available for manual
exploration, but the integration suite does not depend on it. `dev.yml` does **not** include
Stalwart — its two-phase startup can't be expressed as one `docker compose` service; bring it up
with `deploy/selfhost/setup-stalwart.sh` instead (joins `dev.yml`'s `openmig_dev-network`, so it's
reachable from anything else on that network too).

### E2E tests (manual, requires Docker and real O365 credentials)
```bash
# See docs/deployment.md for full setup
```

## Testcontainers invariants (enforced by the setup; see stalwart-integration-fix.md for rationale)
- Exactly **one Stalwart container per data volume at any moment** (RocksDB exclusive lock);
  phase 1 is fully stopped and confirmed gone before phase 2 starts.
- **Fresh, uniquely named volume per run**, removed in teardown — never reuse dirty volumes.
- Per-phase server logs are streamed to `test-logs/stalwart-phase{1,2}.log`; the log consumer is
  attached to the container instance actually started (retry-loop trap).
- **Test isolation via mailbox cleanup**: Integration tests that share Stalwart accounts must
  clean ALL target mailboxes and database state before each test. This prevents data leakage
  between tests without the overhead of unique accounts per test. See `apps/worker/src/jmap-reindex.integration.test.ts`
  for the canonical pattern: `cleanTargetMailboxes()` + `cleanDatabaseState()` in `beforeEach`.
- Ledger **cursors are isolated between tests**; no test may read another test's cursor.
- After every mirror run the tests **assert the source INBOX count is unchanged**
  (cross-account-pollution guard).

## Property Testing Patterns

### Per-Domain Property Test Pattern

For multi-domain sync (calendar, contacts, files), use the following property test pattern:

#### Idempotency Test

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { GenericSyncEngine } from '@openmig/core';
import { CalDAVSource } from '@openmig/connectors';

describe('CalDAV Sync Idempotency', () => {
  let source: CalDAVSource;
  let target: CalDAVTargetWriter;
  let ledger: Ledger;
  let cursors: CursorStore;
  let engine: GenericSyncEngine;

  beforeEach(async () => {
    await cleanTargetMailboxes();
    await cleanDatabaseState(TENANT_ID, MAPPING_ID);
    
    source = new CalDAVSource({
      url: 'https://caldav.example.com/dav/',
      username: 'user@example.com',
      passwordEnv: 'CALDAV_PASSWORD',
    });
    target = new CalDAVTargetWriter({ /* ... */ });
    ledger = createTestLedger();
    cursors = createTestCursorStore();
    
    engine = new GenericSyncEngine({
      tenantId: TENANT_ID,
      mappingId: MAPPING_ID,
      source,
      target,
      ledger,
      cursors,
      concurrency: 4,
      itemType: 'calendar',
    });
  });

  it('should create 0 items on second run', async () => {
    // First sync
    const result1 = await engine.sync();
    expect(result1.created).toBeGreaterThan(0);
    
    // Second sync - should create nothing
    const result2 = await engine.sync();
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(result1.scanned);
  });
});
```

#### Delta Test

```typescript
describe('CalDAV Sync Delta', () => {
  it('should sync only modified items', async () => {
    // Initial sync
    const result1 = await engine.sync();
    const initialCount = result1.scanned;
    
    // Modify one item on source
    await modifySourceEvent('event-uid-123');
    
    // Second sync - should only sync the modified item
    const result2 = await engine.sync();
    expect(result2.scanned).toBe(1);
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(1);
  });
});
```

#### Reindex Test

```typescript
describe('CalDAV Reindex', () => {
  it('should create 0 items when ledger is wiped and reindexed', async () => {
    // Initial sync
    const result1 = await engine.sync();
    expect(result1.created).toBeGreaterThan(0);
    
    // Wipe ledger
    await cleanDatabaseState(TENANT_ID, MAPPING_ID);
    
    // Reindex - should adopt existing items (create-if-absent)
    const result2 = await engine.sync();
    expect(result2.created).toBe(0);
    expect(result2.skipped).toBe(result1.scanned);
  });
});
```

### Domain-Specific Test Files

Use the `*.unit.test.ts` or `*.integration.test.ts` naming convention:

- `caldav-source.unit.test.ts` / `caldav-source.integration.test.ts` - CalDAV **source** connector
  (discovery, listSince, cursor round-trip) against Nextcloud.
- `carddav-source.unit.test.ts` / `carddav-source.integration.test.ts` - CardDAV **source**
  connector, same shape.
- `webdav-source.unit.test.ts` / `webdav-source.integration.test.ts` - WebDAV **source** connector,
  same shape.
- `generic-sync.idempotency.unit.test.ts` - Generic sync engine idempotency tests.
- `packages/core/src/dav-sync.integration.test.ts` - **target-write** coverage for all three DAV
  domains (see "Multi-domain target-write coverage" below).

### Multi-domain target-write coverage (issue #114)

Chasing the 0010 T5 gate surfaced two production "target was never connected" bugs
(`JmapTargetWriter` #112, `ImapDavMailTarget` #113) that shipped undetected because the DAV
source-only tests above never exercised the **write** side (`upsertCalendarEvent`/`upsertContact`/
`upsertFile`) against a real target, and the only test that did (`o365-scenario.e2e.test.ts`) runs
`dryRun: true` and is secret-gated (never in CI). `packages/core/src/dav-sync.integration.test.ts`
closes that gap: a synthetic in-memory source (isolating the untested leg) feeds N seeded
calendar events / contacts / files through `runCalendarSync` / `runContactSync` / `runFileSync`
into a **real** `CalDAVTargetWriter` / `CardDAVTargetWriter` / `WebDAVTargetWriter` writing to
Nextcloud, with **no manual `connect()`** (there's no `connect()` on the `*TargetWriter`
interfaces — this is what masked #112/#113). Each domain asserts: first pass creates N (N>0),
second pass creates 0, and the items are read back from Nextcloud via the real source connector.
The IMAP/DAV mail equivalent (the second mail family, alongside JMAP) is
`apps/worker/src/imap-dav-target.integration.test.ts`'s "Idempotency property" suite, exercising
`ImapDavMailTarget` through the same lazy-connect path with the same N / 0-on-rerun assertion —
proven as part of the #113 fix.

### Native Connector Property Tests

The native CalDAV, CardDAV, and WebDAV connectors support the following property tests:

#### CalDAV-Specific Tests

```typescript
describe('CalDAV Source Properties', () => {
  it('should normalize UIDs to lowercase (case-insensitive)', async () => {
    const source = new CalDAVSource({ /* config */ });
    const { items } = await source.listSince(folder);
    
    // All UIDs should be lowercase
    items.forEach(item => {
      expect(item.item.uid).toBe(item.item.uid.toLowerCase());
    });
  });

  it('should support sync-token and CTag fallback', async () => {
    const source = new CalDAVSource({ /* config */ });
    
    // First sync returns sync-token
    const { nextCursor: cursor1 } = await source.listSince(folder);
    expect(cursor1.value).toMatch(/^sync-token:/);
    
    // Simulate server that doesn't support sync-token
    // Should fall back to CTag format
  });
});
```

#### CardDAV-Specific Tests

```typescript
describe('CardDAV Source Properties', () => {
  it('should preserve UID case (case-sensitive)', async () => {
    const source = new CarddavSource({ /* config */ });
    const { items } = await source.listSince(folder);
    
    // UIDs should preserve their original case
    items.forEach(item => {
      // UID casing should match source exactly
      expect(item.item.uid).toBe(originalUid);
    });
  });

  it('should parse vCard 3.0 and 4.0 formats', async () => {
    const source = new CarddavSource({ /* config */ });
    const { items } = await source.listSince(folder);
    
    // Should handle both vCard versions
    items.forEach(item => {
      expect(item.vcard).toMatch(/^BEGIN:VCARD/);
      expect(item.vcard).toMatch(/VERSION:(3\.0|4\.0)/);
    });
  });
});
```

#### WebDAV-Specific Tests

```typescript
describe('WebDAV Source Properties', () => {
  it('should detect changes via ETag', async () => {
    const source = new WebdavFileSource({ /* config */ });
    
    const { items: items1, nextCursor: cursor1 } = await source.listSince(folder);
    const { items: items2 } = await source.listSince(folder, cursor1);
    
    // No changes should result in empty delta
    expect(items2).toHaveLength(0);
  });

  it('should fall back to size/mtime when ETag unavailable', async () => {
    const source = new WebdavFileSource({ /* config */ });
    
    // When ETag is missing, should use size and mtime for change detection
    const { items } = await source.listSince(folder);
    items.forEach(item => {
      expect(item.item.size).toBeDefined();
      expect(item.item.modifiedAt).toBeDefined();
    });
  });

  it('should normalize paths consistently', async () => {
    const source = new WebdavFileSource({ /* config */ });
    
    // Different path formats should normalize to the same value
    const path1 = source['normalizePath']('/Documents//Reports/');
    const path2 = source['normalizePath']('Documents\\Reports');
    expect(path1).toBe(path2);
  });
});
```

## Test Isolation Patterns

### Mailbox cleanup (recommended for shared accounts)

When multiple tests share the same Stalwart accounts, clean ALL target mailboxes and database
state before each test:

```typescript
async function cleanTargetMailboxes(): Promise<void> {
  const config: ImapSimpleOptions = { /* ... */ };
  const conn = await imap.connect(config);
  
  const mailboxes = await conn.getMailboxes();
  for (const mailbox of Object.values(mailboxes)) {
    await conn.openBox(mailbox.name);
    const all = await conn.search(['ALL'], { fields: ['UID'] });
    if (all.length > 0) {
      const uids = all.map(r => r.attributes.uid);
      await conn.addFlags(uids, '\\Deleted');
      await conn.expunge();
    }
  }
  conn.end();
}

async function cleanDatabaseState(tenantId: string, mappingId: string): Promise<void> {
  await db.sql`DELETE FROM cursor WHERE mapping_id = ${mappingId}`;
  await db.sql`DELETE FROM item WHERE tenant_id = ${tenantId}`;
  await db.sql`DELETE FROM mailbox WHERE tenant_id = ${tenantId}`;
}

// In beforeEach:
beforeEach(async () => {
  await cleanTargetMailboxes();
  await cleanDatabaseState(TENANT_ID, MAPPING_ID);
  await seedTestData(); // Optional: seed fresh test data
});
```

**Why this approach?**
- ✅ Simple: No complex account provisioning or container management
- ✅ Fast: No container startup overhead (~10-15s saved per test file)
- ✅ Reusable: Works with the existing shared Stalwart infrastructure
- ✅ Standard: Follows the "clean slate" pattern common in integration testing

**When to use unique accounts instead:**
- Tests that need to run truly in parallel (same Stalwart instance)
- Tests that modify account-level settings (not just message data)
- Tests that verify account-specific behavior

### Unique accounts per test (advanced)

For true isolation, each test file can start its own Stalwart container with unique accounts:

```typescript
import { generateTestAccounts, startStalwartIsolated } from '@openmig/testing';

const TEST_ACCOUNTS = generateTestAccounts('mytest');

beforeAll(async () => {
  const stalwart = await startStalwartIsolated([
    { name: TEST_ACCOUNTS.source.name, password: TEST_ACCOUNTS.source.password },
    { name: TEST_ACCOUNTS.target.name, password: TEST_ACCOUNTS.target.password },
  ]);
  // Use stalwart.imapHost, stalwart.imapPort, etc.
});
```

**Trade-offs:**
- ✅ Complete isolation: No shared state at all
- ❌ Complex: Each test file manages its own container lifecycle
- ❌ Slow: ~10-15 seconds overhead per test file for container startup
- ❌ Resource intensive: Multiple containers if tests run in parallel

Generally, **mailbox cleanup is preferred** unless you have a specific need for complete isolation.

## CI mapping (.github/workflows)
- `ci.yml` — `detect-changes -> docs-hygiene (parallel) -> lint -> unit-tests ->
  integration-tests`; docs-hygiene enforces the root `.md` allowlist and that the canonical docs
  exist.
- `security-scan.yml` — pnpm audit + Trivy (SARIF) + CycloneDX SBOM; weekly + PR + push + manual;
  SBOM attached to release tags.
- `e2e.yml` — manual only, on `[self-hosted, linux, arm64]` (the Spark); brings up Stalwart via
  `deploy/selfhost/setup-stalwart.sh` (the two-phase recovery→normal bring-up — not a
  `docker compose` service, since compose can't express that transition for one service), seeds
  the source over IMAPS, builds + starts the self-host appliance, and runs the workplan 0010 T5
  restart-resume idempotency gate, then tears down. Installs `stalwart-cli` itself (same install
  step as `integration-tests`, see below) since it drives `setup-stalwart.sh`'s provisioning phase.
- `no-committed-artifacts.yml` — PR guard against committed `node_modules/`, build outputs, local
  DBs, and `.env`.

Runners: GitHub-hosted for lint/unit/build and multi-arch image builds; the self-hosted arm64
Spark runner for integration/e2e. The Spark runner executes trusted workflows only. Both the
`integration-tests` job and `e2e.yml` install `stalwart-cli` as a host binary for their respective
provisioning phases.