#!/usr/bin/env node
/**
 * Cutover CLI - manages cutover lifecycle
 *
 * Usage:
 *   node --loader ts-node/esm apps/worker/src/cli/index.ts <command> [options]
 *
 * Commands:
 *   start-cutover  Initialize a new cutover
 *   verify         Run verification checks
 *   approve        Approve cutover for execution
 *   execute        Execute the cutover
 *   rollback       Rollback cutover
 *   status         Show cutover status
 */

import { CutoverPersistence } from '@openmig/core';
import * as cutoverCli from './cutover-commands';

/** Parse cutover CLI arguments */
function parseArgs(): {
  command: string;
  tenantId: string;
  mappingId: string;
  domain: string;
  targetMailServer?: string;
} {
  const args = process.argv.slice(2);
  let command: string | undefined;
  let tenantId: string | undefined;
  let mappingId: string | undefined;
  let domain: string | undefined;
  let targetMailServer: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') && !command) {
      command = arg;
    } else if (arg === '--tenant' || arg === '-t') {
      tenantId = args[++i];
    } else if (arg === '--mapping' || arg === '-m') {
      mappingId = args[++i];
    } else if (arg === '--domain' || arg === '-d') {
      domain = args[++i];
    } else if (arg === '--target' || arg === '-T') {
      targetMailServer = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Cutover CLI - Manage migration cutover lifecycle

Usage:
  node --loader ts-node/esm apps/worker/src/cli/index.ts <command> [options]

Commands:
  start-cutover    Initialize a new cutover
  verify           Run verification checks (DNS, data completeness)
  approve          Approve cutover for execution
  execute          Execute the cutover (switch DNS, etc.)
  rollback         Rollback cutover to previous state
  status           Show current cutover status

Options:
  --tenant, -t <id>     Tenant ID (required)
  --mapping, -m <id>    Mapping ID (required)
  --domain, -d <name>   Domain name for DNS (required)
  --target, -T <host>   Target mail server (default: mail.<domain>)
  --help, -h            Show this help message

Examples:
  # Start a new cutover
  node --loader ts-node/esm apps/worker/src/cli/index.ts start-cutover \\
    --tenant tenant123 --mapping mapping456 --domain example.com

  # Run verification checks
  node --loader ts-node/esm apps/worker/src/cli/index.ts verify \\
    --tenant tenant123 --mapping mapping456 --domain example.com

  # Approve cutover
  node --loader ts-node/esm apps/worker/src/cli/index.ts approve \\
    --tenant tenant123 --mapping mapping456 --domain example.com

  # Execute cutover
  node --loader ts-node/esm apps/worker/src/cli/index.ts execute \\
    --tenant tenant123 --mapping mapping456 --domain example.com

  # Rollback cutover
  node --loader ts-node/esm apps/worker/src/cli/index.ts rollback \\
    --tenant tenant123 --mapping mapping456 --domain example.com

  # Show status
  node --loader ts-node/esm apps/worker/src/cli/index.ts status \\
    --tenant tenant123 --mapping mapping456 --domain example.com

Environment Variables:
  DATABASE_URL  PostgreSQL connection string (required)
`);
      process.exit(0);
    }
  }

  if (!command) {
    console.error('Error: command required (start-cutover, verify, approve, execute, rollback, status)');
    process.exit(1);
  }

  if (!tenantId) {
    console.error('Error: --tenant <id> is required');
    process.exit(1);
  }

  if (!mappingId) {
    console.error('Error: --mapping <id> is required');
    process.exit(1);
  }

  if (!domain) {
    console.error('Error: --domain <name> is required');
    process.exit(1);
  }

  return { command, tenantId, mappingId, domain, targetMailServer };
}

/** Main entry point. */
async function main() {
  const { command, tenantId, mappingId, domain, targetMailServer } = parseArgs();

  // Initialize database connection
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Error: DATABASE_URL environment variable required');
    process.exit(1);
  }

  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: dbUrl });
  const db = drizzle(pool);

  const cutoverPersistence = new CutoverPersistence(db);

  const deps: cutoverCli.CutoverCliDeps = {
    tenantId: tenantId as any,
    mappingId: mappingId as any,
    cutoverPersistence,
    dnsDomain: domain,
    targetMailServer: targetMailServer || `mail.${domain}`,
  };

  switch (command) {
    case 'start-cutover':
      await cutoverCli.startCutover(deps);
      break;
    case 'verify':
      const verified = await cutoverCli.verifyCutover(deps);
      process.exit(verified ? 0 : 1);
      break;
    case 'approve':
      await cutoverCli.approveCutover(deps);
      break;
    case 'execute':
      await cutoverCli.executeCutover(deps);
      break;
    case 'rollback':
      await cutoverCli.rollbackCutover(deps);
      break;
    case 'status':
      await cutoverCli.showStatus(deps);
      break;
    default:
      console.error(`Unknown cutover command: ${command}`);
      console.error('Use: start-cutover, verify, approve, execute, rollback, status');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[Cutover CLI] Fatal error:', err);
  process.exit(1);
});
