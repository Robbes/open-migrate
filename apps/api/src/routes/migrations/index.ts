/**
 * Migration Management Routes
 * 
 * CRUD operations for migrations, sync triggers, and run history.
 * Integrates with Trigger.dev for job orchestration.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, getDbPool, withTenantDb } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';
import { eq, and, desc } from 'drizzle-orm';
import * as schema from '@openmig/ledger';
import { SecretStore } from '@openmig/core/secret-store';
import { getTriggerClient } from '@openmig/scheduler';
import { resolveSyncJob, resolveCutoverJob } from './job-resolution';

/** Take the first row of a RETURNING result or fail loudly (no silent nulls). */
function firstOrThrow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`failed to create ${what}`);
  }
  return row;
}

/** Map the web source type to a connection.kind (protocol-based). */
function sourceKindFor(sourceType: 'imap' | 'oauth2' | 'graph'): 'imap' | 'o365' {
  return sourceType === 'imap' ? 'imap' : 'o365';
}

/** Map a ledger `run` row to the API/web Run shape. */
type LedgerRun = typeof schema.run.$inferSelect;
function toApiRun(r: LedgerRun): {
  id: string;
  mappingId: string | null;
  type: 'full' | 'delta';
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  startedAt: string | null;
  finishedAt: string | null;
  itemsProcessed: number;
  errors: number;
  createdAt: string;
} {
  const statusMap: Record<LedgerRun['status'], 'pending' | 'running' | 'success' | 'failed' | 'cancelled'> = {
    queued: 'pending',
    running: 'running',
    succeeded: 'success',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  const stats = (r.stats ?? {}) as { itemsProcessed?: number; errors?: number };
  return {
    id: r.id,
    mappingId: r.mappingId,
    // 'incremental' is the delta pass; everything else is a full-scan kind.
    type: r.kind === 'incremental' ? 'delta' : 'full',
    status: statusMap[r.status],
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    itemsProcessed: Number(stats.itemsProcessed ?? 0),
    errors: Number(stats.errors ?? 0),
    createdAt: r.createdAt.toISOString(),
  };
}

const router = Router();

// Global pool - created once and reused
let _dbPool: ReturnType<typeof getDbPool> | null = null;
function getSharedPool() {
  if (!_dbPool) {
    _dbPool = getDbPool();
  }
  return _dbPool;
}

// Schema validation
const CreateMappingSchema = z.object({
  name: z.string().min(1).max(255),
  sourceType: z.enum(['imap', 'oauth2', 'graph']),
  targetType: z.enum(['jmap', 'imap', 'caldav', 'carddav', 'webdav']),
  sourceConfig: z.object({
    host: z.string(),
    port: z.number(),
    username: z.string(),
    password: z.string().optional(),
    useSsl: z.boolean().default(true),
  }),
  targetConfig: z.object({
    host: z.string(),
    port: z.number(),
    username: z.string(),
    password: z.string(),
    useSsl: z.boolean().default(true),
  }),
  syncConfig: z.object({
    domains: z.array(z.enum(['email', 'calendar', 'contact', 'file'])).default(['email']),
    schedule: z.string().optional(), // Cron expression
  }).default({ domains: ['email'] }),
  // Mapping-specific fields (for mailbox_mapping table)
  status: z.enum(['active', 'paused', 'cutover', 'done']).optional(),
  mode: z.enum(['mirror', 'bidirectional', 'one_time', 'asymmetric']).optional(),
  pattern: z.enum(['shared_s', 'distribution_d']).optional(),
});

const UpdateMappingSchema = CreateMappingSchema.partial();

const TriggerSyncSchema = z.object({
  type: z.enum(['full', 'delta']).optional(),
  mode: z.string().optional(), // Accept legacy 'mode' field for tests
  forceFullScan: z.boolean().default(false),
}).passthrough(); // Allow additional fields

const TriggerCutoverSchema = z.object({
  skipFinalSync: z.boolean().default(false),
  skipVerification: z.boolean().default(false),
  gracePeriodHours: z.number().default(24),
  pattern: z.string().optional(), // Accept legacy 'pattern' field for tests
}).passthrough(); // Allow additional fields

/**
 * GET /api/mappings
 * 
 * List all mappings for the current tenant
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tenantId = req.tenantId;

    if (!tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }

    const pool = getSharedPool();

    // Query mappings with RLS enforcement via withTenantDb
    const mappings = await withTenantDb(tenantId, pool, async (db) => {
      // Use raw select since the query relations aren't fully set up
      return await db
        .select()
        .from(schema.mailboxMapping)
        .where(eq(schema.mailboxMapping.tenantId, tenantId));
    });

    res.json({
      mappings: mappings.map((m) => ({
        id: m.id,
        tenant_id: tenantId,
        name: m.name ?? m.mode, // real name (falls back to mode for legacy rows)
        sourceType: 'imap',
        targetType: 'jmap',
        status: m.status,
        mode: m.mode,
        pattern: m.pattern,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      })),
    });
  } catch (error) {
    console.error('Error listing mappings:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list mappings',
    });
  }
});

/**
 * POST /api/mappings
 * 
 * Create a new migration mapping
 */
router.post('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req;
    const body = CreateMappingSchema.parse(req.body);

    if (!tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }

    // Persist the full chain in one tenant-scoped transaction (RLS-enforced):
    // source + target connection (with ENCRYPTED credentials), a mailbox per
    // connection, the mailbox_mapping, and one scope_selection row per domain.
    const created = await withTenantDb(tenantId, getSharedPool(), async (db) => {
      // Never store plaintext secrets — encrypt via SecretStore. secret_ref is a
      // text column read back by decryptCredentials(string) → parseEncryptedSecret,
      // which expects the inner EncryptedSecret ({v,n,t,c}) JSON, so store `.encrypted`.
      const sourceSecret = JSON.stringify(
        SecretStore.encryptCredentials({
          username: body.sourceConfig.username,
          ...(body.sourceConfig.password ? { password: body.sourceConfig.password } : {}),
        }).encrypted,
      );
      const targetSecret = JSON.stringify(
        SecretStore.encryptCredentials({
          username: body.targetConfig.username,
          password: body.targetConfig.password,
        }).encrypted,
      );

      const sourceConn = firstOrThrow(
        await db
          .insert(schema.connection)
          .values({
            tenantId,
            role: 'source',
            kind: sourceKindFor(body.sourceType),
            displayName: `${body.name} (source)`,
            config: { host: body.sourceConfig.host, port: body.sourceConfig.port, useSsl: body.sourceConfig.useSsl },
            secretRef: sourceSecret,
          })
          .returning({ id: schema.connection.id }),
        'source connection',
      );

      const targetConn = firstOrThrow(
        await db
          .insert(schema.connection)
          .values({
            tenantId,
            role: 'target',
            // targetType values (jmap/imap/caldav/carddav/webdav) are all valid connection kinds.
            kind: body.targetType,
            displayName: `${body.name} (target)`,
            config: { host: body.targetConfig.host, port: body.targetConfig.port, useSsl: body.targetConfig.useSsl },
            secretRef: targetSecret,
          })
          .returning({ id: schema.connection.id }),
        'target connection',
      );

      const sourceMailbox = firstOrThrow(
        await db
          .insert(schema.mailbox)
          .values({ tenantId, connectionId: sourceConn.id, kind: 'user', externalId: 'primary', primaryAddress: body.sourceConfig.username })
          .returning({ id: schema.mailbox.id }),
        'source mailbox',
      );

      const targetMailbox = firstOrThrow(
        await db
          .insert(schema.mailbox)
          .values({ tenantId, connectionId: targetConn.id, kind: 'user', externalId: 'primary', primaryAddress: body.targetConfig.username })
          .returning({ id: schema.mailbox.id }),
        'target mailbox',
      );

      const mapping = firstOrThrow(
        await db
          .insert(schema.mailboxMapping)
          .values({
            tenantId,
            sourceMailboxId: sourceMailbox.id,
            targetMailboxId: targetMailbox.id,
            mode: body.mode ?? 'mirror',
            status: body.status ?? 'active',
            pattern: body.pattern,
            name: body.name,
            schedule: body.syncConfig.schedule,
          })
          .returning(),
        'mapping',
      );

      if (body.syncConfig.domains.length > 0) {
        await db.insert(schema.scopeSelection).values(
          body.syncConfig.domains.map((domain) => ({ tenantId, mappingId: mapping.id, domain, included: true })),
        );
      }

      return mapping;
    });

    res.status(201).json({
      id: created.id,
      tenantId,
      name: created.name,
      sourceType: body.sourceType,
      targetType: body.targetType,
      status: created.status,
      mode: created.mode,
      pattern: created.pattern ?? undefined,
      syncConfig: { domains: body.syncConfig.domains, schedule: created.schedule ?? undefined },
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
    } else {
      console.error('Error creating mapping:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create mapping',
      });
    }
  }
});

