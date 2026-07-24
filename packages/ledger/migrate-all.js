#!/usr/bin/env node
/**
 * Apply all SQL migrations in order to the database using pg.
 * 
 * Usage: DATABASE_URL=postgres://... node migrate-all.js
 */

import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable not set');
  process.exit(1);
}

const migrationsDir = path.join(__dirname, 'migrations');
const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`Found ${migrationFiles.length} migrations to apply`);

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function main() {
  try {
    for (const file of migrationFiles) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      console.log(`Applying ${file}...`);
      
      try {
        await pool.query(sql);
        console.log(`✓ ${file} applied\n`);
      } catch (error) {
        // Ignore duplicate object errors (idempotent)
        if (error.code === '42P07' || error.code === '42710') {
          console.log(`- ${file} skipped (already exists)\n`);
        } else {
          console.error(`✗ Failed to apply ${file}:`, error.message);
          await pool.end();
          process.exit(1);
        }
      }
    }
    
    console.log('✅ All migrations applied successfully');
  } finally {
    await pool.end();
  }
}

main();
