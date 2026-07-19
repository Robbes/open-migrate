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
- **Compute:** Worker time for sync operations (hours)
- **API calls:** Number of sync operations (count)

**Pricing:** Cost-recovery (flat base + pass-through, no margin)

### Metering Granularity

**Per tenant, per billing period, per metric type:**

| Metric | Granularity | Source |
|--------|-------------|--------|
| `storage` | Per tenant, monthly | Sum of `item.sizeBytes` for all synced items (status: copied/updated/skipped) |
| `egress` | Per tenant, monthly | Same as storage (data read from source = data written to target) |
| `compute` | Per tenant, monthly | Sync duration (minutes/hours) from job run times |
| `api_calls` | Per tenant, monthly | Count of sync jobs run |

**Resource qualifier:** Optional breakdown by domain (`email`, `calendar`, `contact`, `file`) or mapping.

**Why this granularity:**
- Matches the billing model (cost-recovery per §16)
- Aligns with `usage_metric` schema (unique constraint: `tenant_id, period_start, metric_type, resource`)
- Supports itemization on invoices (storage vs egress vs compute)

---

## 2. Where Recorded: Derive-from-Ledger Approach

### Recommended: Derive-at-Read (Preferred)

**Mechanism:** Never write usage rows proactively. Instead, **compute usage on-demand** when billing reads are requested, deriving directly from the item ledger.

**How it works:**

```typescript
// In billing service (new function)
async function deriveUsageForPeriod(
  db: PgDatabase,
  tenantId: TenantId,
  periodStart: string,
  periodEnd: string
): Promise<UsageMetrics> {
  // Get all completed migrations for this tenant
  const migrations = await db.select({
    mappingId: migrationStatus.mappingId,
    domain: migrationStatus.domain,
  })
  .from(migrationStatus)
  .where(
    and(
      eq(migrationStatus.tenantId, tenantId),
      eq(migrationStatus.state, 'completed')
    )
  );

  // Aggregate from item ledger
  const usage = await db.select({
    metricType: sql<'storage' | 'egress' | 'compute'>`'storage'`,
    quantity: sql<number>`COALESCE(SUM(${item.sizeBytes}), 0)`,
    unit: sql<'GB'>`'GB'`,
  })
  .from(item)
  .where(
    and(
      eq(item.tenantId, tenantId),
      inArray(
        sql`${item.mappingId}`,
        migrations.map(m => m.mappingId)
      ),
      eq(item.status, 'copied') // or 'updated', 'skipped'
    )
  )
  .groupBy(item.tenantId);

  return usage;
}
```

**Why derive-at-read:**
- **Idempotent by design:** No writes to worry about — usage is computed from the immutable ledger
- **Retry-safe:** Job retries don't create duplicate records (they update existing item rows)
- **Single source of truth:** Billing always reflects actual synced items
- **No drift:** Can't diverge from migration_status/item records

### Alternative: Idempotent Upsert (If Proactive Recording Required)

If proactive recording is preferred (e.g., for historical tracking), use **idempotent upsert keyed by run/mapping+period**:

```typescript
async function recordUsageForRun(
  db: PgDatabase,
  tenantId: TenantId,
  mappingId: MappingId,
  periodStart: string,
  periodEnd: string,
  usage: { storageBytes: number; egressBytes: number; computeMinutes: number }
) {
  // Storage metric (idempotent upsert)
  await db.insert(usageMetric)
    .values({
      tenantId,
      periodStart,
      periodEnd,
      metricType: 'storage',
      resource: `mapping-${mappingId}`,
      quantity: String(usage.storageBytes / (1024 ** 3)), // Convert to GB
      unit: 'GB',
      unitPrice: pricing.storagePricePerGB,
      totalCost: String(calculateStorageCost(usage.storageBytes)),
      metadata: { mappingId, derivedFrom: 'item_ledger' },
    })
    .onConflictDoUpdate({
      target: [usageMetric.tenantId, usageMetric.periodStart, usageMetric.metricType, usageMetric.resource],
      set: {
        quantity: String(usage.storageBytes / (1024 ** 3)),
        totalCost: String(calculateStorageCost(usage.storageBytes)),
        updatedAt: new Date(),
      },
    });

  // Similar for egress, compute...
}
```

**Why this is retry-safe:**
- Unique constraint: `(tenantId, periodStart, metricType, resource)`
- `onConflictDoUpdate` **replaces** rather than increments
- Re-running the same sync with the same period → same values → no change

**Rejected: Naive Increment**

```typescript
// ❌ WRONG — double-counts on every retry
await db.insert(usageMetric)
  .values({
    tenantId,
    metricType: 'storage',
    quantity: String(syncedBytes),
    // ...
  });
```

**Why rejected:** Every job retry creates a new row or increments, leading to inflated usage.

---

## 3. Idempotency Mechanism

### Derive-at-Read (Strongly Preferred)

**Mechanism:** Usage is **never written**. It's computed on-demand from the item ledger.

