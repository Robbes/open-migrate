# Per-Domain Sync Design Proposal

**Issue**: #37 (Part B2)  
**Status**: Proposal — awaiting owner approval before implementation

## Context

The worker currently runs ONLY mail via `runShadowPass` (packages/core/src/reconcile.ts). The DAV connectors (CalDAV/CardDAV/WebDAV) exist and pass their integration tests, but nothing orchestrates them. The `MigrationStatusStore` exists but is never called during real runs.

The `runShadowPass` loop is proven and idempotent:
```
listFolders → per folder: get cursor → source.listSince → 
  mapWithConcurrency( 
    naturalKeyForItem → ledger.find(fast-path) → 
    source.fetch → target.upsert* → ledger.recordIfAbsent 
  ) → persist cursor after folder success
```

## Goal

Wire per-domain sync (calendar, contacts, files) + status tracking into the worker. Two pieces:
1. **Per-domain sync functions** — mirror the shadow pass pattern for DAV domains
2. **Worker orchestration** — run all enabled domains independently, track status via MigrationStatusStore

---

## Piece 1: Per-Domain Sync Architecture

### Option (i): Generalized `runDomainSync` (RECOMMENDED)

One parameterized function that takes the domain string, domain-typed source/target, and the appropriate upsert method.

```typescript
// New type for domain-sync dependencies
export interface DomainSyncDeps<Source, Target, Item> {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly domain: 'email' | 'calendar' | 'contact' | 'file';
  readonly source: Source;
  readonly target: Target;
  readonly ledger: Ledger;
  readonly cursors?: CursorStore;
  readonly concurrency?: number;
  // Domain-specific item → raw mapping
  readonly fetchRaw: (item: Item) => Promise<{ raw: unknown; sizeBytes: number }>;
  // Domain-specific upsert method
  readonly upsert: (targetId: string, raw: unknown) => Promise<UpsertResult>;
  // Domain-specific natural key extraction
  readonly naturalKey: (item: Item) => string;
  // Domain-specific content hash
  readonly contentHash: (raw: unknown) => string;
}

export async function runDomainSync<Source, Target, Item>(
  deps: DomainSyncDeps<Source, Target, Item>
): Promise<ReconcileResult> {
  // SAME loop as runShadowPass, parameterized by the injected functions
}
```

**Thin wrappers**:
```typescript
// mail (existing runShadowPass becomes a wrapper)
export const runShadowPass: RunShadowPass = (deps) =>
  runDomainSync({
    ...deps,
    domain: 'email',
    fetchRaw: async (item) => ({ raw: await source.fetch(item), sizeBytes: item.size ?? 0 }),
    upsert: (mailboxId, raw, keywords) => target.upsertEmail(mailboxId, raw, keywords),
    naturalKey: (item) => naturalKeyForItem(item),
    contentHash: (raw) => contentHash(raw.rfc822),
  });

// calendar
export async function runCalendarSync(deps: CalendarSyncDeps): Promise<ReconcileResult> {
  return runDomainSync({
    ...deps,
    domain: 'calendar',
    fetchRaw: async (item) => ({ raw: item.icalendar, sizeBytes: item.size ?? 0 }),
    upsert: (calendarId, raw) => target.upsertCalendarEvent(calendarId, { item, icalendar: raw }),
    naturalKey: (item) => calendarNaturalKeyHash(item.uid),
    contentHash: (raw) => calendarContentHash(raw),
  });
}

// contact
export async function runContactSync(deps: ContactSyncDeps): Promise<ReconcileResult> {
  return runDomainSync({
    ...deps,
    domain: 'contact',
    fetchRaw: async (item) => ({ raw: item.vcard, sizeBytes: item.size ?? 0 }),
    upsert: (folderId, raw) => target.upsertContact(folderId, { item, vcard: raw }),
    naturalKey: (item) => contactNaturalKeyHash(item.uid),
    contentHash: (raw) => contactContentHash(raw),
  });
}

// file
export async function runFileSync(deps: FileSyncDeps): Promise<ReconcileResult> {
  return runDomainSync({
    ...deps,
    domain: 'file',
    fetchRaw: async (item) => ({ raw: item.content ?? new Uint8Array(0), sizeBytes: item.size }),
    upsert: (parentId, raw, item) => target.upsertFile(parentId, { item, content: raw }),
    naturalKey: (item) => fileNaturalKeyHash(item.path),
    contentHash: (raw) => fileContentHash(raw),
  });
}
```

