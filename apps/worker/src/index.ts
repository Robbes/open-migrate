#!/usr/bin/env node
/**
 * Worker CLI - runs shadow migration for a single mapping.
 *
 * Usage:
 *   node --loader ts-node/esm apps/worker/src/index.ts --config <mapping.json> [--once]
 *
 * Secrets are loaded from environment variables only (never from the config file).
 */

import {
  parseMappingConfig,
  type MappingConfig,
  type ReconcileDeps,
} from '@openmig/shared';
import { InProcessScheduler } from '@openmig/scheduler';
import { runShadowPass } from '@openmig/core';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
Worker CLI - Run shadow migration for a mapping

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
  const absolutePath = join(__dirname, configPath);
  const text = readFileSync(absolutePath, 'utf-8');
  return parseMappingConfig(text);
}

/** Build the dependency bundle for the shadow pass. */
async function buildDeps(_config: MappingConfig): Promise<ReconcileDeps> {
  // TODO: Implement actual dependency injection
  // For now, we'll create stub implementations that throw errors
  // This is a placeholder - the real implementation would connect to:
  // - Postgres for ledger
  // - IMAP source connector
  // - JMAP target writer
  // - Cursor store

  throw new Error(
    'Dependency injection not yet implemented. ' +
    'This worker requires: ledger (Postgres), source (IMAP), target (JMAP), cursors (Postgres). ' +
    'See workplan 0001 for the full dependency bundle definition.'
  );
}

/** Main entry point. */
async function main() {
  const { configPath, once } = parseArgs();
  console.log(`[Worker] Loading config from ${configPath}`);

  const config = loadConfig(configPath);
  console.log(`[Worker] Mapping ${config.mappingId} for tenant ${config.tenantId}`);

  if (once) {
    // Run once mode
    console.log('[Worker] Running shadow pass once...');
    const deps = await buildDeps(config);
    const result = await runShadowPass(deps);
    console.log(`[Worker] Complete: scanned=${result.scanned}, created=${result.created}, skipped=${result.skipped}`);
    process.exit(0);
  } else {
    // Scheduled mode
    if (!config.schedule) {
      console.error('[Worker] Error: --once required or schedule.cron must be set in config');
      process.exit(1);
    }

    console.log(`[Worker] Starting scheduled mode with cron: ${config.schedule.cron}`);
    const scheduler = new InProcessScheduler();
    const deps = await buildDeps(config);

    scheduler.schedule(config.mappingId, config.schedule.cron, async () => {
      console.log('[Worker] Running scheduled shadow pass...');
      try {
        const result = await runShadowPass(deps);
        console.log(`[Worker] Schedule complete: scanned=${result.scanned}, created=${result.created}, skipped=${result.skipped}`);
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