/**
 * GET /api/mappings/:mappingId
 * 
 * Get mapping details
 */
router.get('/:mappingId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const mappingId = req.params.mappingId;
    if (!mappingId) {
      res.status(400).json({ error: "mappingId is required" });
      return;
    }
    const tenantId = req.tenantId;

    if (!tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }

    if (!mappingId) {
      res.status(400).json({
        error: 'Bad request',
        message: 'Mapping ID is required',
      });
      return;
    }

    const pool = getSharedPool();

    // Query mapping with RLS enforcement via withTenantDb
    const mappings = await withTenantDb(tenantId, pool, async (db) => {
      return await db
        .select()
        .from(schema.mailboxMapping)
        .where(
          and(
            eq(schema.mailboxMapping.id, mappingId),
            eq(schema.mailboxMapping.tenantId, tenantId)
          )
        );
    });

    if (mappings.length === 0) {
      res.status(404).json({
        error: 'Not found',
        message: 'Mapping not found',
      });
      return;
    }

    const mapping = mappings[0];
    if (!mapping) {
      res.status(404).json({
        error: 'Not found',
        message: 'Mapping not found',
      });
      return;
    }

    res.json({
      id: mapping.id,
      tenant_id: tenantId,
      name: mapping.mode,
      sourceType: 'imap',
      targetType: 'jmap',
      sourceConfig: {
        host: 'imap.example.com',
        port: 993,
        username: 'user@example.com',
        useSsl: true,
      },
      targetConfig: {
        host: 'jmap.example.com',
        port: 443,
        username: 'user@example.com',
        password: '***',
        useSsl: true,
      },
      syncConfig: {
        domains: ['email'],
        schedule: '0 2 * * *',
      },
      status: mapping.status,
      mode: mapping.mode,
      pattern: mapping.pattern,
      lastSyncAt: new Date().toISOString(),
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
    });
  } catch (error) {
    console.error('Error getting mapping:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get mapping',
    });
  }
});