**Pros**:
- Single tested loop — one place to fix bugs, one place to optimize
- DRY — no code duplication across domains
- The loop logic (cursor persistence, concurrency, ledger fast-path) stays identical
- Easier to maintain: change the loop once, all domains benefit

**Cons**:
- Slightly more abstract — requires understanding the injection pattern
- Type signatures are more complex (generics)

### Option (ii): Separate Per-Domain Functions

Duplicate the loop for each domain, changing only the domain string and upsert method.

```typescript
export async function runCalendarSync(deps: CalendarSyncDeps): Promise<ReconcileResult> {
  // COPY of runShadowPass loop, but:
  // - domain = 'calendar'
  // - target.upsertCalendarEvent instead of upsertEmail
  // - calendarNaturalKeyHash instead of naturalKeyForItem
  // - calendarContentHash instead of contentHash
}

// Same for runContactSync, runFileSync
```

**Pros**:
- Explicit — each function is self-contained
- Easier to understand for someone reading just one domain

**Cons**:
- Code duplication — the loop logic is copied 4 times
- Bug fixes/optimizations must be applied to all 4 copies
- Risk of divergence over time (one domain gets a fix, others don't)
- Violates DRY principle

### Recommendation: Option (i) — Generalized `runDomainSync`

**Rationale**:
1. The loop logic is ALREADY domain-agnostic in `runShadowPass` — the only hardcoded thing is the string `'mail'` and the specific `upsertEmail` call. Parameterizing these is natural, not forced.
2. No generic-type mistake — this is NOT about creating a `GenericItem` type. Each wrapper still operates on REAL domain-typed sources/targets (`CalendarSource`, `CalendarTargetWriter`, etc.). The abstraction is at the function level, not the type level.
3. Single source of truth for the loop — if we need to fix a race condition, optimize concurrency, or add logging, we do it once.
4. The injection pattern (fetchRaw, upsert, naturalKey, contentHash) cleanly separates domain-specific concerns from the orchestration loop.

### Critical: Item Records Must Include `domain` + `sizeBytes`

The `MigrationStatusStore.getStatus()` query derives counts from the `item` table:

```sql
SELECT 
  COUNT(CASE WHEN item.status IN ('copied', 'updated', 'skipped') THEN 1 END) as itemsSynced,
  COUNT(CASE WHEN item.status = 'failed' THEN 1 END) as itemsFailed,
  COALESCE(SUM(CASE WHEN item.status IN ('copied', 'updated', 'skipped') THEN item.sizeBytes ELSE 0 END), 0) as bytesTransferred
FROM migration_status
LEFT JOIN item ON ...
WHERE item.domain = migration_status.domain
```

**CRITICAL REQUIREMENT**: Every domain sync MUST write item records with:
1. **Correct `domain` value** — `'email'`, `'calendar'`, `'contact'`, or `'file'`
2. **Correct `sizeBytes`** — the actual size of the item in bytes

If either is missing/incorrect, the status counts will be zero or wrong.

The ledger `recordIfAbsent` call must include `sizeBytes`:
```typescript
await ledger.recordIfAbsent({
  tenantId,
  itemType: 'calendar', // or 'contact', 'file'
  mappingId,
  naturalKeyHash,
  contentHash,
  targetId,
  createdAt: new Date().toISOString(),
  sizeBytes: <calculated from raw data>,
});
```

Note: The current `LedgerRecord` interface in `packages/shared/src/ports.ts` does NOT have a `sizeBytes` field — this needs to be added.

---

## Piece 2: Worker Orchestration + Status Lifecycle

### Current State

`apps/worker/src/index.ts` currently:
1. Loads a mapping config
2. Builds deps (source, target, ledger, cursors)
3. Calls `runShadowPass(deps)` — ONLY mail

### Required Changes

For each mapping, orchestrate ALL enabled domains INDEPENDENTLY:

```typescript
const domains: Array<'email' | 'calendar' | 'contact' | 'file'> = ['email', 'calendar', 'contact', 'file'];

for (const domain of domains) {
  // 1. Check if enabled in config
  const domainConfig = config.domains?.[domain];
  if (!domainConfig?.enabled) {
    await statusStore.markSkipped(tenantId, mappingId, domain);
    continue;
  }

  // 2. Initialize status
  await statusStore.initDomainStatus(tenantId, mappingId, domain);
  
  // 3. Mark in progress
  await statusStore.markInProgress(tenantId, mappingId, domain);
  
  // 4. Run the sync
  try {
    let result: ReconcileResult;
    switch (domain) {
      case 'email':
        result = await runShadowPass(mailDeps);
        break;
      case 'calendar':
        result = await runCalendarSync(calendarDeps);
        break;
      case 'contact':
        result = await runContactSync(contactDeps);
        break;
      case 'file':
        result = await runFileSync(fileDeps);
        break;
    }
    
    // 5. Mark completed
    await statusStore.markCompleted(tenantId, mappingId, domain);
  } catch (error) {
    // 6. Mark failed (does NOT block other domains)
    await statusStore.markFailed(tenantId, mappingId, domain, error.message);
  }
}
```

### Key Requirements

1. **Independent execution** — A failed calendar sync must NOT block contacts or files
2. **Status lifecycle** — Each domain goes through: pending → in_progress → completed/failed/skipped
3. **Enabled flags** — Read from `config.domains.<domain>.enabled` (already defined in `packages/shared/src/config.ts`)
4. **Ports-and-adapters** — Worker depends on `@openmig/shared` ports (`MigrationStatusStore` interface), NOT ledger internals
5. **Mail stays working** — The existing mail sync must continue to work exactly as it does now

### Ledger Schema Check

The `item` table schema (from `packages/ledger/src/schema-pg.ts`):
```typescript
domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
```

The `itemDomain` type in the schema matches the `MigrationStatusStore` domain type — good.

---

## Implementation Plan (After Approval)

### Phase 1: Core Infrastructure
1. Add `sizeBytes` to `LedgerRecord` interface in `packages/shared/src/ports.ts`
2. Add `sizeBytes` to ledger record insertion in `packages/ledger/src/item-ledger.ts`
3. Create `DomainSyncDeps` and `runDomainSync` generic function in `packages/core/src/`
4. Create domain-specific wrapper functions (`runCalendarSync`, `runContactSync`, `runFileSync`)

### Phase 2: Worker Integration
5. Update `apps/worker/src/build-deps.ts` to create per-domain deps (source/target for each domain)
6. Update `apps/worker/src/index.ts` to orchestrate all enabled domains
7. Wire up `MigrationStatusStore` from ledger to worker

### Phase 3: Tests
8. Add integration tests for each domain (mirror shadow-pass tests)
9. Test idempotency for each domain (first run creates N, second run creates 0)
10. Test status counts derive correctly from item records
11. Test independent failure handling (one domain fails, others succeed)

### Phase 4: Verification
12. Run full test suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`
13. Verify existing mail shadow-pass still works (First 3/3, Second 0, Delta 1)
14. Verify DAV connector tests still pass
15. Verify migration-status tests still pass

---

## Open Questions for Owner Review

1. **Approve Option (i) vs Option (ii)** — Do we go with the generalized `runDomainSync` or separate functions?

2. **Ledger `sizeBytes` gap** — The schema has `sizeBytes` but:
   - `LedgerRecord` interface in `packages/shared/src/ports.ts` does NOT include `sizeBytes`
   - `PgLedger.recordIfAbsent` does NOT insert `sizeBytes` (line 56-89 in ledger.ts)
   - **Must fix**: Add `sizeBytes?: number` to `LedgerRecord`, pass it through `recordIfAbsent`

3. **Item status values** — The schema has status enum (`'pending'`, `'copied'`, `'updated'`, `'skipped'`, `'failed'`, etc.) and the `MigrationStatusStore.getStatus()` query expects these values. Currently:
   - `PgLedger.recordIfAbsent` hardcodes `status: 'copied'` (line 69)
   - This is fine for initial implementation — all successful items get `'copied'`
   - Later we may want to distinguish `'updated'` (item changed) vs `'copied'` (new item)

4. **Cursor persistence for DAV** — The `CursorStore` interface exists but is only used for mail. Need to verify/calibrate for CalDAV/CardDAV/WebDAV sources.

5. **Throttling** — Should each domain have its own throttle configuration? (Already in `DomainConfig` but not yet used)

---

## Next Steps

1. Owner reviews this proposal
2. Owner approves Option (i) (or requests Option (ii))
3. Implementation begins (still in same PR, or new PR if owner prefers)
4. Tests added and verified
5. Gates green → merge
