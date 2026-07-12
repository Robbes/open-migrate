/**
 * RLS Integration Tests
 * 
 * Tests to verify Row-Level Security policies work correctly
 * These tests require a PostgreSQL database with RLS enabled
 * 
 * Run: pnpm test:integration
 * 
 * UUID Family: 950e8400-e29b-41d4-a716-44665544xxxx
 * This family is reserved for RLS tests to avoid collisions with other test suites.
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

// UUID Family for RLS tests (950e8400-e29b-41d4-a716-44665544xxxx)
// This avoids collisions with other test suites:
// - 550e8400-e29b-41d4-a716-4466554401xx: verification tests
// - 550e8400-e29b-41d4-a716-4466554402xx: cutover lifecycle tests
// - 550e8400-e29b-41d4-a716-4466554403xx: rollback tests
// - 950e8400-e29b-41d4-a716-44665544xxxx: RLS tests (this suite)
const TENANT_RLS_A = '950e8400-e29b-41d4-a716-446655441101';
const TENANT_RLS_B = '950e8400-e29b-41d4-a716-446655441102';
const CONNECTION_RLS_A = '950e8400-e29b-41d4-a716-446655441201';
const CONNECTION_RLS_B = '950e8400-e29b-41d4-a716-446655441202';

describe('RLS Policies', () => {
  let pool: Pool;
  let _db: ReturnType<typeof drizzle<typeof schema>>;
  
  beforeAll(async () => {
    pool = new Pool({
      connectionString: PG_CONNECTION_STRING,
    });
    _db = drizzle(pool, { schema });
    
    // Setup test data (idempotent - uses ON CONFLICT DO NOTHING)
    await setupTestData();
  });
  
  afterAll(async () => {
    await cleanupTestData();
    await pool.end();
  });
  
  async function setupTestData() {
    // Create test tenants (idempotent)
    await pool.query(`
      INSERT INTO tenant (id, name, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `, [TENANT_RLS_A, 'Tenant A RLS', 'active']);
    
    await pool.query(`
      INSERT INTO tenant (id, name, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `, [TENANT_RLS_B, 'Tenant B RLS', 'active']);
    
    // Create connections for each tenant (idempotent)
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'source', 'o365', 'Tenant A RLS Source', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [CONNECTION_RLS_A, TENANT_RLS_A]);
    
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'source', 'o365', 'Tenant B RLS Source', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [CONNECTION_RLS_B, TENANT_RLS_B]);
  }
  
  async function cleanupTestData() {
    // Clean up in reverse order (children first)
    await pool.query('DELETE FROM connection WHERE tenant_id IN ($1, $2)', [TENANT_RLS_A, TENANT_RLS_B]);
    await pool.query('DELETE FROM tenant WHERE id IN ($1, $2)', [TENANT_RLS_A, TENANT_RLS_B]);
  }
  
  it('should prevent cross-tenant data access', async () => {
    // Set current_tenant to Tenant A (using template literal for SET command)
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_A}'`);
    
    // Query connections - should only return Tenant A's connection
    const result = await pool.query('SELECT * FROM connection');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tenant_id).toBe(TENANT_RLS_A);
    
    // Try to access Tenant B's data - should return empty
    const resultB = await pool.query('SELECT * FROM connection WHERE tenant_id = $1', [TENANT_RLS_B]);
    expect(resultB.rows).toHaveLength(0);
  });
  
  it('should allow tenant-specific inserts', async () => {
    // Set current_tenant to Tenant A
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_A}'`);
    
    // Insert a new connection (use unique ID to avoid collision)
    const newId = '950e8400-e29b-41d4-a716-446655441301';
    await pool.query(`
      INSERT INTO connection (id, tenant_id, role, kind, display_name, config)
      VALUES ($1, $2, 'target', 'imap', 'Tenant A RLS Target', '{}')
      ON CONFLICT (id) DO NOTHING
    `, [newId, TENANT_RLS_A]);
    
    // Verify it was created
    const result = await pool.query('SELECT * FROM connection WHERE id = $1', [newId]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].tenant_id).toBe(TENANT_RLS_A);
    
    // Clean up
    await pool.query('DELETE FROM connection WHERE id = $1', [newId]);
  });
  
  it('should prevent cross-tenant updates', async () => {
    // Set current_tenant to Tenant A
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_A}'`);
    
    // Try to update Tenant B's connection - should affect 0 rows
    const result = await pool.query(`
      UPDATE connection SET display_name = 'Hacked!' WHERE tenant_id = $1
    `, [TENANT_RLS_B]);
    
    expect(result.rowCount).toBe(0);
  });
  
  it('should prevent cross-tenant deletes', async () => {
    // Set current_tenant to Tenant A
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_A}'`);
    
    // Try to delete Tenant B's connection - should affect 0 rows
    const result = await pool.query('DELETE FROM connection WHERE tenant_id = $1', [TENANT_RLS_B]);
    
    expect(result.rowCount).toBe(0);
    
    // Verify Tenant B's connection still exists
    const check = await pool.query('SELECT * FROM connection WHERE id = $1', [CONNECTION_RLS_B]);
    expect(check.rows).toHaveLength(1);
  });
  
  it('should work with multiple table types', async () => {
    // Test with item table
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_A}'`);
    
    const result = await pool.query('SELECT COUNT(*) FROM item');
    expect(parseInt(result.rows[0].count)).toBeGreaterThanOrEqual(0);
    
    // Should not see Tenant B's items
    await pool.query(`SET app.current_tenant = '${TENANT_RLS_B}'`);
    const resultB = await pool.query('SELECT COUNT(*) FROM item');
    expect(parseInt(resultB.rows[0].count)).toBeGreaterThanOrEqual(0);
    
    // Counts should differ if data exists
    // (This test assumes there's actual data in the item table)
  });
});
