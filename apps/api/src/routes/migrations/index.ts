/**
 * Migration Management Routes
 * 
 * CRUD operations for migrations, sync triggers, and run history.
 * Integrates with Trigger.dev for job orchestration.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, getDbPool, withTenantDb } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';
import { eq, and } from 'drizzle-orm';
import * as schema from '@openmig/ledger';

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
});

const UpdateMappingSchema = CreateMappingSchema.partial();

const TriggerSyncSchema = z.object({
  type: z.enum(['full', 'delta']),
  forceFullScan: z.boolean().default(false),
});

const TriggerCutoverSchema = z.object({
  skipFinalSync: z.boolean().default(false),
  skipVerification: z.boolean().default(false),
  gracePeriodHours: z.number().default(24),
});

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
        tenantId,
        name: m.mode, // Using mode as name placeholder
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

    // Note: Pool is retrieved for potential future use, but full mapping creation is TODO
    const _pool = getSharedPool();

    // Note: This is a simplified implementation. A real mapping would need:
    // 1. Create source mailbox (or reference existing)
    // 2. Create target mailbox (or reference existing)
    // 3. Create the mailbox_mapping linking them
    // For now, we'll create a minimal mapping record
    
    // TODO: Full mapping creation requires mailbox setup
    // This is a placeholder that creates just the mapping structure
    // In production, this would create connection/mailbox/mapping records
    
    // For now, return a mock response indicating the route is wired but
    // full implementation requires mailbox/connection setup (T3 scope)
    const mockMapping = {
      id: `mapping-${Date.now()}`,
      tenantId,
      name: body.name,
      sourceType: body.sourceType,
      targetType: body.targetType,
      sourceConfig: body.sourceConfig,
      targetConfig: body.targetConfig,
      syncConfig: body.syncConfig,
      status: 'draft',
      mode: 'mirror',
      pattern: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    res.status(201).json(mockMapping);
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
      tenantId,
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

      res.status(204).send();
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
      const { mappingId: _mappingId } = req.params;
      const body = TriggerSyncSchema.parse(req.body);
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      // TODO: Trigger Trigger.dev job
      // This is the T3 scope - wiring the actual job trigger
      // For T2, we just validate the route is protected and return a mock response
      // const job = await triggerClient.trigger({
      //   job: body.type === 'full' ? 'run-full-sync' : 'run-delta-sync',
      //   payload: {
      //     tenantId,
      //     mappingId,
      //     ...(body.type === 'full' && { options: { forceFullScan: body.forceFullScan } }),
      //   },
      // });

      // Mock response - actual trigger will be implemented in T3
      res.json({
        success: true,
        runId: `run-${Date.now()}`,
        jobType: body.type,
        triggeredAt: new Date().toISOString(),
        note: 'Sync trigger is a placeholder - actual Trigger.dev integration in T3',
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
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { mappingId: _mappingId } = req.params;
      const body = TriggerCutoverSchema.parse(req.body);
      const tenantId = req.tenantId;

      if (!tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      // TODO: Trigger Trigger.dev cutover job
      // This is the T3 scope - wiring the actual job trigger
      // For T2, we just validate the route is protected and return a mock response
      // const job = await triggerClient.trigger({
      //   job: 'run-cutover',
      //   payload: {
      //     tenantId,
      //     mappingId,
      //     options: body,
      //   },
      // });

      // Mock response - actual trigger will be implemented in T3
      res.json({
        success: true,
        runId: `run-cutover-${Date.now()}`,
        triggeredAt: new Date().toISOString(),
        gracePeriodEnd: new Date(Date.now() + body.gracePeriodHours * 3600000).toISOString(),
        note: 'Cutover trigger is a placeholder - actual Trigger.dev integration in T3',
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

      // Query runs with RLS enforcement via withTenantDb
      // Note: The actual table is sync_checkpoint, not run
      // This returns mock data for now - full implementation would query the ledger
      const _runs = await withTenantDb(tenantId, pool, async (db) => {
        // For now, return empty array - the actual sync run tracking would need
        // a dedicated runs table or use sync_checkpoint/migration_status
        return await db
          .select()
          .from(schema.syncCheckpoint)
          .where(
            and(
              eq(schema.syncCheckpoint.mappingId, mappingId),
              eq(schema.syncCheckpoint.tenantId, tenantId)
            )
          )
          .limit(50);
      });

      // Return mock run data since we're using sync_checkpoint as placeholder
      res.json({
        runs: [
          {
            id: 'run-1',
            mappingId,
            type: 'full',
            status: 'success',
            startedAt: new Date(Date.now() - 3600000).toISOString(),
            finishedAt: new Date(Date.now() - 3500000).toISOString(),
            itemsProcessed: 1250,
            errors: 0,
          },
          {
            id: 'run-2',
            mappingId,
            type: 'delta',
            status: 'success',
            startedAt: new Date(Date.now() - 86400000).toISOString(),
            finishedAt: new Date(Date.now() - 86300000).toISOString(),
            itemsProcessed: 45,
            errors: 0,
          },
        ],
      });
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

      // Verify the run belongs to this tenant via withTenantDb
      // Note: This is a placeholder - actual run tracking would need a dedicated runs table
      await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .select()
          .from(schema.syncCheckpoint)
          .where(
            and(
              eq(schema.syncCheckpoint.id, runId),
              eq(schema.syncCheckpoint.mappingId, mappingId),
              eq(schema.syncCheckpoint.tenantId, tenantId)
            )
          );
      });

      // Mock response for run details
      res.json({
        id: runId,
        mappingId,
        type: 'full',
        status: 'success',
        startedAt: new Date(Date.now() - 3600000).toISOString(),
        finishedAt: new Date(Date.now() - 3500000).toISOString(),
        itemsProcessed: 1250,
        errors: 0,
        events: [
          {
            level: 'info',
            message: 'Starting full sync',
            at: new Date(Date.now() - 3600000).toISOString(),
          },
          {
            level: 'info',
            message: 'Processed 1250 items',
            at: new Date(Date.now() - 3550000).toISOString(),
          },
          {
            level: 'info',
            message: 'Sync completed successfully',
            at: new Date(Date.now() - 3500000).toISOString(),
          },
        ],
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