/**
 * PUT /api/mappings/:mappingId
 * 
 * Update mapping configuration
 */
router.put(
  '/:mappingId',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mappingId = req.params.mappingId;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const body = UpdateMappingSchema.parse(req.body);
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      if (!mappingId) {
        res.status(400).json({
          error: 'Bad request',
          message: 'Mapping ID is required',
        });
        return;
      }

      const pool = getSharedPool();

      // Update mapping in database with RLS enforcement via withTenantDb
      // Note: mailbox_mapping has limited fields - we only update what's available
      const updateData: Partial<typeof schema.mailboxMapping.$inferInsert> = {};
      
      // Only update fields that exist in mailbox_mapping table
      // Note: body comes from UpdateMappingSchema which is partial of CreateMappingSchema
      // The actual mailbox_mapping fields are: id, tenant_id, source_mailbox_id, target_mailbox_id, 
      // status, mode, pattern, created_at, updated_at
      // So we need to check for these specific fields
      if ('status' in body && body.status) {
        updateData.status = body.status as 'active' | 'paused' | 'cutover' | 'done';
      }
      if ('mode' in body && body.mode) {
        updateData.mode = body.mode as 'mirror' | 'bidirectional' | 'one_time' | 'asymmetric';
      }
      if ('pattern' in body && body.pattern) {
        updateData.pattern = body.pattern as 'shared_s' | 'distribution_d' | undefined;
      }
      // Note: name, sourceType, targetType, sourceConfig, targetConfig, syncConfig
      // are not direct fields of mailbox_mapping - they would require updating
      // related tables (mailbox, connection, scope_selection, collection_mapping)

      const [updated] = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .update(schema.mailboxMapping)
          .set(updateData)
          .where(
            and(
              eq(schema.mailboxMapping.id, mappingId),
              eq(schema.mailboxMapping.tenantId, tenantId)
            )
          )
          .returning();
      });

      if (!updated) {
        res.status(404).json({
          error: 'Not found',
          message: 'Mapping not found',
        });
        return;
      }

      res.json({
        id: updated.id,
        ...body,
        updatedAt: updated.updatedAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error updating mapping:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to update mapping',
        });
      }
    }
  }
);

