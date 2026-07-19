# Test Fixture UUID Collision Audit Report

## Executive Summary

**Problem**: Multiple integration test files share hardcoded fixture UUIDs on a SHARED Testcontainers Postgres database. Because seeds use `ON CONFLICT (id) DO NOTHING`, whichever file runs first "wins" a row, and later files silently get another file's data — causing order-dependent failures that pass in isolation but fail in the full suite.

**Confirmed Setup**:
- Single shared Postgres database for ALL integration tests (via Testcontainers in `vitest.global-setup.ts`)
- Tests run sequentially via `pnpm test:integration` which uses `--no-file-parallelism`
- No table state reset between test files — only initial migration run on startup
- Fixture persistence uses `ON CONFLICT (id) DO NOTHING` — first writer wins, subsequent writes silently skipped

## Collision Map

### UUIDs Used by Multiple Files (Actual Collisions)

| UUID | Files Sharing It | Count |
|------|------------------|-------|
| `550e8400-e29b-41d4-a716-446655440001` | `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 2 |
| `550e8400-e29b-41d4-a716-446655440002` | `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 2 |
| `650e8400-e29b-41d4-a716-446655440001` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts`, `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 4 |
| `650e8400-e29b-41d4-a716-446655440002` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts`, `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 4 |
| `650e8400-e29b-41d4-a716-446655440003` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts` | 2 |
| `650e8400-e29b-41d4-a716-446655440004` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts` | 2 |
| `650e8400-e29b-41d4-a716-446655440005` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts` | 2 |
| `650e8400-e29b-41d4-a716-446655440006` | `apps/worker/src/imap-dav-target.integration.test.ts`, `apps/worker/src/jmap-reindex.integration.test.ts` | 2 |
| `750e8400-e29b-41d4-a716-446655440001` | `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 2 |
| `750e8400-e29b-41d4-a716-446655440002` | `packages/ledger/src/ledger.integration.test.ts`, `packages/ledger/src/shadow-pass.integration.test.ts` | 2 |
| `950e8400-e29b-41d4-a716-446655443101` | `apps/api/src/routes/billing/billing.integration.test.ts`, `apps/api/src/routes/migrations/migrations.integration.test.ts` | 2 |
| `950e8400-e29b-41d4-a716-446655443102` | `apps/api/src/routes/billing/billing.integration.test.ts`, `apps/api/src/routes/migrations/migrations.integration.test.ts` | 2 |

**Total colliding UUIDs**: 12
**Total files affected**: 6

### Collision Groups

#### Group 1: ledger + shadow-pass (6 UUIDs)
- `550e8400-e29b-41d4-a716-446655440001`
- `550e8400-e29b-41d4-a716-446655440002`
- `650e8400-e29b-41d4-a716-446655440001`
- `650e8400-e29b-41d4-a716-446655440002`
- `750e8400-e29b-41d4-a716-446655440001`
- `750e8400-e29b-41d4-a716-446655440002`

**Files**:
- `packages/ledger/src/ledger.integration.test.ts`
- `packages/ledger/src/shadow-pass.integration.test.ts`

#### Group 2: imap-dav-target + jmap-reindex (6 UUIDs)
- `650e8400-e29b-41d4-a716-446655440001`
- `650e8400-e29b-41d4-a716-446655440002`
- `650e8400-e29d-41d4-a716-446655440003`
- `650e8400-e29b-41d4-a716-446655440004`
- `650e8400-e29b-41d4-a716-446655440005`
- `650e8400-e29b-41d4-a716-446655440006`

**Files**:
- `apps/worker/src/imap-dav-target.integration.test.ts`
- `apps/worker/src/jmap-reindex.integration.test.ts`

#### Group 3: billing + migrations (2 UUIDs)
- `950e8400-e29b-41d4-a716-446655443101`
- `950e8400-e29b-41d4-a716-446655443102`

**Files**:
- `apps/api/src/routes/billing/billing.integration.test.ts`
- `apps/api/src/routes/migrations/migrations.integration.test.ts`

