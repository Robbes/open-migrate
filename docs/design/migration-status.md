# Durable Migration Status Tracking in the Ledger

> **Status**: Design Proposal — Awaiting Owner Approval  
> **Related**: Issue #36 (orchestrator removal), New tracking issue for implementation  
> **Author**: OpenHands agent (on behalf of the team)  
> **Date**: 2026-07-15

## Problem Statement

Currently, migration progress is tracked only in-memory as return values from the orchestrator (`runUnifiedSync`). This has several limitations:

1. **No survivability**: Worker restarts lose all progress state
2. **No queryability**: Cannot ask "where is user X in their migration?"
3. **No progress reporting**: UI cannot show real-time progress without re-scanning
4. **No audit trail**: Cannot review historical migration state

The ledger (Postgres/SQLite) already tracks per-item migration records and cursors. We need to add **per-mapping, per-domain status tracking** that survives restarts and is queryable at any time.

---

## Proposed Schema

### Table: `migration_status`

```sql
CREATE TABLE migration_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mapping_id UUID NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('mail', 'calendar', 'contact', 'file')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  items_synced INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  bytes_transferred BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  
  UNIQUE (tenant_id, mapping_id, domain)
);

CREATE INDEX idx_migration_status_tenant_mapping ON migration_status(tenant_id, mapping_id);
CREATE INDEX idx_migration_status_state ON migration_status(state);
```

### Fields Explanation

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Primary key, follows existing convention |
| `tenant_id` | UUID | FK to tenants table, cascade delete |
| `mapping_id` | UUID | The user/mapping being migrated |
| `domain` | TEXT | One of: `mail`, `calendar`, `contact`, `file` |
| `state` | TEXT | Enum: `pending` → `in_progress` → `completed`/`failed`/`skipped` |
| `items_synced` | INTEGER | Count of successfully synced items |
| `items_failed` | INTEGER | Count of failed items |
| `bytes_transferred` | BIGINT | Total bytes transferred |
| `started_at` | TIMESTAMPTZ | When sync started |
| `updated_at` | TIMESTAMPTZ | Last update timestamp |
| `completed_at` | TIMESTAMPTZ | When sync completed (nullable) |
| `last_error` | TEXT | Last error message (nullable) |

### Indexes

- **Unique constraint**: `(tenant_id, mapping_id, domain)` — one status row per mapping per domain
- **Tenant/mapping index**: Fast lookup for "where is user X?"
- **State index**: Fast lookup for "show me all failed migrations"

---

## Key Design Question: Derived vs Maintained Status

### Option A: DERIVED Status (Recommended)

**Approach**: Compute progress by querying existing per-item ledger records on demand.

**Query Example**:
```sql
SELECT 
  COUNT(*) as items_synced,
  SUM(CASE WHEN error IS NULL THEN 1 ELSE 0 END) as successful,
  SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) as failed,
  SUM(COALESCE(content_size, 0)) as bytes_transferred
FROM ledger_items
WHERE tenant_id = $1 AND mapping_id = $2 AND item_type = $3;
```

**Pros**:
- ✅ **Always consistent**: No risk of counters diverging from reality
- ✅ **Simpler writes**: Worker only writes item records, no status updates needed during sync
- ✅ **Rich queries**: Can drill down into which items failed, their errors, etc.
- ✅ **Single source of truth**: Ledger items are the ground truth

**Cons**:
- ❌ **Slower reads**: Must aggregate over all items for each status query
- ❌ **No historical snapshot**: Cannot see "what was the state at time X"

**Best for**: Low-frequency status checks (user opens UI occasionally), migration tool reads

---

### Option B: MAINTAINED Status

**Approach**: Worker updates running counters on the status row as it syncs.

**Update Pattern**:
```sql
-- At domain start
INSERT INTO migration_status (tenant_id, mapping_id, domain, state)
VALUES ($1, $2, $3, 'in_progress')
ON CONFLICT (tenant_id, mapping_id, domain) DO UPDATE
SET state = 'in_progress', updated_at = NOW();

-- Periodically during sync (every N items)
UPDATE migration_status
SET items_synced = items_synced + $1,
    bytes_transferred = bytes_transferred + $2,
    updated_at = NOW()
WHERE tenant_id = $3 AND mapping_id = $4 AND domain = $5;

-- At completion
UPDATE migration_status
SET state = 'completed',
    completed_at = NOW(),
    updated_at = NOW()
WHERE tenant_id = $1 AND mapping_id = $2 AND domain = $3;
```

**Pros**:
- ✅ **Fast reads**: Single row lookup, no aggregation
- ✅ **Historical snapshots**: Can track state changes over time
- ✅ **Progress reporting**: Real-time updates without re-querying all items

**Cons**:
- ❌ **Consistency risk**: Counters must stay in sync with actual item records
- ❌ **More complex writes**: Worker must update status row during sync
- ❌ **Race conditions**: Multiple workers could conflict on same status row

**Best for**: High-frequency status checks, real-time progress UI

---

## Recommendation: DERIVED Status (Option A)

**Reasoning**:

1. **Migration frequency**: Users check progress occasionally (not real-time dashboards)
2. **Existing infrastructure**: Per-item ledger records already exist and are authoritative
3. **Simplicity**: Fewer moving parts = fewer bugs
4. **Idempotency**: Re-running a sync doesn't require complex counter resets
5. **Query flexibility**: Can answer "show me all failed items" without extra joins