/**
 * DELETE /api/mappings/:mappingId
 * 
 * Delete a mapping
 */
router.delete(
  '/:mappingId',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mappingId = req.params.mappingId;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      if (!mappingId) {
        res.status(400).json({
          error: 'Bad request',
          message: 'Mapping ID is required',
        });
        return;
      }

      const pool = getSharedPool();

      // Delete mapping from database with RLS enforcement via withTenantDb
      const [deleted] = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .delete(schema.mailboxMapping)
          .where(
            and(
              eq(schema.mailboxMapping.id, mappingId),
              eq(schema.mailboxMapping.tenantId, tenantId)
            )
          )
          .returning();
      });

      if (!deleted) {
        res.status(404).json({
          error: 'Not found',
          message: 'Mapping not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Mapping deleted successfully',
      });
    } catch (error) {
      console.error('Error deleting mapping:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to delete mapping',
      });
    }
  }
);

/**
 * POST /api/mappings/:mappingId/sync
 * 
 * Trigger a sync for a mapping
 */
router.post(
  '/:mappingId/sync',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { mappingId } = req.params;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const body = TriggerSyncSchema.parse(req.body);
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      // Verify mapping exists and belongs to tenant (RLS enforced via withTenantDb)
      const pool = getSharedPool();
      const mappings = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .select()
          .from(schema.mailboxMapping)
          .where(
            and(
              eq(schema.mailboxMapping.id, mappingId),
              eq(schema.mailboxMapping.tenantId, tenantId)
            )
          );
      });

      if (mappings.length === 0) {
        res.status(404).json({
          error: 'Not found',
          message: 'Mapping not found',
        });
        return;
      }

      // Enqueue the real Trigger.dev task with an id-only, tenant-scoped payload
      // (the mapping was just verified to belong to this tenant above).
      const { taskId, payload } = resolveSyncJob(tenantId, mappingId, body);
      const run = await getTriggerClient().tasks.trigger(taskId, payload, {
        tags: [`tenant:${tenantId}`, `mapping:${mappingId}`],
      });

      res.status(202).json({
        success: true,
        runId: run.id,
        jobType: taskId,
        triggeredAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error triggering sync:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to trigger sync',
        });
      }
    }
  }
);

/**
 * POST /api/mappings/:mappingId/cutover
 * 
 * Trigger cutover for a mapping
 */