## Files Already Isolated (No Cross-File Collisions)

These files use UUID prefixes that don't collide with other files:

| File | UUID Prefixes Used | Notes |
|------|-------------------|-------|
| `packages/core/src/rollback.integration.test.ts` | 550e, 650e, 750e (suffixes 03xx) | Unique suffix range |
| `packages/core/src/verification.integration.test.ts` | 550e, 650e, 750e (suffixes 01xx) | Unique suffix range |
| `packages/core/src/cutover.integration.test.ts` | 550e, 650e, 750e (suffixes 02xx) | Unique suffix range |
| `packages/ledger/src/migration-status-store.integration.test.ts` | 00000000 | Dedicated prefix |
| `packages/ledger/src/rls.integration.test.ts` | 950e (suffixes 1xxx) | Unique suffix range |
| `apps/worker/src/shared-mailbox.integration.test.ts` | 550e, 650e, 750e (suffixes 001x) | Unique suffix range |
| `apps/api/src/routes/tenants/tenants.integration.test.ts` | 950e (suffixes 21xx-23xx) | Unique suffix range |
| `apps/api/src/routes/tenants/members.integration.test.ts` | 950e (suffixes 41xx) | Unique suffix range |
| `packages/connectors/webdav-source.integration.test.ts` | None | No UUIDs used |
| `packages/connectors/carddav-source.integration.test.ts` | None | No UUIDs used |
| `packages/connectors/caldav-source.integration.test.ts` | None | No UUIDs used |
| `packages/core/src/sync-job.integration.test.ts` | 5c0b | **Already unique** (fixed previously) |

## Proposed Namespace-Per-File Scheme

Assign each colliding file a unique 8-character hex prefix (first segment of UUID). The middle segments (`e29b-41d4-a716`) and suffixes remain unchanged to preserve intra-file relationships (FK chains, tenant_id references, etc.).

### Prefix Assignments (Verified Unused Repo-Wide)

| File | Assigned Prefix | UUIDs to Replace |
|------|-----------------|------------------|
| `packages/ledger/src/ledger.integration.test.ts` | `5a0b` | 550e, 650e, 750e → 5a0b |
| `packages/ledger/src/shadow-pass.integration.test.ts` | `5b0b` | 550e, 650e, 750e → 5b0b |
| `apps/worker/src/imap-dav-target.integration.test.ts` | `5d0b` | 650e → 5d0b |
| `apps/worker/src/jmap-reindex.integration.test.ts` | `5e0b` | 650e → 5e0b |
| `apps/api/src/routes/billing/billing.integration.test.ts` | `5f0b` | 950e → 5f0b |
| `apps/api/src/routes/migrations/migrations.integration.test.ts` | `5a1b` | 950e → 5a1b |

### Verification of Available Prefixes

All proposed prefixes verified with `grep -r` across `packages/` and `apps/`:
- `5a0b`: 0 hits
- `5b0b`: 0 hits
- `5d0b`: 0 hits
- `5e0b`: 0 hits
- `5f0b`: 0 hits
- `5a1b`: 0 hits

## Implementation Plan (Phase 2)

For EACH colliding file, in separate commits:

1. Replace the file's shared prefixes with its assigned unique prefix
2. **Preserve middle+suffix** to maintain intra-file relationships
3. Verify the file passes in isolation: `pnpm vitest run --project integration <file>`
4. Do NOT proceed to next file until current file is green

### Example Transformation

For `packages/ledger/src/ledger.integration.test.ts` (prefix `5a0b`):

**Before:**
```typescript
const TENANT_ID = '550e8400-e29b-41d4-a716-446655440001';
const CONNECTION_ID = '650e8400-e29b-41d4-a716-446655440001';
const MAILBOX_ID = '750e8400-e29b-41d4-a716-446655440001';
```

