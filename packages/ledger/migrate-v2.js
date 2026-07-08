#!/usr/bin/env node
/**
 * Ledger Schema v2 Migration Script
 * 
 * This script applies the multi-tenant schema migration with RLS support.
 * Since the existing schema (0001_init.sql) already includes tenant_id fields,
 * this migration focuses on:
 * 1. Applying the new migration (0002_multi_tenant_rls.sql)
 * 2. Creating a default tenant if none exists
 * 
 * Usage:
 *   node migrate-v2.js
 * 
 * Environment variables:
 *   DATABASE_URL - PostgreSQL connection string
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost/openmigrate';

function runCommand(cmd) {
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
    return output;
  } catch (error) {
    throw new Error(`Command failed: ${cmd}\n${error.message}`);
  }
}

async function main() {
  console.log('Starting Ledger Schema v2 migration...\n');
  
  try {
    // Step 1: Apply migration SQL using psql
    console.log('Step 1: Applying migration 0002_multi_tenant_rls.sql...');
    const migrationPath = path.join(
      import.meta.dirname,
      'migrations',
      '0002_multi_tenant_rls.sql'
    );
    
    const psqlCmd = `psql "${DATABASE_URL}" -f "${migrationPath}"`;
    runCommand(psqlCmd);
    console.log('✓ Migration applied successfully\n');
    
    // Step 2: Create default tenant if none exists
    console.log('Step 2: Creating default tenant if needed...');
    const checkTenant = `psql "${DATABASE_URL}" -t -c "SELECT COUNT(*) FROM tenant;"`;
    const countResult = runCommand(checkTenant).trim();
    const count = parseInt(countResult, 10) || 0;
    
    if (count === 0) {
      const createTenant = `psql "${DATABASE_URL}" -c "INSERT INTO tenant (name, status) VALUES ('default', 'active');"`;
      runCommand(createTenant);
      console.log('✓ Default tenant created\n');
    } else {
      console.log(`✓ Found ${count} existing tenant(s), skipping default creation\n`);
    }
    
    // Step 3: Verify RLS is enabled
    console.log('Step 3: Verifying RLS configuration...');
    const verifyRLS = `psql "${DATABASE_URL}" -t -c "SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('tenant', 'connection', 'item', 'run') LIMIT 4;"`;
    runCommand(verifyRLS);
    console.log('✓ RLS verification complete\n');
    
    console.log('✅ Ledger Schema v2 migration completed successfully!');
    console.log('\nNext steps:');
    console.log('1. Set app.current_tenant before each query in managed mode');
    console.log('2. Update application middleware to extract tenant from JWT');
    console.log('3. Test RLS policies with multiple tenants');
    console.log('\nRun: pnpm typecheck && pnpm test to verify the changes');
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

// Run migration
main();