**Retry safety:** Guaranteed — there's nothing to double-count because no usage rows are created by jobs.

**Trade-offs:**
- **Pros:** Perfect idempotency, no drift, single source of truth
- **Cons:** Slightly slower billing reads (must aggregate from item ledger)

### Idempotent Upsert (If Needed)

**Mechanism:** Key by `(tenantId, periodStart, metricType, resource)` with `onConflictDoUpdate` that **replaces** values.

**Retry safety:** Guaranteed — same run/mapping+period → same values → no accumulation.

**Trade-offs:**
- **Pros:** Faster billing reads (pre-computed), historical tracking
- **Cons:** More complex, must ensure correct keying

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

**Goal:** Verify that running a sync job results in correct usage metrics.

```typescript
describe('Usage Metering - Integration', () => {
  it('should record correct usage after sync job', async () => {
    // Arrange
    const { pool, tenantId, mappingId } = await createTestTenant('t4-test-001');
    
    // Act: Run sync job
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );
    
    // Assert: Derive usage from ledger
    const usage = await deriveUsageForPeriod(pool, tenantId, currentPeriodStart, currentPeriodEnd);
    
    expect(usage.storageUsedGB).toBeGreaterThan(0);
    expect(usage.syncCount).toBeGreaterThan(0);
    
    // Verify against item ledger
    const itemCount = await countItems(pool, tenantId, mappingId, ['copied', 'updated', 'skipped']);
    const totalBytes = await sumItemBytes(pool, tenantId, mappingId);
    
    expect(usage.syncCount).toBe(itemCount);
    expect(usage.storageUsedGB * 1024 ** 3).toBeCloseTo(totalBytes, -2); // Within 1%
  });
});
```

#### 2. Idempotency Test: Retry Does Not Double-Count

**Goal:** Verify that re-running a sync or job retry does not inflate usage.

```typescript
describe('Usage Metering - Idempotency', () => {
  it('should not double-count on job retry', async () => {
    // Arrange
    const { pool, tenantId, mappingId } = await createTestTenant('t4-test-002');
    
    // Act: Run sync job twice (simulating retry)
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );
    await runDeltaSync.run(
      { tenantId, mappingId, domains: ['email'] },
      mockContext
    );
    
    // Assert: Usage reflects actual items, not double-counted
    const usage = await deriveUsageForPeriod(pool, tenantId, currentPeriodStart, currentPeriodEnd);
    
    // Verify against item ledger (should be same as single run)
    const itemCount = await countItems(pool, tenantId, mappingId, ['copied', 'updated', 'skipped']);
    const totalBytes = await sumItemBytes(pool, tenantId, mappingId);
    
    expect(usage.syncCount).toBe(itemCount); // Not 2x
    expect(usage.storageUsedGB * 1024 ** 3).toBeCloseTo(totalBytes, -2);
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
    
    // Act: Tenant A reads their usage
    const usageA = await withTenantDb(tenantA, pool, async (db) => {
      return await db.select().from(usageMetric).where(eq(usageMetric.tenantId, tenantA));
    });
    
    // Assert: Tenant A sees only their own usage
    expect(usageA.length).toBeGreaterThan(0);
    
    // Verify Tenant B's usage is NOT visible
    const usageBFromA = await withTenantDb(tenantA, pool, async (db) => {
      return await db.select().from(usageMetric).where(eq(usageMetric.tenantId, tenantB));
    });
    
    expect(usageBFromA).toHaveLength(0); // RLS prevents cross-tenant access
  });
});
```

### Test Fixture Guidelines

- **Unique namespace:** Each test file uses a unique prefix (e.g., `t4-test-001`, `t4-test-002`)
- **CI guard:** Run `pnpm test:fixture-audit` before tests to confirm no UUID collisions
- **Cleanup:** Tests should clean up their fixtures (or use ephemeral Testcontainers)

---

## 7. Concrete Recommendations

### Primary Recommendation: Derive-at-Read

**Why:**
- Perfect idempotency (no writes to double-count)
- Single source of truth (billing always matches ledger)
- Simpler implementation (no job-side metering logic)
- Retry-safe by design

**Implementation:**
1. Add `deriveUsageForPeriod()` function to billing service
2. Modify `GET /api/billing/usage` to derive from ledger if no usage_metric rows
3. Keep `POST /api/billing/usage` for manual overrides (if needed)

### Alternative: Idempotent Upsert

**If proactive recording is required:**
1. Add `recordUsageForRun()` function that uses `onConflictDoUpdate`
2. Call from job completion (inside `withTenant`)
3. Key by `(tenantId, periodStart, metricType, resource)`

### What NOT to Do

- ❌ Naive increment on job completion (double-counts on retry)
- ❌ Separate parallel counters (can drift from ledger)
- ❌ Writing usage outside `withTenant` (breaks RLS)
- ❌ Accepting `tenantId` from client input (security risk)

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
