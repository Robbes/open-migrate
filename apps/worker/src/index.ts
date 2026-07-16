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
  type MigrationStatusStore,
  type TenantId,
  type MappingId,
} from '@openmig/shared';
import { InProcessScheduler } from '@openmig/scheduler';
import { runShadowPass, runCalendarSync, runContactSync, runFileSync } from '@openmig/core';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { buildDeps, buildDomainDeps } from './build-deps';
import { PgLedger as _PgLedger, PgMigrationStatusStore, createPgDb } from '@openmig/ledger';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Per-domain sync result with status tracking. */
interface DomainSyncResult {
  readonly domain: 'email' | 'calendar' | 'contact' | 'file';
  readonly scanned: number;
  readonly created: number;
  readonly skipped: number;
  readonly failed: number;
  readonly error?: string;
}

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

/** Run all enabled domains with status tracking. */
async function runAllDomains(config: MappingConfig, statusStore: MigrationStatusStore): Promise<DomainSyncResult[]> {
  const results: DomainSyncResult[] = [];
  const domains: Array<{ name: 'email' | 'calendar' | 'contact' | 'file'; enabled: boolean }> = [
    { name: 'email', enabled: config.domains?.mail?.enabled ?? false },
    { name: 'calendar', enabled: config.domains?.calendar?.enabled ?? false },
    { name: 'contact', enabled: config.domains?.contacts?.enabled ?? false },
    { name: 'file', enabled: config.domains?.files?.enabled ?? false },
  ];

  // Also run mail if no domain config exists (backward compatibility)
  const hasDomainConfig = config.domains && Object.values(config.domains).some(d => d?.enabled);
  const runMailOnly = !hasDomainConfig && config.source.type === 'imap-oauth2';

  if (runMailOnly) {
    // Legacy mode: run only mail without domain config
    domains[0]!.enabled = true;
  }

  for (const { name: domain, enabled } of domains) {
    const tenantId = config.tenantId as TenantId;
    const mappingId = config.mappingId as MappingId;

    // Initialize status
    await statusStore.initDomainStatus(tenantId, mappingId, domain);

    if (!enabled) {
      console.log(`[Worker] Domain ${domain} is disabled, skipping`);
      await statusStore.markSkipped(tenantId, mappingId, domain);
      results.push({ domain, scanned: 0, created: 0, skipped: 0, failed: 0 });
      continue;
    }

    // Mark in progress
    await statusStore.markInProgress(tenantId, mappingId, domain);

    try {
      let result;
      
      if (domain === 'email') {
        // Mail sync via runShadowPass
        console.log(`[Worker] Running mail sync...`);
        const deps = await buildDeps(config);
        result = await runShadowPass(deps);
        results.push({
          domain,
          scanned: result.scanned,
          created: result.created,
          skipped: result.skipped,
          failed: 0,
        });
      } else if (domain === 'calendar') {
        // Calendar sync
        console.log(`[Worker] Running calendar sync...`);
        if (!config.domains?.calendar?.enabled) {
          throw new Error('Calendar domain not configured');
        }
        const deps = buildDomainDeps(config, 'calendar');
        result = await runCalendarSync(deps);
        results.push({
          domain,
          scanned: result.scanned,
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
        });
      } else if (domain === 'contact') {
        // Contact sync
        console.log(`[Worker] Running contact sync...`);
        if (!config.domains?.contacts?.enabled) {
          throw new Error('Contact domain not configured');
        }
        const deps = buildDomainDeps(config, 'contact');
        result = await runContactSync(deps);
        results.push({
          domain,
          scanned: result.scanned,
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
        });
      } else if (domain === 'file') {
        // File sync
        console.log(`[Worker] Running file sync...`);
        if (!config.domains?.files?.enabled) {
          throw new Error('File domain not configured');
        }
        const deps = buildDomainDeps(config, 'file');
        result = await runFileSync(deps);
        results.push({
          domain,
          scanned: result.scanned,
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
        });
      }

      // Mark completed
      await statusStore.markCompleted(tenantId, mappingId, domain);
      const lastResult = results[results.length - 1]!;
      console.log(`[Worker] ${domain} sync complete: scanned=${lastResult.scanned}, created=${lastResult.created}, skipped=${lastResult.skipped}`);

    } catch (err) {
      const error = err as Error;
      console.error(`[Worker] ${domain} sync failed: ${error.message}`);
      
      // Mark failed
      await statusStore.markFailed(tenantId, mappingId, domain, error.message);
      
      results.push({
        domain,
        scanned: 0,
        created: 0,
        skipped: 0,
        failed: 1,
        error: error.message,
      });
      
      // Continue to next domain (don't block)
    }
  }

  return results;
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

