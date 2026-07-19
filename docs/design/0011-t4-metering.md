# Design: Workplan 0011 T4 — Usage Metering from Real Migration Runs

**Date:** 2026-07-19  
**Status:** Draft — awaiting owner approval  
**Branch:** `feat/0011-t4-metering`  
**Related:** Workplan 0011 T4, ADR-0014 (cost-recovery billing), ADR-0023 (Postgres-only)

---

## 1. What Gets Metered and At What Granularity

### Billing Model (from ADR-0014, §16)

**Cost drivers:**
- **Storage:** Data retained on target (GB)
- **Egress:** Data transferred from source (GB)  
- **Compute:** Worker time for sync operations (hours/minutes)
- **API calls:** Number of sync operations (count)

**Pricing:** Cost-recovery (flat base + pass-through, no margin)

### Metering Granularity

**Per tenant, per billing period, per metric type:**

| Metric | Granularity | Source | Derivation |
|--------|-------------|--------|------------|
| `storage` | Per tenant, monthly | `item` ledger | `SUM(sizeBytes)` for items synced in period (status: copied/updated/skipped), filtered by `lastSyncedAt` |
| `egress` | Per tenant, monthly | `item` ledger | **Same as storage** — every byte synced is both read from source AND retained on target. No separate egress tracking needed. |
| `compute` | Per tenant, monthly | `migration_status` | `SUM(completedAt - startedAt)` across all domain syncs in period |
| `api_calls` | Per tenant, monthly | `migration_status` | Count of completed sync runs in period |

**Resource qualifier:** Optional breakdown by domain (`email`, `calendar`, `contact`, `file`) or mapping.

**Why this granularity:**
- Matches the billing model (cost-recovery per §16)
- Aligns with `usage_metric` schema (unique constraint: `tenant_id, period_start, metric_type, resource`)
- Supports itemization on invoices (storage vs egress vs compute)

**Storage vs Egress Clarification:**

These are billed as separate line items per ADR-0014, but for this product they are **numerically identical**: every byte that is synced from source to target is both:
1. **Egress:** Read/transferred from the source (O365/IMAP)
2. **Storage:** Retained on the target (JMAP/IMAP-DAV)

