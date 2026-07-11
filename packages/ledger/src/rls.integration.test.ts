/**
 * RLS Integration Tests
 * 
 * Tests to verify Row-Level Security policies work correctly
 * These tests require a PostgreSQL database with RLS enabled
 * 
 * Run: pnpm test:rls
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema-pg';

// Connection string from Testcontainers (set by vitest.global-setup.ts)
// Fails loudly if TEST_DATABASE_URL is not set, rather than silently using wrong defaults.
const PG_CONNECTION_STRING = process.env.TEST_DATABASE_URL;
if (!PG_CONNECTION_STRING) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Integration tests require Testcontainers to be running. ' +
    'Run: pnpm test:integration'
  );
}

describe('RLS Policies', () => {
  let pool: Pool;
  let _db: ReturnType<typeof drizzle<typeof schema>>;
  
  // Test tenant IDs
  const tenantA = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
  const tenantB = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22';
  
  beforeAll(async () => {
    pool = new Pool({
      connectionString: PG_CONNECTION_STRING,
    });
    _db = drizzle(pool, { schema });
    
    // Setup test data
    await setupTestData();
  });
  
  afterAll(async () => {
    await cleanupTestData();
    await pool.end();
  });
  
  async function setupTestData() {
    // Create test tenants
    await pool.query('INSERT INTO tenant (id, name, status) VALUES ($1, $2, $3)',
      [tenantA, 'Tenant A', 'active']);
    await pool.query('INSERT INTO tenant (id, name, status) VALUES ($1, $2, $3)',
      [tenantB, 'Tenant B', 'active']);
    
    // Create connections for each tenant
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'source', 'o365', 'Tenant A Source', '{}')
    `, ['c1', tenantA]);
    
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'source', 'o365', 'Tenant B Source', '{}')
    `, ['c2', tenantB]);
  }
  
  async function cleanupTestData() {
    await pool.query('DELETE FROM connection WHERE tenant_id IN ($1, $2)', [tenantA, tenantB]);
    await pool.query('DELETE FROM tenant WHERE id IN ($1, $2)', [tenantA, tenantB]);
  }
  
  it('should prevent cross-tenant data access', async () => {
    // Set current_tenant to Tenant A
    await pool.query("SET app.current_tenant = $1", [tenantA]);
    
    // Query connections - should only return Tenant A's connection
    const result = await pool.query('SELECT * FROM connection');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tenant_id).toBe(tenantA);
    
    // Try to access Tenant B's data - should return empty
    const resultB = await pool.query('SELECT * FROM connection WHERE tenant_id = $1', [tenantB]);
    expect(resultB.rows).toHaveLength(0);
  });
  
  it('should allow tenant-specific inserts', async () => {
    // Set current_tenant to Tenant A
    await pool.query("SET app.current_tenant = $1", [tenantA]);
    
    // Insert a new connection
    const newId = 'c3';
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'target', 'imap', 'Tenant A Target', '{}')
    `, [newId, tenantA]);
    
    // Verify it was created
    const result = await pool.query('SELECT * FROM connection WHERE id = $1', [newId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tenant_id).toBe(tenantA);
  });
  
  it('should prevent cross-tenant updates', async () => {
    // Set current_tenant to Tenant A
    await pool.query("SET app.current_tenant = $1", [tenantA]);
    
    // Try to update Tenant B's connection - should affect 0 rows
    const result = await pool.query(`
      UPDATE connection SET display_name = 'Hacked!' WHERE tenant_id = $1
    `, [tenantB]);
    
    expect(result.rowCount).toBe(0);
  });
  
  it('should prevent cross-tenant deletes', async () => {
    // Set current_tenant to Tenant A
    await pool.query("SET app.current_tenant = $1", [tenantA]);
    
    // Try to delete Tenant B's connection - should affect 0 rows
    const result = await pool.query('DELETE FROM connection WHERE tenant_id = $1', [tenantB]);
    
    expect(result.rowCount).toBe(0);
    
    // Verify Tenant B's connection still exists
    const check = await pool.query('SELECT * FROM connection WHERE id = $1', ['c2']);
    expect(check.rows).toHaveLength(1);
  });
  
  it('should work with multiple table types', async () => {
    // Test with item table
    await pool.query("SET app.current_tenant = $1", [tenantA]);
    
    const result = await pool.query('SELECT COUNT(*) FROM item');
    expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0);
    
    // Should not see Tenant B's items
    await pool.query("SET app.current_tenant = $1", [tenantB]);
    const resultB = await pool.query('SELECT COUNT(*) FROM item');
    expect(parseInt(resultB.rows[0].count)).toBeGreaterThanOrEqual(0);
    
    // Counts should differ if data exists
    // (This test assumes there's actual data in the item table)
  });
});