router.post(
  '/:mappingId/cutover',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { mappingId } = req.params;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const body = TriggerCutoverSchema.parse(req.body);
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      // Verify mapping exists and belongs to tenant (RLS enforced via withTenantDb)
      const pool = getSharedPool();
      const mappings = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .select()
          .from(schema.mailboxMapping)
          .where(
            and(
              eq(schema.mailboxMapping.id, mappingId),
              eq(schema.mailboxMapping.tenantId, tenantId)
            )
          );
      });

      if (mappings.length === 0) {
        res.status(404).json({
          error: 'Not found',
          message: 'Mapping not found',
        });
        return;
      }

      // Enqueue the real Trigger.dev cutover task (id-only, tenant-scoped payload).
      const { taskId, payload } = resolveCutoverJob(tenantId, mappingId, body);
      const run = await getTriggerClient().tasks.trigger(taskId, payload, {
        tags: [`tenant:${tenantId}`, `mapping:${mappingId}`, 'type:cutover'],
      });

      res.status(202).json({
        success: true,
        runId: run.id,
        triggeredAt: new Date().toISOString(),
        gracePeriodEnd: new Date(Date.now() + body.gracePeriodHours * 3600000).toISOString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error triggering cutover:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to trigger cutover',
        });
      }
    }
  }
);

/**
 * GET /api/mappings/:mappingId/runs
 * 
 * List sync runs for a mapping
 */
router.get(
  '/:mappingId/runs',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mappingId = req.params.mappingId;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      if (!mappingId) {
        res.status(400).json({
          error: 'Bad request',
          message: 'Mapping ID is required',
        });
        return;
      }

      const pool = getSharedPool();

      // Query the real run ledger, RLS-scoped, newest first.
      const runs = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .select()
          .from(schema.run)
          .where(
            and(
              eq(schema.run.mappingId, mappingId),
              eq(schema.run.tenantId, tenantId)
            )
          )
          .orderBy(desc(schema.run.createdAt))
          .limit(50);
      });

      res.json({ runs: runs.map(toApiRun) });
    } catch (error) {
      console.error('Error listing runs:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to list runs',
      });
    }
  }
);

/**
 * GET /api/mappings/:mappingId/runs/:runId
 * 
 * Get run details and logs
 */
router.get(
  '/:mappingId/runs/:runId',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const mappingId = req.params.mappingId;
      if (!mappingId) {
        res.status(400).json({ error: "mappingId is required" });
        return;
      }
      const runId = req.params.runId;
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      if (!mappingId || !runId) {
        res.status(400).json({
          error: 'Bad request',
          message: 'Mapping ID and Run ID are required',
        });
        return;
      }

      const pool = getSharedPool();

      const result = await withTenantDb(tenantId, pool, async (db) => {
        const runs = await db
          .select()
          .from(schema.run)
          .where(
            and(
              eq(schema.run.id, runId),
              eq(schema.run.mappingId, mappingId),
              eq(schema.run.tenantId, tenantId)
            )
          );
        const runRow = runs[0];
        if (!runRow) {
          return null;
        }
        // Its event log (errors surfaced verbatim — hard rule 9 / §11.2).
        const events = await db
          .select({
            level: schema.runEvent.level,
            message: schema.runEvent.message,
            detail: schema.runEvent.detail,
            at: schema.runEvent.at,
          })
          .from(schema.runEvent)
          .where(
            and(
              eq(schema.runEvent.runId, runId),
              eq(schema.runEvent.tenantId, tenantId)
            )
          )
          .orderBy(schema.runEvent.at);
        return { runRow, events };
      });

      if (!result) {
        res.status(404).json({ error: 'Not found', message: 'Run not found' });
        return;
      }

      res.json({
        ...toApiRun(result.runRow),
        events: result.events.map((e) => ({
          level: e.level,
          message: e.message,
          detail: e.detail ?? undefined,
          at: e.at.toISOString(),
        })),
      });
    } catch (error) {
      console.error('Error getting run:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to get run',
      });
    }
  }
);

export default router;