Skipped/deduped items do not contribute to either (they're not transferred). Failed items don't contribute (no successful transfer). Therefore:

```
egress_bytes = storage_bytes = SUM(item.sizeBytes WHERE status IN ('copied', 'updated', 'skipped') AND lastSyncedAt IN period)
```

This is explicitly documented to avoid confusion — two billing dimensions, one underlying value.

---

## 2. Where Recorded: Hybrid Approach (Derive + Idempotent Upsert)

### The Hybrid Design (COMMITTED)

**Storage & Egress:** Derive-at-read from item ledger (perfect idempotency)  
**Compute & API calls:** Idempotent upsert from job runs (proactive, but retry-safe)

This is the **only** approach — not optional alternatives. Each metric type uses the mechanism that fits its data source.

---

### Storage/Egress: Derive-at-Read (From Item Ledger)

**Mechanism:** Usage is **never written proactively**. Computed on-demand when billing reads are requested.

**How it works (with CORRECT period filtering):**

```typescript
async function deriveStorageAndEgressForPeriod(
  db: PgDatabase,
  tenantId: TenantId,
  periodStart: string,  // e.g., "2026-07-01"
  periodEnd: string     // e.g., "2026-07-31"
): Promise<{ storageBytes: number; egressBytes: number }> {
  // CRITICAL: Filter items by lastSyncedAt to get PERIOD-SPECIFIC usage
  const result = await db.select({
    storageBytes: sql<number>`COALESCE(SUM(${item.sizeBytes}), 0)`,
  })
  .from(item)
  .where(
    and(
      eq(item.tenantId, tenantId),
      inArray(item.status, ['copied', 'updated', 'skipped']),
      // PERIOD FILTER: Only count items synced in this billing period
      gte(item.lastSyncedAt, new Date(periodStart)),
      lte(item.lastSyncedAt, new Date(periodEnd)),
    )
  );

  const storageBytes = Number(result[0]?.storageBytes ?? 0);
  
  // Egress = Storage (see Section 1 clarification)
  return {
    storageBytes,
    egressBytes: storageBytes,  // Numerically identical
  };
}
```

**Why derive-at-read for storage/egress:**
- ✅ Perfect idempotency — no writes to double-count
- ✅ Single source of truth — always reflects actual synced items
- ✅ Retry-safe — job retries update existing item rows, don't create new ones
- ✅ Period-accurate — `lastSyncedAt` filters to the correct billing period

**The Period Filtering Fix:**

The original design had a bug: it didn't filter items by `lastSyncedAt`, so it summed ALL items regardless of when they synced. **Fixed:** Use `lastSyncedAt` (which exists on the `item` table) to filter to the billing period.

---

### Compute & API Calls: Idempotent Upsert (From Migration Status)

**Why proactive recording is required:**

Compute (duration) and api_calls (count) **cannot be derived from the item ledger**. They come from `migration_status` which tracks:
- `startedAt` — when sync began
- `completedAt` — when sync finished
- State transitions (pending → in_progress → completed/failed)

These are **job-level metrics**, not item-level.

**Mechanism:** Idempotent upsert keyed by `(tenantId, periodStart, metricType, resource)` with `onConflictDoUpdate` that **replaces** values.

**Compute recording (at job completion):**

```typescript
async function recordComputeForRun(
  db: PgDatabase,
  tenantId: TenantId,
  mappingId: MappingId,
  domain: 'email' | 'calendar' | 'contact' | 'file',
  startedAt: Date,
  completedAt: Date,
  periodStart: string,
  periodEnd: string
) {
  const durationMinutes = (completedAt.getTime() - startedAt.getTime()) / (1000 * 60);
  
  await db.insert(usageMetric)
    .values({
      tenantId,
      periodStart,
      periodEnd,
      metricType: 'compute',
      resource: `domain-${domain}`,
      quantity: String(durationMinutes / 60), // Convert to hours
      unit: 'hours',
      unitPrice: pricing.computePricePerHour,
      totalCost: String(Math.round(durationMinutes / 60 * pricing.computePricePerHour)),
      metadata: { mappingId, domain, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString() },
    })
    .onConflictDoUpdate({
      target: [usageMetric.tenantId, usageMetric.periodStart, usageMetric.metricType, usageMetric.resource],
      set: {
        quantity: String(durationMinutes / 60),
        totalCost: String(Math.round(durationMinutes / 60 * pricing.computePricePerHour)),
        updatedAt: new Date(),
      },
    });
}
```

**API calls recording (at job completion):**

```typescript
async function recordApiCallForRun(
  db: PgDatabase,
  tenantId: TenantId,
  mappingId: MappingId,
  domain: 'email' | 'calendar' | 'contact' | 'file',
  periodStart: string,
  periodEnd: string
) {
  await db.insert(usageMetric)
    .values({
      tenantId,
      periodStart,
      periodEnd,
      metricType: 'api_calls',
      resource: `sync-${domain}`,
      quantity: '1',  // One sync operation
      unit: 'request',
      unitPrice: '0',  // Free for now
      totalCost: '0',
      metadata: { mappingId, domain },
    })
    .onConflictDoUpdate({
      target: [usageMetric.tenantId, usageMetric.periodStart, usageMetric.metricType, usageMetric.resource],
      set: {
        quantity: '1',  // Not increment — REPLACE (same run = same count)
        updatedAt: new Date(),
      },
    });
}
```

**Why idempotent upsert for compute/api_calls:**
- ✅ Retry-safe — same run ID → same values → no accumulation
- ✅ `onConflictDoUpdate` **replaces** rather than increments
- ✅ Job completion is the natural write point (we have startedAt/completedAt)
- ✅ Can't derive from item ledger (these are job-level, not item-level)

**Where it's called:**

Inside `run-delta-sync.ts` after successful sync, within `withTenant`:

```typescript
// After runShadowPass completes successfully
await withTenant(pool, tenantId, async (db) => {
  // Get migration status for startedAt/completedAt
  const status = await getMigrationStatus(db, tenantId, mappingId, domain);
  
  // Record compute (duration)
  await recordComputeForRun(
    db, tenantId, mappingId, domain,
    new Date(status.startedAt),
    new Date(status.completedAt!),
    periodStart, periodEnd
  );
  
  // Record api_call (count)
  await recordApiCallForRun(db, tenantId, mappingId, domain, periodStart, periodEnd);
});
```

---

### Why NOT Pure Derive-At-Read for All Metrics?

**Compute:** Would require aggregating `completedAt - startedAt` from `migration_status` for the period. This **is** derivable, but:
- More expensive (must scan all migration_status rows for the period)
- Less flexible (can't track per-run details)
- Unnecessary complexity when proactive recording is simple and retry-safe

**API calls:** Would require counting completed migrations per period. Same trade-offs as compute.

**Decision:** Use the simplest, most efficient mechanism for each metric type:
- Storage/egress → derive from item ledger (perfect idempotency, single source of truth)
- Compute/api_calls → idempotent upsert from job completion (simple, efficient, retry-safe)

---

## 3. Idempotency Mechanism

### Hybrid Approach (COMMITTED)

| Metric Type | Mechanism | Why Retry-Safe |
|-------------|-----------|----------------|
| **Storage** | Derive-at-read | No writes — computed from immutable item ledger |
| **Egress** | Derive-at-read | No writes — same as storage |
| **Compute** | Idempotent upsert | `onConflictDoUpdate` **replaces** values, keyed by `(tenantId, periodStart, metricType, resource)` |
| **API calls** | Idempotent upsert | `onConflictDoUpdate` **replaces** values, keyed by `(tenantId, periodStart, metricType, resource)` |

### Derive-at-Read (Storage/Egress)

**Mechanism:** Usage is **never written**. Computed on-demand from the item ledger.

**Retry safety:** Guaranteed — there's nothing to double-count because no usage rows are created by jobs.

### Idempotent Upsert (Compute/API calls)

**Mechanism:** Key by `(tenantId, periodStart, metricType, resource)` with `onConflictDoUpdate` that **replaces** values.

**Retry safety:** Guaranteed — same run/period/metric/resource → same values → no accumulation.

**Example:** If a job retries 3 times, `recordComputeForRun` is called 3 times, but the upsert ensures only one row exists with the final (correct) duration.

---

### What NOT to Do

- ❌ **Naive increment** on job completion (double-counts on every retry)
- ❌ **Separate parallel counters** (can drift from source of truth)
- ❌ **Writing usage outside `withTenant`** (breaks RLS)
- ❌ **Accepting `tenantId` from client input** (security risk)
- ❌ **Not filtering items by `lastSyncedAt`** (wrong period totals)

---

## 4. Security Invariant

### Same Guarantees as T1-T3

| Guarantee | Implementation |
|-----------|----------------|
| Tenant-scoped writes | All usage writes happen inside `withTenant(tenantId, ...)` |
| Authenticated context | `tenantId` comes from JWT payload (never client input) |
| RLS enforcement | `usage_metric` policies enforce `tenant_id = current_setting('app.current_tenant')` |
| Fail-closed | If `withTenant` fails, no usage is recorded (error propagates) |
| Cross-tenant isolation | Tenant B's usage invisible to Tenant A via RLS |

### Security Flow

```typescript
// In job (run-delta-sync.ts)
export const runDeltaSync = schemaTask({
  run: async (payload: unknown) => {
    const typedPayload = payload as DeltaSyncJobPayload;
    
    // SECURITY: Fail closed if tenantId missing
    if (!typedPayload.tenantId) {
      throw new Error('tenantId is required');
    }
    
    // Build deps inside tenant context
    const deps = await buildDepsFromMapping(pool, typedPayload.tenantId, typedPayload.mappingId);
    
    // Run shadow pass (writes to item ledger, RLS-enforced)
    const result = await runShadowPass(deps);
    
    // If using proactive recording:
    await withTenant(pool, typedPayload.tenantId, async (db) => {
      const usage = await deriveUsageFromLedger(db, typedPayload.tenantId, typedPayload.mappingId);
      await recordUsageForRun(db, typedPayload.tenantId, ...); // RLS-enforced
    });
  },
});
```

**Key points:**
- `tenantId` from authenticated payload (never client-supplied)
- All DB ops inside `withTenant()` → RLS enforced
- If RLS fails (no context set), queries error (fail-closed)

---

## 5. How Billing Reads It

### Current Billing Routes (T2 Complete)

**GET /api/billing/usage** already reads from `usage_metric`:

```typescript
const metrics = await withTenantDb(tenantId, getSharedPool(), async (db) => {
  return await db.select({
    metricType: schema.usageMetric.metricType,
    quantity: schema.usageMetric.quantity,
    // ...
  })
  .from(schema.usageMetric)
  .where(
    and(
      eq(schema.usageMetric.tenantId, tenantId),
      eq(schema.usageMetric.periodStart, periodStart),
    )
  );
});
```

### Required Changes

**Option A (Derive-at-Read):** Modify `GET /api/billing/usage` to derive from item ledger if no usage_metric rows exist:

```typescript
// In billing/index.ts
router.get('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenantId!;
  const periodStart = /* compute current period */;
  
  // Try to read from usage_metric first
  const metrics = await withTenantDb(tenantId, pool, async (db) => {
    return await db.select(/* ... */).from(usageMetric).where(/* ... */);
  });
  
  // If no metrics found, derive from item ledger
  if (metrics.length === 0) {
    const derivedUsage = await deriveUsageForPeriod(pool, tenantId, periodStart, periodEnd);
    return res.json({ usage: derivedUsage, currentCost: calculateCost(derivedUsage) });
  }
  
  // ... existing aggregation logic ...
});
```

**Option B (Proactive):** Keep billing routes unchanged; ensure jobs write usage rows proactively.

**Recommendation:** **Option A (Derive-at-Read)** — billing always reflects actual usage, even if metering hook fails.

---

## 6. Test Plan (Mandatory)

### Test Infrastructure

- **Testcontainers:** PostgreSQL with RLS enabled
- **Job invocation:** Call `runDeltaSync.run()` directly (no Trigger.dev infra)
- **Fixture isolation:** Unique ID namespace per test file (CI guard enforces)

### Test Cases

#### 1. Integration Test: Sync Job Produces Correct Usage

**Goal:** Verify that running a sync job results in correct usage metrics for ALL metric types.

```typescript
describe('Usage Metering - Integration', () => {
  it('should record correct usage after sync job', async () => {
    // Arrange
    const { pool, tenantId, mappingId } = await createTestTenant('t4-test-001');
    const periodStart = '2026-07-01';
    const periodEnd = '2026-07-31';

    // Act: Run sync job
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );

    // Assert: DERIVED metrics (storage/egress) from item ledger
    const derivedUsage = await deriveStorageAndEgressForPeriod(pool, tenantId, periodStart, periodEnd);
    
    // Verify against item ledger
    const itemCount = await countItems(pool, tenantId, mappingId, ['copied', 'updated', 'skipped']);
    const totalBytes = await sumItemBytes(pool, tenantId, mappingId);
    
    expect(derivedUsage.storageBytes).toBe(totalBytes);
    expect(derivedUsage.egressBytes).toBe(totalBytes); // Identical to storage

    // Assert: UPSERTED metrics (compute/api_calls) from usage_metric table
    const computeMetrics = await getUsageMetrics(pool, tenantId, periodStart, 'compute', 'domain-email');
    const apiMetrics = await getUsageMetrics(pool, tenantId, periodStart, 'api_calls', 'sync-email');
    
    expect(computeMetrics).toHaveLength(1);
    expect(apiMetrics).toHaveLength(1);
    
    // Verify compute duration matches migration_status
    const migration = await getMigrationStatus(pool, tenantId, mappingId, 'email');
    const expectedDurationHours = (new Date(migration.completedAt!).getTime() - 
                                   new Date(migration.startedAt).getTime()) / (1000 * 60 * 60);
    expect(Number(computeMetrics[0]!.quantity)).toBeCloseTo(expectedDurationHours, 2);
    
    // api_calls should be exactly 1 (not incremented on retry)
    expect(Number(apiMetrics[0]!.quantity)).toBe(1);
  });
});
```

#### 2. Idempotency Test: Retry Does Not Double-Count

**Goal:** Verify that re-running a sync or job retry does not inflate ANY usage metrics.

```typescript
describe('Usage Metering - Idempotency', () => {
  it('should not double-count on job retry for ALL metric types', async () => {
    // Arrange
    const { pool, tenantId, mappingId } = await createTestTenant('t4-test-002');
    const periodStart = '2026-07-01';
    const periodEnd = '2026-07-31';

    // Act: Run sync job twice (simulating retry)
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );

    // Assert: DERIVED metrics (storage/egress) — should NOT double-count
    const derivedUsage = await deriveStorageAndEgressForPeriod(pool, tenantId, periodStart, periodEnd);
    const expectedBytes = await sumItemBytes(pool, tenantId, mappingId);
    
    expect(derivedUsage.storageBytes).toBe(expectedBytes); // Not 2x
    expect(derivedUsage.egressBytes).toBe(expectedBytes);  // Not 2x

    // Assert: UPSERTED metrics (compute/api_calls) — should NOT double-count
    const computeMetrics = await getUsageMetrics(pool, tenantId, periodStart, 'compute', 'domain-email');
    const apiMetrics = await getUsageMetrics(pool, tenantId, periodStart, 'api_calls', 'sync-email');
    
    // Should have exactly one row each (upsert replaced, didn't accumulate)
    expect(computeMetrics).toHaveLength(1);
    expect(apiMetrics).toHaveLength(1);
    
    // Values should match the final run, not sum of both runs
    const migration = await getMigrationStatus(pool, tenantId, mappingId, 'email');
    const expectedDurationHours = (new Date(migration.completedAt!).getTime() - 
                                   new Date(migration.startedAt).getTime()) / (1000 * 60 * 60);
    expect(Number(computeMetrics[0]!.quantity)).toBeCloseTo(expectedDurationHours, 2);
    expect(Number(apiMetrics[0]!.quantity)).toBe(1); // Not 2
  });
});
```

#### 3. Cross-Tenant Isolation Test

**Goal:** Verify that Tenant B's usage is invisible to Tenant A.

```typescript
describe('Usage Metering - Cross-Tenant Isolation', () => {
  it('should not expose tenant B usage to tenant A', async () => {
    // Arrange
    const { pool, tenantId: tenantA } = await createTestTenant('t4-test-003a');
    const { pool, tenantId: tenantB } = await createTestTenant('t4-test-003b');
    
    // Both tenants run sync jobs
    await runDeltaSync.run({ tenantId: tenantA, mappingId: mappingA, domains: ['email'] }, mockContext);
    await runDeltaSync.run({ tenantId: tenantB, mappingId: mappingB, domains: ['email'] }, mockContext);
    
    // Act: Tenant A reads their usage (DERIVED)
    const usageA = await withTenantDb(tenantA, pool, async (db) => {
      return await deriveStorageAndEgressForPeriod(db, tenantA, currentPeriodStart, currentPeriodEnd);
    });
    
    // Assert: Tenant A sees only their own usage
    expect(usageA.storageBytes).toBeGreaterThan(0);
    
    // Verify Tenant B's usage is NOT visible via RLS
    const usageBFromA = await withTenantDb(tenantA, pool, async (db) => {
      return await db.select().from(usageMetric).where(eq(usageMetric.tenantId, tenantB));
    });
    
    expect(usageBFromA).toHaveLength(0); // RLS prevents cross-tenant access
    
    // Also verify compute/api_calls are isolated
    const computeBFromA = await withTenantDb(tenantA, pool, async (db) => {
      return await db.select().from(usageMetric)
        .where(and(eq(usageMetric.tenantId, tenantB), eq(usageMetric.metricType, 'compute')));
    });
    
    expect(computeBFromA).toHaveLength(0); // RLS enforced on upsert too
  });
});
```

#### 4. Period Filtering Test (Bug Fix Verification)

**Goal:** Verify that usage is correctly filtered by billing period.

```typescript
describe('Usage Metering - Period Filtering', () => {
  it('should only count items synced in the correct billing period', async () => {
    // Arrange
    const { pool, tenantId, mappingId } = await createTestTenant('t4-test-004');
    
    // Sync items in July
    await runDeltaSync.run({ tenantId, mappingId, domains: ['email'] }, mockContext);
    
    // Manually update some items to August (simulate next month's sync)
    await updateItemsToPeriod(pool, tenantId, mappingId, '2026-08-01');
    
    // Act: Query July usage
    const julyUsage = await deriveStorageAndEgressForPeriod(pool, tenantId, '2026-07-01', '2026-07-31');
    
    // Assert: Only July items counted
    const julyBytes = await sumItemBytesForPeriod(pool, tenantId, mappingId, '2026-07-01', '2026-07-31');
    expect(julyUsage.storageBytes).toBe(julyBytes);
    
    // Act: Query August usage
    const augustUsage = await deriveStorageAndEgressForPeriod(pool, tenantId, '2026-08-01', '2026-08-31');
    const augustBytes = await sumItemBytesForPeriod(pool, tenantId, mappingId, '2026-08-01', '2026-08-31');
    expect(augustUsage.storageBytes).toBe(augustBytes);
    
    // Verify totals don't overlap
    expect(julyUsage.storageBytes + augustUsage.storageBytes)
      .toBe(await sumItemBytes(pool, tenantId, mappingId));
  });
});
```

### Test Fixture Guidelines

- **Unique namespace:** Each test file uses a unique prefix (e.g., `t4-test-001`, `t4-test-002`)
- **CI guard:** Run `pnpm test:fixture-audit` before tests to confirm no UUID collisions
- **Cleanup:** Tests should clean up their fixtures (or use ephemeral Testcontainers)

---

## 7. Concrete Recommendations (COMMITTED DESIGN)

### The Hybrid Approach

**Storage & Egress:** Derive-at-read from item ledger  
**Compute & API calls:** Idempotent upsert from job completion

This is **THE** design — not alternatives to choose from. Each metric type uses the mechanism that fits its data source.

### Implementation Order

1. **Add period filtering to derive function** — Use `lastSyncedAt` to filter items by billing period
2. **Create `recordComputeForRun()` and `recordApiCallForRun()`** — Idempotent upsert functions
3. **Hook into job completion** — Call record functions inside `withTenant` after successful sync
4. **Update billing routes** — `GET /api/billing/usage` now returns both derived and upserted metrics
5. **Write integration tests** — All four test cases (integration, idempotency, cross-tenant, period filtering)

### Security Requirements (Same as T1-T3)

- All usage writes inside `withTenant(tenantId)`
- `tenantId` from authenticated JWT context (never client input)
- RLS-enforced cross-tenant isolation
- Fail-closed if context missing

### Test Requirements

- Integration test: Sync job produces correct usage for ALL metric types
- Idempotency test: Re-run/retry does NOT double-count (for BOTH derived and upserted metrics)
- Cross-tenant test: Tenant B's usage invisible to Tenant A
- Period filtering test: Only items synced in the correct period are counted
- Unique fixture ID namespace (CI guard enforces)
- Full test suite green before merge

---

## 8. Open Questions

1. **Compute metering:** How to accurately measure sync duration? (Job start/end timestamps?)
2. **Resource granularity:** Should we track per-domain usage or aggregate at tenant level?
3. **Historical tracking:** Do we need to preserve usage rows for past periods, or is derive-at-read sufficient?
4. **Billing period boundaries:** How to handle mid-period tenant creation/deletion?

---

## 9. Next Steps

1. **Owner review:** Approve/reject the derive-at-read approach
2. **Implementation:** Create PR with chosen approach + tests
3. **Verification:** Run full test suite, confirm idempotency and cross-tenant isolation
4. **Documentation:** Update `docs/workplans/0011-managed-edition-hardening.md` Status block

---

**This is a design proposal only. No implementation until owner approval.**