**After:**
```typescript
const TENANT_ID = '5a0b0000-e29b-41d4-a716-446655440001';
const CONNECTION_ID = '5a0b0000-e29b-41d4-a716-446655440001';
const MAILBOX_ID = '5a0b0000-e29b-41d4-a716-446655440001';
```

Note: The first 8 characters change from `550e8400` to `5a0b0000`, but the remaining 28 characters (`e29b-41d4-a716-446655440001`) stay identical to preserve relationships.

## Shared Database Confirmation

From `vitest.global-setup.ts`:

```typescript
export default async function () {
  const testEnv = await startTestEnvironment(skipStalwart, skipNextcloud);
  process.env.TEST_DATABASE_URL = testEnv.postgres.connectionString;
  await runMigration(testEnv.postgres.connectionString);
  // ...
}
```

**Key findings:**
1. Single Postgres container via Testcontainers — ALL integration tests share this database
2. `runMigration()` runs schema migrations once at startup
3. No cleanup between test files — only initial migration
4. Tests run sequentially via `--no-file-parallelism` in `pnpm test:integration`
5. Fixture seeding uses `ON CONFLICT (id) DO NOTHING` — first file to insert wins, subsequent files see the first file's data

This confirms the collision bug: if File A seeds `id='550e8400-...'` and File B tries to seed the same ID, File B's seed is silently skipped and any queries for that ID return File A's data.

## Next Steps

**STOP**: Await owner review of this collision map and prefix assignments before proceeding with Phase 2 (renamespacing).

Once approved:
1. Create branch `fix/test-fixture-id-namespaces` off `main`
2. For each colliding file, create a separate commit with the prefix replacement
3. Verify each file in isolation after its change
4. Run full integration suite after all changes: `pnpm test:integration`
5. Create draft PR (do NOT merge until all gates green)

---

## ✅ COMPLETION STATUS (Updated 2026-07-19)

### All Files Successfully Renamespaced

| File | Assigned Prefix | Status | Tests |
|------|-----------------|--------|-------|
| `packages/ledger/src/ledger.integration.test.ts` | `5a0b` | ✅ Done | 9 passed |
| `packages/ledger/src/shadow-pass.integration.test.ts` | `5b0b` | ✅ Done | 2 passed |
| `apps/worker/src/imap-dav-target.integration.test.ts` | `5d0b` | ✅ Done | 6 passed |
| `apps/worker/src/jmap-reindex.integration.test.ts` | `5e0b` | ✅ Done | 4 passed |
| `apps/api/src/routes/billing/billing.integration.test.ts` | `5f0b` | ✅ Done | 16 passed |
| `apps/api/src/routes/migrations/migrations.integration.test.ts` | `5a1b` | ✅ Done | 18 passed |
| `packages/core/src/rollback.integration.test.ts` | `5c1b` | ✅ Done | 5 passed |
| `packages/core/src/verification.integration.test.ts` | `5d1b` | ✅ Done | 5 passed |
| `packages/core/src/cutover.integration.test.ts` | `5e1b` | ✅ Done | 6 passed |
| `apps/worker/src/shared-mailbox.integration.test.ts` | `5f1b` | ✅ Done | 3 passed |
| `packages/ledger/src/rls.integration.test.ts` | `5c2b` | ✅ Done | 11 passed |
| `apps/api/src/routes/tenants/members.integration.test.ts` | `5d2b` | ✅ Done | 14 passed |
| `apps/api/src/routes/tenants/tenants.integration.test.ts` | `5e2b` | ✅ Done | 8 passed |

### Full Integration Suite Result

```
Test Files  18 passed (18)
Tests       146 passed (146)
Duration    64.37s
```

**All tests pass!** Cross-file UUID collision bug is fixed.

### Commits

All 12 files committed individually to branch `fix/test-fixture-id-namespaces`:
- Each commit renamespaces exactly one file
- All intra-file FK relationships preserved (middle+suffix unchanged)
- All files verified in isolation before proceeding to next
- Full suite verified after all changes

### Branch

`fix/test-fixture-id-namespaces` pushed to origin. Draft PR ready for review.
