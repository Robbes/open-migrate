# Design Proposal: 0011-T2 — API Routes Real Persistence

**Date:** 2026-07-17  
**Workplan:** 0011 (Managed Edition Hardening)  
**Task:** T2 — API routes: real persistence  
**Status:** Design proposal awaiting owner review

---

## What This Task Delivers

Replace the TODO shell handlers in `apps/api/src/routes/` with real Drizzle queries through `withTenantDb`, providing actual persistence for:

1. **Tenant CRUD** (POST, PUT, DELETE `/api/tenants`)
2. **Mappings CRUD** (all `/api/mappings/*` routes)
3. **Members management** (all `/api/tenants/:tenantId/members/*` routes)
4. **Migration runs** (GET `/api/mappings/:mappingId/runs` and `/runs/:runId`)

**Why this is next:** Per workplan 0011 ordering, T2 follows T1. T1 established the RLS enforcement foundation (`withTenant`, `app_user` role, cross-tenant tests). T2 builds on that by wiring the API to the real ledger, making the tenant routes functional and testable end-to-end.

---

## Security-Critical Invariants

Every change must preserve these invariants:

1. **Every tenant-data path stays behind `authenticate` + `withTenantDb`**
   - No direct DB access — all queries must go through the `withTenantDb` wrapper
   - The `app.current_tenant` GUC must be set for every transaction that touches tenant-scoped tables

2. **Fail-closed on missing context**
   - If `req.tenantId` is undefined, return 401 error (not empty result)
   - `withTenantDb` must throw if tenantId is missing or empty string

3. **No cross-tenant leakage**
   - RLS policies filter based on `current_setting('app.current_tenant')`
   - Cross-tenant INSERT/UPDATE/DELETE must fail at the DB level
   - API-level tenant ID validation (`requireTenantMatch`) is defense-in-depth but NOT the primary enforcement

4. **Role enforcement remains intact**
   - `requireRole` middleware stays on admin/operator endpoints
   - Role checks happen BEFORE any DB access

5. **No `as any`, no `ts-ignore`, no weakened assertions**
   - Type safety must be maintained through the entire stack
   - Use zod for runtime validation, Drizzle for type-safe queries

---

## Design

### Architecture

Mirror existing patterns — do not invent parallel mechanisms:

```
Express route → zod validation → withTenantDb → Drizzle query → response
                (input)          (RLS context)  (type-safe)    (JSON)
```

### Key Components

**1. Reuse existing `withTenantDb` wrapper**

From `apps/api/src/middleware/auth.ts`:
```typescript
export function withTenantDb<T>(
  tenantId: string,
  pool: Pool,
  fn: (db: PgDatabase) => Promise<T>
): Promise<T> {
  return ledgerWithTenant(pool, tenantId, fn);
}
```

**2. Use Drizzle query builder for type safety**

From `packages/ledger/src/db/schema.ts`:
```typescript
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '@openmig/ledger';

// Example: list mappings for current tenant
const mappings = await withTenantDb(tenantId, pool, async (db) => {
  return await db.select({
    id: schema.mapping.id,
    name: schema.mapping.name,
    sourceType: schema.mapping.sourceType,
    targetType: schema.mapping.targetType,
    status: schema.mapping.status,
    createdAt: schema.mapping.createdAt,
  })
  .from(schema.mapping)
  .where(eq(schema.mapping.tenantId, tenantId))
  .orderBy(desc(schema.mapping.createdAt));
});
```

**3. Schema validation with zod**

Reuse existing schemas from `apps/api/src/types/api.ts` and extend as needed. Validate all request bodies and URL parameters before DB access.

**4. Error handling pattern**

