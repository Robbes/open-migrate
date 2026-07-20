#!/usr/bin/env node
/**
 * Worker CLI - runs shadow migration for a single mapping with multi-domain support.
 *
 * Usage:
 *   node --loader ts-node/esm apps/worker/src/index.ts --config <mapping.json> [--once]
 *
 * Secrets are loaded from environment variables only (never from the config file).
 * 
 * Multi-domain orchestration:
 * - Runs all enabled domains (mail, calendar, contacts, files) independently
 * - A failed domain does NOT block other domains
 * - Tracks status via MigrationStatusStore for each domain
 */

import {
  parseMappingConfig,
  type MappingConfig,
} from '@openmig/shared';
import { InProcessScheduler } from '@openmig/scheduler';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { runAllDomains } from './orchestration';
import { PgLedger as _PgLedger, PgMigrationStatusStore, createPgDb } from '@openmig/ledger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Parse command line arguments. */
function parseArgs(): { configPath: string; once: boolean } {
  const args = process.argv.slice(2);
  let configPath: string | undefined;
  let once = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (args[i] === '--once') {
      once = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Worker CLI - Run shadow migration for a mapping with multi-domain support

Usage:
  node --loader ts-node/esm apps/worker/src/index.ts --config <mapping.json> [--once]

Options:
  --config, -c <path>  Path to mapping config JSON file (required)
  --once               Run once immediately and exit (default: run in scheduled mode)
  --help, -h           Show this help message

Examples:
  # Run once immediately
  node --loader ts-node/esm apps/worker/src/index.ts --config mapping.json --once

  # Run in scheduled mode (respects cron from config)
  node --loader ts-node/esm apps/worker/src/index.ts --config mapping.json

Environment Variables:
  DATABASE_URL         PostgreSQL connection string (required)
  OAUTH2_ACCESS_TOKEN  OAuth2 access token for O365 (if using XOAUTH2)
`);
      process.exit(0);
    }
  }

  if (!configPath) {
    console.error('Error: --config <path> is required');
    process.exit(1);
  }

  return { configPath, once };
}

/** Load mapping config from file. */
function loadConfig(configPath: string): MappingConfig {
  // Resolve config path relative to current working directory, not __dirname
  // This allows --config ./mapping.json to work from any directory
  const absolutePath = resolve(process.cwd(), configPath);
  const text = readFileSync(absolutePath, 'utf-8');
  return parseMappingConfig(text);
}

/** Main entry point. */
async function main() {
  const { configPath, once } = parseArgs();
  console.log(`[Worker] Loading config from ${configPath}`);

  const config = loadConfig(configPath);
  console.log(`[Worker] Mapping ${config.mappingId} for tenant ${config.tenantId}`);

  // Create database connection and status store
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required. ' +
      'Example: postgres://user:password@localhost:5432/openmig'
    );
  }
  const db = createPgDb(databaseUrl);
  const statusStore = new PgMigrationStatusStore(db);

  if (once) {
    // Run once mode
    console.log('[Worker] Running all enabled domains...');
    const results = await runAllDomains(config, statusStore);
    
    const totalScanned = results.reduce((sum, r) => sum + r.scanned, 0);
    const totalCreated = results.reduce((sum, r) => sum + r.created, 0);
    const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
    
    console.log(`[Worker] Complete: scanned=${totalScanned}, created=${totalCreated}, failed=${totalFailed}`);
    process.exit(totalFailed > 0 ? 1 : 0);
  } else {
    // Scheduled mode
    if (!config.schedule) {
      console.error('[Worker] Error: --once required or schedule.cron must be set in config');
      process.exit(1);
    }

    console.log(`[Worker] Starting scheduled mode with cron: ${config.schedule.cron}`);
    const scheduler = new InProcessScheduler();

    scheduler.schedule(config.mappingId, config.schedule.cron, async () => {
      console.log('[Worker] Running scheduled sync...');
      try {
        const results = await runAllDomains(config, statusStore);
        
        const totalScanned = results.reduce((sum, r) => sum + r.scanned, 0);
        const totalCreated = results.reduce((sum, r) => sum + r.created, 0);
        const totalFailed = results.reduce((sum, r) => sum + r.failed, 0);
        
        console.log(`[Worker] Schedule complete: scanned=${totalScanned}, created=${totalCreated}, failed=${totalFailed}`);
      } catch (err) {
        const error = err as Error;
        console.error(`[Worker] Schedule failed: ${error.message}`);
        // Don't exit - keep the scheduler running
      }
    });

    console.log('[Worker] Scheduler started. Press Ctrl+C to stop.');
    // Keep the process alive
    process.on('SIGINT', () => {
      console.log('\n[Worker] Shutting down...');
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});

