# Workplan 0011 T4 — Ground Truth Report

**Date:** 2026-07-19  
**Purpose:** Document the current state before designing T4 usage metering.  
**Scope:** Report only. No changes to code or data.

---

## A(a) — T4 Spec from Workplan 0011

> **From `docs/workplans/0011-managed-edition-hardening.md`, Task T4:**

### T4 — Usage metering from real runs

Define the §16 cost drivers as metrics (items synced, bytes transferred, run minutes, storage snapshot) and emit them from worker results into `usage_metric` (schema exists in `0002_multi_tenant_rls.sql`); idempotent per run (re-recording a run is a no-op — same discipline as the ledger).

**Acceptance:** integration — a sync run produces exactly-once metrics; re-run of the recorder is a no-op; metrics are RLS-scoped (T1 test extended).

---

## A(b) — usage_metric Table Schema

### Table Definition (from schema-pg.ts)

```typescript
export const usageMetric = pgTable(
  'usage_metric',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    periodStart: text('period_start').notNull(), // Using text for date
    periodEnd: text('period_end').notNull(),
    metricType: text('metric_type', {
      enum: ['storage', 'egress', 'compute', 'api_calls'],
    }).notNull(),
    resource: text('resource'),
    quantity: text('quantity').notNull(), // Using text for numeric
    unit: text('unit').notNull(),
    unitPrice: text('unit_price').notNull(),
    totalCost: text('total_cost').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_usage_tenant_period').on(t.tenantId, t.periodStart),
    index('ix_usage_period_type').on(t.periodStart, t.metricType),
    uniqueIndex('uk_usage_metric').on(t.tenantId, t.periodStart, t.metricType, t.resource),
  ],
);
```

### RLS Policies (from 0002_multi_tenant_rls.sql)