**Mitigation for read performance**:
- Add materialized view for frequent queries
- Cache status in Redis for UI polling (optional enhancement)
- Limit aggregation to recent migrations if needed

---

## Worker Update Lifecycle

### State Transitions

```
pending → in_progress → completed
                      → failed
                      → skipped
```

### Lifecycle Events

1. **Before sync starts**:
   - Create status row with `state = 'pending'` (or skip if domain disabled)
   - Transition to `in_progress`

2. **During sync**:
   - Items sync → ledger records written (status counters DERIVED)
   - Errors logged to item records (status `last_error` optional for last failure)

3. **At completion**:
   - Set `state = 'completed'`, `completed_at = NOW()`
   - OR set `state = 'failed'`, `last_error = '...'`
   - OR set `state = 'skipped'` if no items to sync

### Idempotency Rules

- **Re-running completed domain**: Either no-op or delta (respect user choice)
- **Crashed/partial run**: Leave `state = 'in_progress'` with `updated_at` timestamp
- **Recovery**: Next run sees `in_progress` and either resumes or restarts based on config

---

## Handling `items_total` for Delta Syncs

**Problem**: Delta syncs don't know total items upfront (only discover during `listSince`).

**Options**:

1. **Nullable**: `items_total INTEGER` — leave NULL for delta, set for full sync
2. **Best-effort**: Estimate from source folder sizes (inaccurate but helpful)
3. **Omit entirely**: Don't track total, only synced/failed

**Recommendation**: **Nullable** — set only when known (full sync with pre-scan), otherwise NULL. UI can show "N items synced" without percentage.

---

## Migration Sketch (SQL Only — NOT APPLIED)

```sql
-- packages/ledger/migrations/0004_migration_status.sql

CREATE TABLE migration_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mapping_id UUID NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('mail', 'calendar', 'contact', 'file')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'skipped')),
  items_synced INTEGER NOT NULL DEFAULT 0,
  items_failed INTEGER NOT NULL DEFAULT 0,
  bytes_transferred BIGINT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  
  UNIQUE (tenant_id, mapping_id, domain)
);

CREATE INDEX idx_migration_status_tenant_mapping ON migration_status(tenant_id, mapping_id);
CREATE INDEX idx_migration_status_state ON migration_status(state);
```

### Seeding Strategy

Status rows should be **created on-demand** when a domain sync starts:

```typescript
// Pseudo-code for worker orchestration
async function syncDomain(tenantId, mappingId, domain) {
  // 1. Create/refresh status row
  await db.migration_status.upsert({
    tenant_id: tenantId,
    mapping_id: mappingId,
    domain: domain,
    state: 'in_progress',
    started_at: NOW(),
  });

  // 2. Run domain-specific sync (mail shadow-pass, CalDAV, CardDAV, WebDAV)
  const result = await syncDomainSpecific(tenantId, mappingId, domain);

  // 3. Update status based on result
  await db.migration_status.update({
    where: { tenant_id, mapping_id, domain },
    data: {
      state: result.failed > 0 ? 'failed' : 'completed',
      completed_at: NOW(),
      last_error: result.failed > 0 ? result.errors[0] : null,
    },
  });
}
```

---

## Integration with Existing Patterns

### Matches Ledger Conventions

- ✅ UUID primary keys
- ✅ `tenant_id` FK with cascade delete
- ✅ `TIMESTAMPTZ` for all timestamps
- ✅ Drizzle enum for `state`
- ✅ Unique index on business key `(tenant_id, mapping_id, domain)`

### Matches Cutover State Pattern

The `cutover-state.ts` uses a similar state enum pattern:
```typescript
export type CutoverState = 'pending' | 'in_progress' | 'ready' | 'completed' | 'rolled_back';
```

Our migration status uses the same pattern:
```typescript
export type MigrationState = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
```

---

## Next Steps (After Owner Approval)

1. **Implement schema**:
   - Add Drizzle migration `0004_migration_status.sql`
   - Update `packages/ledger/src/schema-pg.ts` with new table model
   - Add TypeScript types in `packages/shared/src/ports.ts`

2. **Wire worker orchestration**:
   - Update domain sync functions to create/update status rows
   - Ensure idempotent status updates

3. **Add tests**:
   - Unit tests for status transitions
   - Integration tests for status persistence across restarts
   - Property tests for idempotency

4. **UI integration** (future):
   - Query status for progress bars
   - Show per-domain migration state

---

## Open Questions for Owner

1. **Derived vs Maintained**: Do you prefer the simpler DERIVED approach (recommended) or the faster-read MAINTAINED approach?

2. **Status granularity**: Should we track per-folder status in addition to per-domain? (Currently proposing per-domain only)

3. **Historical tracking**: Do we need to track state transitions over time (like a timeline), or is current state sufficient?

4. **Retry policy**: When a domain fails, should the status automatically reset to `pending` for retry, or stay `failed` until manually reset?

---

## References

- [Ledger schema](../packages/ledger/src/schema-pg.ts)
- [Cutover state pattern](../packages/core/src/cutover-state.ts)
- [Workplan 0007](../workplans/0007-multi-domain-sync-completion.md)
- ADR-0022: Stalwart integration decisions