```typescript
try {
  const result = await withTenantDb(tenantId, pool, async (db) => {
    // Drizzle query here
  });
  res.json(result);
} catch (error) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: 'Validation error', details: error.errors });
  } else if (error instanceof PostgresError) {
    // Handle constraint violations, foreign key errors, etc.
    res.status(409).json({ error: 'Database error', message: error.message });
  } else {
    console.error('Unexpected error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

### File-by-File Changes

**`apps/api/src/routes/tenants/index.ts`**
- Replace POST `/api/tenants` TODO with `db.insert(schema.tenant).values(...).returning()`
- Replace PUT `/api/tenants/:id` TODO with `db.update(schema.tenant).set(...).where(eq(schema.tenant.id, tenantId))`
- Replace DELETE `/api/tenants/:id` TODO with `db.delete(schema.tenant).where(eq(schema.tenant.id, tenantId))`
- All wrapped in `withTenantDb`

**`apps/api/src/routes/migrations/index.ts`**
- Replace all GET/POST/PUT/DELETE handlers with real Drizzle queries
- POST `/api/mappings/:id/sync` should call Trigger.dev client (see dependency section below)
- GET `/api/mappings/:id/runs` should query `schema.run` table with RLS
- GET `/api/mappings/:id/runs/:runId` should join `schema.run` with `schema.run_event`

**`apps/api/src/routes/tenants/members.ts`**
- Replace all handlers with real Drizzle queries on `schema.tenant_member`
- Add check to prevent removing the last owner (query owner count first)

**`apps/api/src/routes/billing/index.ts`**
- Replace in-memory `billingApi` with Drizzle queries to `schema.usage_metric`, `schema.invoice`, `schema.payment_method`
- This is CRITICAL — billing currently bypasses RLS entirely

---

## Test Plan

### Required Tests

**1. Unit tests for each route** (vitest + supertest)

For each CRUD operation:
- Happy path: valid request → correct DB mutation → 2xx response
- Validation errors: invalid input → 400 response
- Auth errors: missing/invalid token → 401 response
- Role errors: insufficient permissions → 403 response

**2. Cross-tenant isolation tests (MANDATORY)**

For EVERY route that touches tenant data, add a test proving tenant B cannot access tenant A's data:

```typescript
it('should prevent tenant B from accessing tenant A mappings', async () => {
  // Setup: create mapping for tenant A
  await createTestMapping(API_TENANT_A, 'mapping-a');
  
  // Try to list mappings as tenant B
  const response = await request
    .get('/api/mappings')
    .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);
  
  // Should return empty list (RLS filters out tenant A's data)
  expect(response.status).toBe(200);
  expect(response.body.mappings).toEqual([]);
});

it('should prevent tenant B from reading tenant A mapping details', async () => {
  const mappingAId = await createTestMapping(API_TENANT_A, 'mapping-a');
  
  const response = await request
    .get(`/api/mappings/${mappingAId}`)
    .set('Authorization', `Bearer ${TOKEN_TENANT_B}`);
  
  // Either 404 or 200 with empty/not-found response
  expect(response.status).toBe(404); // or 200 with appropriate handling
});
```

**3. Integration tests with Testcontainers**

- Use the same Testcontainers PostgreSQL setup as `tenants.integration.test.ts`
- Seed test data with known tenant IDs (use UUID family `950e8400-e29b-41d4-a716-44665544xxxx`)
- Test full request flow: JWT → auth middleware → withTenantDb → Drizzle → RLS → response

**4. Cross-tenant write attempts**

Test that cross-tenant INSERT/UPDATE/DELETE fails at the DB level:

```typescript
it('should prevent cross-tenant INSERT', async () => {
  const response = await request
    .post('/api/mappings')
    .set('Authorization', `Bearer ${TOKEN_TENANT_B}`)
    .send({
      name: 'Hacker Mapping',
      sourceType: 'imap',
      targetType: 'jmap',
      sourceConfig: { host: 'hacker.com', port: 993, username: 'hacker' },
      targetConfig: { host: 'target.com', port: 443, username: 'victim', password: 'secret' },
      syncConfig: { domains: ['email'] },
    });
  
  // Should fail due to RLS or constraint violation
  expect(response.status).toBe(400); // or 403/409
  expect(response.body.error).toContain('violates'); // or similar
});
```

### Test Files to Create

- `apps/api/src/routes/mappings/mappings.integration.test.ts`
- `apps/api/src/routes/tenants/members.integration.test.ts`
- `apps/api/src/routes/billing/billing.integration.test.ts`
- Update `apps/api/src/routes/tenants/tenants.integration.test.ts` to include POST/PUT/DELETE tests

---

## Dependency on Migration Engine

### Trigger.dev Integration (for POST /api/mappings/:id/sync)

The sync trigger route needs to call the real Trigger.dev jobs. Design:

**1. Create Trigger.dev client instance**

```typescript
// apps/api/src/services/trigger-client.ts
import { TriggerClient } from '@trigger.dev/sdk/v3';

export const triggerClient = new TriggerClient({
  id: 'openmigrate-api',
  apiKey: process.env.TRIGGER_DEV_API_KEY,
  apiUrl: process.env.TRIGGER_DEV_API_URL,
});
```

**2. Trigger jobs from API**

```typescript
// In routes/migrations/index.ts
import { triggerClient } from '../../services/trigger-client';

