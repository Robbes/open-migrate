// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Self-host appliance entrypoint (workplan 0010 T2).
 *
 * On startup: apply ledger migrations (advisory-locked) → load the mapping
 * configs from a directory → schedule each with the in-process croner scheduler
 * (single-flight, so an overrunning pass never overlaps itself) → serve
 * `GET /healthz` + `GET /status` on localhost. Graceful shutdown stops the
 * schedules, lets in-flight passes settle, and closes the server.
 *
 * Single-tenant, no managed dependencies: this file (and its transitive imports)
 * must never pull in Trigger.dev, billing, or RLS — self-host loads none of it
 * (hard rule 5). It reuses the worker's `runAllDomains` (shared, not forked).
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { runMigrations, createPgDb, PgMigrationStatusStore } from '@openmig/ledger';
// Import the in-process scheduler directly (NOT the package index, which
// re-exports the Trigger.dev client) so self-host never loads managed code —
// hard rule 5.
import { InProcessScheduler } from '@openmig/scheduler/in-process';
import { runAllDomains } from '@openmig/worker/orchestration';
import type { TenantId, MappingId, ScheduleHandle } from '@openmig/shared';
import { loadConfigDir, type LoadedMapping } from './config-dir';
import { buildStatusReport, type MappingStatusInput } from './status';

const DEFAULT_CONFIG_DIR = '/data/config';
const DEFAULT_SCHEDULE = '*/15 * * * *'; // every 15 minutes if a mapping omits one