```sql
-- SELECT policies
CREATE POLICY tenant_isolation_select ON usage_metric
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT policies
CREATE POLICY tenant_isolation_insert ON usage_metric
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- UPDATE policies
CREATE POLICY tenant_isolation_update ON usage_metric
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- DELETE policies
CREATE POLICY tenant_isolation_delete ON usage_metric
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

### What a Row Represents

A single row represents **one metric type for one tenant during one billing period**. The unique constraint `(tenant_id, period_start, metric_type, resource)` ensures one row per metric type per period per resource.

- **tenant_id:** The tenant accruing this usage
- **period_start/period_end:** Billing period boundaries (e.g., 2026-07-01 to 2026-07-31)
- **metric_type:** One of `storage`, `egress`, `compute`, `api_calls`
- **resource:** Optional qualifier (e.g., 'mailbox', 'calendar', 'sync')
- **quantity:** The raw amount consumed (stored as text)
- **unit:** Unit of measurement (e.g., 'GB', 'GB-egress', 'hours', 'requests')
- **unit_price:** Cost per unit (cost-recovery pricing)
- **total_cost:** Calculated cost (quantity × unit_price)
- **metadata:** Additional context (e.g., breakdown by mapping)

---

## A(c) — Billing Routes Status

### Current State (from `apps/api/src/routes/billing/index.ts`)

The billing routes are **wired to real persistence** (T2 complete), but **nothing is WRITING usage rows from actual migration runs yet**.

#### GET /api/billing/usage

Reads usage_metric rows for the current period:

```typescript
const metrics = await withTenantDb(tenantId, getSharedPool(), async (db) => {
  return await db.select({
    metricType: schema.usageMetric.metricType,
    quantity: schema.usageMetric.quantity,
    unit: schema.usageMetric.unit,
    totalCost: schema.usageMetric.totalCost,
    resource: schema.usageMetric.resource,
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

**Returns:** Aggregates metrics by type into `{ storageUsedGB, egressGB, computeHours, syncCount }`.

**Issue:** Currently returns zeros unless someone manually POSTs usage data.

#### POST /api/billing/usage

Accepts manual usage recording:

```typescript
router.post('/usage', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  // ... validation ...
  await withTenantDb(tenantId, getSharedPool(), async (db: PgDatabase) => {
    // Storage metric
    await db.insert(schema.usageMetric)
      .values({
        tenantId,
        periodStart,
        periodEnd,
        metricType: 'storage',
        resource: 'storage',
        quantity: String(body.storageUsedGB),
        unit: 'GB',
        unitPrice: String(defaultPricing.storagePricePerGB),
        totalCost: String(storageCost),
        metadata: {},
      })
      .onConflictDoUpdate({
        target: [schema.usageMetric.tenantId, schema.usageMetric.periodStart, schema.usageMetric.metricType, schema.usageMetric.resource],
        set: {
          quantity: String(body.storageUsedGB),
          totalCost: String(storageCost),
          updatedAt: new Date(),
        },
      });
    // ... similar for egress, compute, api_calls ...
  });
});
```

**Status:** This endpoint exists and uses `onConflictDoUpdate` for idempotency, but **no job or worker calls it**. Usage rows must be created manually or via a new metering hook.

#### Other Routes

- GET /api/billing/usage/history — Aggregates by period (reads only)
- POST /api/billing/estimate — Pure calculation, no DB
- GET/POST /api/billing/invoices — Invoice management (uses usage_metric data)
- GET/PATCH/POST /api/billing/payment-methods — Mollie integration

**Summary:** Billing routes can read/write usage_metric, but **no automated metering exists**. The worker jobs don't emit usage data.

---

## A(d) — Source of Truth for Real Activity

### migration_status Table

Tracks sync state per tenant/mapping/domain:

```typescript
export const migrationStatus = pgTable(
  'migration_status',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').notNull().references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    state: text('state', {
      enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
    }).notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (t) => [
    uniqueIndex('uk_migration_status_tenant_mapping_domain').on(t.tenantId, t.mappingId, t.domain),
    index('ix_migration_status_tenant_mapping').on(t.tenantId, t.mappingId),
    index('ix_migration_status_state').on(t.state),
  ],
);
```

### item Table (The Ledger)

The actual idempotent record of every synced item:

```typescript
export const item = pgTable(
  'item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').notNull().references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection').notNull(),
    naturalKey: text('natural_key').notNull(),
    naturalKeyHash: text('natural_key_hash').notNull(),
    contentHash: text('content_hash'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    sourceRef: jsonb('source_ref').notNull().default({}),
    targetRef: jsonb('target_ref').notNull().default({}),
    status: text('status', {
      enum: ['pending', 'copied', 'updated', 'skipped', 'failed', 'deleted_source', 'tombstoned'],
    }).notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_item_tenant_mapping_natural_key_hash').on(t.tenantId, t.mappingId, t.naturalKeyHash),
    index('ix_item_status').on(t.tenantId, t.mappingId, t.status),
    index('ix_item_collection').on(t.tenantId, t.mappingId, t.domain, t.collection),
    index('ix_item_content').on(t.contentHash),
  ],
);
```

### Derived-Count Query (from `migration-status-store.ts`)

This is the **source of truth** for usage metrics — counts and bytes are DERIVED from item records:

```typescript
const rows = await this.db
  .select({
    status: schemaPg.migrationStatus,
    itemsSynced: sql<number>`COUNT(CASE WHEN ${schemaPg.item.status} IN ('copied', 'updated', 'skipped') THEN 1 END)`,
    itemsFailed: sql<number>`COUNT(CASE WHEN ${schemaPg.item.status} = 'failed' THEN 1 END)`,
    bytesTransferred: sql<number | null>`COALESCE(SUM(CASE WHEN ${schemaPg.item.status} IN ('copied', 'updated', 'skipped') THEN ${schemaPg.item.sizeBytes} ELSE 0 END), 0)`,
  })
  .from(schemaPg.migrationStatus)
  .leftJoin(
    schemaPg.item,
    and(
      eq(schemaPg.item.tenantId, schemaPg.migrationStatus.tenantId),
      eq(schemaPg.item.mappingId, schemaPg.migrationStatus.mappingId),
      eq(schemaPg.item.domain, schemaPg.migrationStatus.domain),
    ),
  )
  .where(
    and(
      eq(schemaPg.migrationStatus.tenantId, tenantId),
      eq(schemaPg.migrationStatus.mappingId, mappingId),
    ),
  )
  .groupBy(
    schemaPg.migrationStatus.id,
    schemaPg.migrationStatus.tenantId,
    schemaPg.migrationStatus.mappingId,
    schemaPg.migrationStatus.domain,
    schemaPg.migrationStatus.state,
    schemaPg.migrationStatus.startedAt,
    schemaPg.migrationStatus.updatedAt,
    schemaPg.migrationStatus.completedAt,
    schemaPg.migrationStatus.lastError,
  )
  .orderBy(schemaPg.migrationStatus.domain);
```

**Key Points:**
- `itemsSynced`: Count of items with status `copied`, `updated`, or `skipped`
- `itemsFailed`: Count of items with status `failed`
- `bytesTransferred`: Sum of `sizeBytes` for successfully synced items
- **Derived at query time** from the immutable item ledger — no separate counters that can drift

---

## A(e) — T3 Sync Jobs and Metering Hooks

### Job Lifecycle (from `run-delta-sync.ts` and `build-deps-from-mapping.ts`)

1. **Trigger:** Trigger.dev schedules or triggers `runDeltaSync`
2. **Payload:** `{ tenantId, mappingId, domains? }`
3. **Build Deps:** `buildDepsFromMapping(pool, tenantId, mappingId)`
   - Loads connections from DB (RLS-enforced via `withTenant`)
   - Decrypts credentials
   - Creates `PgLedger`, `PgCursorStore`, connectors
4. **Run Shadow Pass:** `runShadowPass(deps)`
   - Reads source (IMAP/Graph)
   - Writes to target (JMAP/IMAP-DAV)
   - Updates item ledger with per-item status
5. **Status Update:** `migration_status` updated within `buildDepsFromMapping`'s tenant context
6. **Completion:** Job returns `{ success, tenantId, mappingId }`

### Where Usage Could Be Recorded

**Option 1: At Job Completion (in `run-delta-sync.ts`)**

```typescript
// After runShadowPass completes
const usage = await deriveUsageFromLedger(tenantId, mappingId, domains);
await recordUsage(tenantId, period, usage);
```

**Option 2: Per-Domain (inside the loop)**

```typescript
for (const domain of domains) {
  // ... run sync ...
  const domainUsage = await deriveUsageForDomain(tenantId, mappingId, domain);
  await recordUsage(tenantId, period, domainUsage);
}
```

**Option 3: Derive-at-Read (preferred for idempotency)**

No writes during job completion. Instead, billing reads derive usage directly from item records when needed:

```typescript
// In billing route
const usage = await deriveUsageFromLedgerForPeriod(tenantId, periodStart, periodEnd);
```

**Critical Constraint:** Trigger.dev jobs **retry on failure**. Any naive "increment on completion" will double-count on retries. The solution must be:
- **Derive-at-read:** Compute usage from item ledger at billing-read time (nothing to double-count)
- **OR idempotent upsert:** Key by `(tenantId, periodStart, metricType, resource)` with `onConflictDoUpdate` that replaces rather than increments

---

## Summary

| Aspect | Current State |
|--------|---------------|
| T4 Spec | Define metrics, emit from worker, idempotent per run |
| usage_metric table | Exists with RLS, schema ready |
| Billing routes | Wired to real persistence, but no automated writes |
| Source of truth | `item` ledger + `migration_status` (counts derived at query time) |
| Sync jobs | Run inside `withTenant`, update `migration_status`, but don't emit usage |
| Idempotency risk | Job retries would double-count naive increments |

**Blocker:** No automated metering exists. Usage must be derived from the item ledger or recorded via an idempotent mechanism keyed by run/mapping+period.

**Next:** Design proposal for T4 implementation (Part B).