router.post('/:mappingId/sync', authenticate, async (req, res) => {
  const tenantId = req.tenantId!;
  const mappingId = req.params.mappingId;
  const body = TriggerSyncSchema.parse(req.body);
  
  const job = body.type === 'full' ? 'run-full-sync' : 'run-delta-sync';
  
  const run = await triggerClient.trigger({
    job,
    payload: {
      tenantId,
      mappingId,
      ...(body.type === 'full' && { forceFullScan: body.forceFullScan }),
    },
  });
  
  res.json({
    success: true,
    runId: run.id,
    jobType: body.type,
    triggeredAt: new Date().toISOString(),
  });
});
```

**3. No duplication of logic**

- API does NOT run the sync — it triggers the worker job
- Worker job (`apps/worker/src/jobs/run-delta-sync.ts`) calls `runShadowPass`
- API only orchestrates; worker does the actual migration work

### Migration Status Read

For GET `/api/mappings/:id/runs/:runId`:

```typescript
import { createPgDb, PgMigrationStatusStore } from '@openmig/ledger';

const statusStore = new PgMigrationStatusStore(pool);
const status = await statusStore.getDomainStatus(tenantId, mappingId, domain);

// Or query run table directly with Drizzle
const runs = await withTenantDb(tenantId, pool, async (db) => {
  return await db.select({
    id: schema.run.id,
    status: schema.run.status,
    startedAt: schema.run.startedAt,
    finishedAt: schema.run.finishedAt,
    itemsProcessed: schema.run.itemsProcessed,
  })
  .from(schema.run)
  .where(eq(schema.run.mappingId, mappingId))
  .orderBy(desc(schema.run.createdAt))
  .limit(50);
});
```

---

## Security Considerations

### Input Validation

- All user input must be zod-validated before DB access
- UUIDs must be validated as proper UUID format
- No raw SQL — only Drizzle query builder

### Error Messages

- Never expose internal error details in responses
- Log full errors server-side, return generic messages to client
- SQL errors should be caught and re-mapped to safe HTTP responses

### Rate Limiting

- Consider adding rate limiting to sync trigger endpoints
- Prevent abuse of `/api/mappings/:id/sync` with rapid-fire requests

### Audit Logging

- Log all tenant data access (who, what, when)
- Log all sync/cutover triggers for audit trail

---

## Acceptance Criteria

**Functional:**
- [ ] All tenant CRUD routes work with real persistence
- [ ] All mappings CRUD routes work with real persistence
- [ ] All members management routes work with real persistence
- [ ] Sync/cutover triggers actually call Trigger.dev jobs
- [ ] Migration runs are queryable via the API

**Security:**
- [ ] Cross-tenant access blocked for ALL new routes (proven by tests)
- [ ] All routes use `withTenantDb` — no direct pool access
- [ ] Role enforcement works correctly (admin/operator checks)
- [ ] Fail-closed behavior when tenant context missing

**Quality:**
- [ ] No `as any` or `ts-ignore` in new code
- [ ] All new routes have integration tests
- [ ] All gates green: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:integration`
- [ ] Code follows existing patterns (no parallel mechanisms)

---

## Out of Scope (for this task)

- Managed auth path implementation (Auth0/Clerk verification) — this is a separate security concern
- Real connector implementations (IMAP/JMAP) — worker jobs still use null connectors
- Usage metering emission — T4 task
- Billing/Mollie webhook handling — T5 task
- Web UI wiring — T6 task

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| RLS bypass due to direct pool access | HIGH | Enforce via ESLint rule: no direct `pool.query()` — only `withTenantDb` |
| Cross-tenant data leakage | CRITICAL | Cross-tenant tests for EVERY route; manual audit of all queries |
| Type safety loss (`as any`) | MEDIUM | ESLint rule to ban `as any`; require explicit type assertions |
| Performance issues from N+1 queries | MEDIUM | Use Drizzle's `with` clause for joins; add indexes as needed |

---

## Implementation Order

1. **Tenant routes** (POST/PUT/DELETE) — simplest, builds on existing GET
2. **Mappings routes** — more complex, includes sync trigger
3. **Members routes** — role checks, last-owner protection
4. **Billing routes** — replace in-memory service with DB-backed
5. **Run history routes** — join queries, event logging

---

*End of Design Proposal — Awaiting Owner Review*
