# Row-Level Security (RLS) Guide

## Overview

This document explains how Row-Level Security (RLS) is implemented in the Open Migration Stack for multi-tenant managed deployments.

## What is RLS?

Row-Level Security is a PostgreSQL feature that allows you to control access to rows in a table based on the current user or session context. In our case, it ensures that **Tenant A can never access Tenant B's data**, even if they somehow obtain the right database credentials.

## How It Works

### 1. Tenant Context

Before each query, the application must set the current tenant:

```sql
SET app.current_tenant = 'uuid-of-current-tenant';
```

This is typically done in middleware after JWT authentication extracts the tenant ID from the token.

### 2. RLS Policies

All tenant-scoped tables have four types of policies:

- **SELECT**: Only return rows where `tenant_id = current_setting('app.current_tenant')`
- **INSERT**: Only allow inserts where `tenant_id = current_setting('app.current_tenant')`
- **UPDATE**: Only allow updates to rows where `tenant_id = current_setting('app.current_tenant')`
- **DELETE**: Only allow deletion of rows where `tenant_id = current_setting('app.current_tenant')`

### 3. Tables with RLS

The following tables have RLS enabled:

- `tenant`
- `tenant_member`
- `connection`
- `mailbox`
- `mailbox_mapping`
- `group_def`
- `scope_selection`
- `collection_mapping`
- `item` (ledger)
- `sync_checkpoint`
- `run`
- `run_event`
- `decision`
- `policy_preset`
- `verification`
- `cutover`
- `backup_target`
- `audit_log`
- `cursor`
- `usage_metric`
- `invoice`
- `payment_method`

## Application Integration

### Express.js Middleware Example

```typescript
import { Request, Response, NextFunction } from 'express';
import { pool } from './db';

export async function tenantMiddleware(req: Request, res: Response, next: NextFunction) {
  // Extract tenant from JWT (assumes auth middleware ran first)
  const tenantId = req.user?.tenantId;
  
  if (!tenantId) {
    return res.status(401).json({ error: 'Tenant ID required' });
  }
  
  // Set tenant context for this connection
  const client = await pool.connect();
  try {
    await client.query("SET app.current_tenant = $1", [tenantId]);
    req['dbClient'] = client; // Store for later use
    next();
  } catch (error) {
    client.release();
    next(error);
  }
}

// Usage in query handlers
app.get('/api/connections', tenantMiddleware, async (req, res) => {
  const client = req['dbClient'];
  try {
    const result = await client.query('SELECT * FROM connection');
    // Only returns connections for the current tenant
    res.json(result.rows);
  } finally {
    client.release();
  }
});
```

### Drizzle ORM Example

```typescript
import { db } from './db';
import { connection } from './schema-pg';

// Set tenant context before queries
await db.execute(sql`SET app.current_tenant = ${tenantId}`);

// All queries automatically respect RLS
const connections = await db.select().from(connection);
// Only returns connections for the current tenant
```

## Testing RLS

### Unit Tests

Run the RLS test suite:

```bash
pnpm test:rls
```

This tests:
- Cross-tenant data isolation
- Insert restrictions
- Update restrictions
- Delete restrictions

### Manual Testing

```sql
-- Connect as Tenant A
SET app.current_tenant = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
SELECT * FROM connection; -- Should only see Tenant A's data

-- Switch to Tenant B
SET app.current_tenant = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
SELECT * FROM connection; -- Should only see Tenant B's data

-- Try to access Tenant A's data while logged in as Tenant B
SET app.current_tenant = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
SELECT * FROM connection WHERE tenant_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
-- Returns 0 rows (blocked by RLS)
```

## Self-Host Edition

For self-host deployments using SQLite:

- RLS is **not applicable** (SQLite doesn't support it)
- Tenant isolation is enforced in application code by always filtering by `tenant_id`
- Single-tenant by design (no multi-tenant support in self-host)

## Security Considerations

### Critical: Never Skip Tenant Context

⚠️ **Always** set `app.current_tenant` before executing queries. Failure to do so will result in:
- Empty query results (RLS blocks all access)
- Potential data leaks if RLS is disabled

### Best Practices

1. **Set tenant early**: Set `app.current_tenant` immediately after authentication
2. **Use connection pooling**: Each connection should have its own tenant context
3. **Reset on error**: Ensure tenant context is reset on connection return to pool
4. **Log violations**: Monitor for RLS policy violations in logs
5. **Test regularly**: Include RLS tests in your CI/CD pipeline

### Common Mistakes

❌ **Don't** rely on application-level filtering alone:
```typescript
// WRONG: RLS is bypassed if app.current_tenant is not set
const allConnections = await db.select().from(connection);
```

✅ **Do** use RLS with proper context:
```typescript
// RIGHT: RLS automatically filters by current tenant
await db.execute(sql`SET app.current_tenant = ${tenantId}`);
const connections = await db.select().from(connection);
```

❌ **Don't** share connections between tenants:
```typescript
// WRONG: Connection reused across requests with different tenants
```

✅ **Do** use proper connection pooling with per-request context:
```typescript
// RIGHT: Each request gets its own connection with correct tenant context
```

## Troubleshooting

### Query Returns No Data

**Symptom**: Queries return empty results even though data exists.

**Cause**: `app.current_tenant` is not set or is incorrect.

**Solution**:
```sql
-- Check current setting
SELECT current_setting('app.current_tenant', true);

-- Set it correctly
SET app.current_tenant = 'your-tenant-uuid';
```

### RLS Policy Violations

**Symptom**: PostgreSQL errors about RLS policies.

**Cause**: Attempting to access data outside the current tenant's scope.

**Solution**: Verify your authentication middleware is correctly extracting and setting the tenant ID.

### Performance Issues

**Symptom**: Queries are slower than expected.

**Cause**: RLS adds a small overhead to each query.

**Solution**:
- Ensure proper indexes on `tenant_id` columns
- Use connection pooling
- Consider query optimization for complex joins

## Migration Checklist

Before enabling RLS in production:

- [ ] All tables have RLS policies defined
- [ ] Application middleware sets `app.current_tenant` for all requests
- [ ] RLS tests pass in CI/CD
- [ ] Documentation is available to developers
- [ ] Monitoring is in place for RLS violations
- [ ] Rollback plan exists if issues arise

## References

- [PostgreSQL RLS Documentation](https://www.postgresql.org/docs/current/sql-altertable.html#SQL-ALTERTABLE-RLS)
- ADR-0010: Persistence Strategy
- ADR-0016: Ledger Schema
- Workplan 0005: Managed Edition
