/**
 * Database connection for the API
 * 
 * Creates a shared pg pool for tenant-scoped queries via withTenantDb.
 */

import { Pool } from 'pg';

// Create a shared pool for the API
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Get the shared database pool
 */
export function getDbPool(): Pool {
  return pool;
}

/**
 * Close the database pool
 */
export async function closeDbPool(): Promise<void> {
  await pool.end();
}