// UUID generation for selfhost (deterministic based on input for idempotency)
function uuidFromString(seed: string): string {
  const hash = Buffer.from(seed).toString('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/**
 * Ensure all necessary database records exist for a mapping.
 * Creates connection, mailbox, and mailbox_mapping records if they don't exist.
 * This is needed because migration_status has FK constraints on mailbox_mapping.
 * 
 * NOTE: The client passed in should already have app.current_tenant set.
 */
async function ensureMappingRecords(
  client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  tenantId: string,
  mailboxMappingId: string,
  sourceUser: string,
  targetUser: string,
) {
  console.log(`[selfhost] ensuring mapping records for ${mailboxMappingId}...`);
  
    // 1. Ensure connection records exist (source and target)
    const sourceConnectionId = uuidFromString(`${tenantId}:source:imap`);
    const targetConnectionId = uuidFromString(`${tenantId}:target:jmap`);

    // Insert source connection (ignore if exists)
    await client.query(
      `INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [sourceConnectionId, tenantId, 'source', 'imap', 'Source IMAP', JSON.stringify({ type: 'imap', host: 'stalwart', port: 143, security: 'none' }), 'connected']
    );
    console.log(`[selfhost] ensured source connection ${sourceConnectionId}`);

    // Insert target connection (ignore if exists)
    await client.query(
      `INSERT INTO connection (id, tenant_id, role, kind, display_name, config, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [targetConnectionId, tenantId, 'target', 'jmap', 'Target JMAP', JSON.stringify({ type: 'jmap', host: 'stalwart', port: 8080, security: 'none' }), 'connected']
    );
    console.log(`[selfhost] ensured target connection ${targetConnectionId}`);

    // 2. Ensure mailbox records exist (source and target)
    const sourceMailboxId = uuidFromString(`${tenantId}:mailbox:source:${sourceUser}`);
    const targetMailboxId = uuidFromString(`${tenantId}:mailbox:target:${targetUser}`);

    // Insert source mailbox (ignore if exists)
    await client.query(
      `INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, primary_address, display_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [sourceMailboxId, tenantId, sourceConnectionId, sourceUser, 'user', sourceUser, sourceUser, 'active']
    );
    console.log(`[selfhost] ensured source mailbox ${sourceMailboxId}`);

    // Insert target mailbox (ignore if exists)
    await client.query(
      `INSERT INTO mailbox (id, tenant_id, connection_id, external_id, kind, primary_address, display_name, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO NOTHING`,
      [targetMailboxId, tenantId, targetConnectionId, targetUser, 'user', targetUser, targetUser, 'active']
    );
    console.log(`[selfhost] ensured target mailbox ${targetMailboxId}`);

    // 3. Ensure mailbox_mapping record exists (ignore if exists)
    await client.query(
      `INSERT INTO mailbox_mapping (id, tenant_id, source_mailbox_id, target_mailbox_id, mode, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [mailboxMappingId, tenantId, sourceMailboxId, targetMailboxId, 'mirror', 'active']
    );
    console.log(`[selfhost] ensured mailbox_mapping ${mailboxMappingId}`);
}

export interface SelfhostOptions {
  readonly databaseUrl?: string;
  readonly configDir?: string;
  readonly port?: number;
  readonly host?: string;
}

export interface SelfhostHandle {
  readonly port: number;
  stop(): Promise<void>;
}

/** Start the appliance. Returns a handle for graceful shutdown (used by tests too). */
export async function start(options: SelfhostOptions = {}): Promise<SelfhostHandle> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const configDir = options.configDir ?? process.env.CONFIG_DIR ?? DEFAULT_CONFIG_DIR;
  const port = options.port ?? Number(process.env.PORT ?? 8080);
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';

  // 1. Self-migrate under the advisory lock (refuses to start if DB is newer).
  console.log('[selfhost] applying migrations…');
  await runMigrations({ connectionString: databaseUrl });

  // 2. Load and validate the mapping configs.
  const mappings = loadConfigDir(configDir);
  console.log(`[selfhost] loaded ${mappings.length} mapping(s) from ${configDir}`);

  // 3. Wire the status store + scheduler.
  const db = createPgDb(databaseUrl);
  const statusStore = new PgMigrationStatusStore(db);
  const scheduler = new InProcessScheduler();
  const handles: ScheduleHandle[] = [];

  // Helper to run a function with tenant context set for RLS
  const withTenantContext = async <T>(
    tenantId: string,
    fn: (client: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>
  ): Promise<T> => {
    const client = await db.$pool.connect();
    try {
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);
      return await fn(client);
    } finally {
      client.release();
    }
  };

  const runMapping = (m: LoadedMapping) => async () => {
    try {
      console.log(`[selfhost] ${m.config.mappingId}: starting pass...`);
      
      // Ensure tenant exists and mapping records are set up with tenant context
      await withTenantContext(m.config.tenantId as string, async (client) => {
        // Ensure tenant exists before running (idempotent)
        await client.query(
          `INSERT INTO tenant (id, name, status, settings)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [m.config.tenantId, `Tenant ${m.config.tenantId.slice(0, 8)}`, 'active', '{}']
        );
        console.log(`[selfhost] ${m.config.mappingId}: tenant ensured`);
        
        // Ensure all necessary database records exist (connection, mailbox, mailbox_mapping)
        const sourceUser = m.config.source.type === 'imap-oauth2'
          ? m.config.source.user 
          : 'unknown';
        const targetUser = m.config.target.type === 'jmap' ? m.config.target.user : 'unknown';
        console.log(`[selfhost] ${m.config.mappingId}: ensuring mapping records...`);
        await ensureMappingRecords(
          client,
          m.config.tenantId as string,
          m.mailboxMappingId,
          sourceUser,
          targetUser,
        );
        console.log(`[selfhost] ${m.config.mappingId}: mapping records ensured`);
      });
      
      // Use the mailbox_mapping ID (not the config mappingId) for migration_status
      const configWithCorrectMappingId = {
        ...m.config,
        mappingId: m.mailboxMappingId,
      };
      
      console.log(`[selfhost] ${m.config.mappingId}: running domains...`);
      const results = await runAllDomains(configWithCorrectMappingId, statusStore);
      const created = results.reduce((n, r) => n + r.created, 0);
      console.log(`[selfhost] ${m.config.mappingId}: pass complete (${created} created)`);
    } catch (err) {
      // Surface, never swallow (hard rule 9). The scheduler keeps running.
      console.error(`[selfhost] ${m.config.mappingId}: pass failed:`, err instanceof Error ? err.message : err);
    }
  };

  for (const m of mappings) {
    const cron = m.config.schedule?.cron ?? DEFAULT_SCHEDULE;
    handles.push(scheduler.schedule(m.config.mappingId, cron, runMapping(m)));
    console.log(`[selfhost] scheduled ${m.config.mappingId} (${cron})`);
  }

  // 4. Local status/health server.
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && req.url === '/status') {
        const inputs: MappingStatusInput[] = [];
        for (const m of mappings) {
          const statuses = await statusStore.getStatus(
            m.config.tenantId as TenantId,
            m.mailboxMappingId as MappingId,
          );
          inputs.push({ mappingId: m.config.mappingId, statuses });
        }
        return sendJson(res, 200, buildStatusReport(inputs));
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, { error: err instanceof Error ? err.message : 'internal error' });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const boundPort = (server.address() as { port: number }).port;
  console.log(`[selfhost] status server on http://${host}:${boundPort}`);

  return {
    port: boundPort,
    stop: () => shutdown(server, handles, db),
  };
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function shutdown(
  server: Server,
  handles: readonly ScheduleHandle[],
  db: { close: () => Promise<void> },
): Promise<void> {
  // Stop scheduling new passes; single-flight means no pass overlaps, so any
  // in-flight pass runs to completion (persisting its cursors) before we exit.
  for (const h of handles) h.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.close();
}

// CLI entrypoint (skipped when imported by tests).
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === `file://${invokedPath}`) {
  start()
    .then((handle) => {
      const graceful = () => {
        console.log('[selfhost] shutting down…');
        handle.stop().then(() => process.exit(0)).catch(() => process.exit(1));
      };
      process.on('SIGTERM', graceful);
      process.on('SIGINT', graceful);
    })
    .catch((err) => {
      console.error('[selfhost] failed to start:', err);
      process.exit(1);
    });
}
