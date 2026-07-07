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
  programmatically — **Postgres** and **Stalwart v0.16.10 (official image, two-phase
  startup: recovery-mode provisioning, then normal serving)**. No env vars or pre-running dev
  stack required; ports are dynamic. Tests exercise the ledger, the IMAP source, the JMAP writer,
  and the shadow-pass property tests (idempotency + delta) end-to-end.
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

The optional `deploy/compose/dev.yml` stack remains available for manual exploration, but the
integration suite does not depend on it.

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

## Test isolation patterns

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
- `e2e.yml` — manual only, on `[self-hosted, linux, arm64]` (the Spark); brings up
  `deploy/compose/dev.yml`, attaches the runner to the network, applies Drizzle migrations to a
  fresh DB, runs the slice incl. the idempotency property test, then tears down.
- `no-committed-artifacts.yml` — PR guard against committed `node_modules/`, build outputs, local
  DBs, and `.env`.

Runners: GitHub-hosted for lint/unit/build and multi-arch image builds; the self-hosted arm64
Spark runner for integration/e2e. The Spark runner executes trusted workflows only. The
integration job installs `stalwart-cli` as a host binary for the provisioning phase.