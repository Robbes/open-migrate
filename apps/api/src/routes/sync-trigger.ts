/**
 * Sync Trigger Routes
 *
 * API endpoints for triggering sync jobs via Trigger.dev.
 * All endpoints require authentication and enforce tenant isolation.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';

import { withTenantDb } from '../middleware/auth';
import type { AuthenticatedRequest } from '../types/api';
import * as schema from '@openmig/ledger/src/schema-pg';
import { getTriggerClient } from '@openmig/scheduler';

const router = Router();

/**
 * POST /api/mappings/:mappingId/sync
 *
 * Trigger a full sync for a mapping.
 * 
 * Authentication: Required
 * Authorization: Only the mapping's owner tenant can trigger
 * 
 * Request:
 *   - tenantId: from authenticated context
 *   - mappingId: from URL parameter
 * 
 * Response:
 *   {
 *     success: boolean,
 *     runId: string,      // Trigger.dev run ID
 *     mappingId: string,
 *     tenantId: string,
 *     startedAt: string
 *   }
 * 
 * Security:
 *   - Authenticates request
 *   - Verifies mapping belongs to tenant via withTenantDb
 *   - Enqueues job with { tenantId, mappingId } payload
 *   - Client CANNOT trigger for another tenant's mapping
 */
router.post('/mappings/:mappingId/sync', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const mappingId = req.params.mappingId;
    const tenantId = req.tenantId;

    // Validate inputs
    if (!tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!mappingId) {
      res.status(400).json({ error: 'mappingId is required' });
      return;
    }

    // Get database pool
    const pool = req.app.get('db') as Pool;
    if (!pool) {
      res.status(500).json({ error: 'Database not configured' });
      return;
    }

    // SECURITY: Verify mapping belongs to this tenant (RLS-enforced)
    const mappings = await withTenantDb(tenantId, pool, async (db) => {
      return await db
        .select()
        .from(schema.mailboxMapping)
        .where(eq(schema.mailboxMapping.id, mappingId));
    });

    if (mappings.length === 0) {
      // Mapping doesn't exist OR tenant doesn't have access
      // Return 404 to avoid tenant enumeration
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    // Mapping verified to exist and belong to this tenant
    // (We use mappingId directly, no need to destructure)
    const _mapping = mappings[0]!;

    // Trigger the job via Trigger.dev
    const triggerClient = getTriggerClient();
    
    if (!triggerClient) {
      res.status(500).json({ 
        error: 'Trigger.dev not configured',
        message: 'TRIGGER_DEV_ACCESS_TOKEN and TRIGGER_DEV_BASE_URL must be set'
      });
      return;
    }

    // Enqueue the job with tenant-scoped payload
    // The job will use tenantId to enforce RLS
    const run = await triggerClient.tasks.trigger(
      'run-full-sync',
      {
        tenantId,           // From authenticated context - cannot be spoofed
        mappingId,          // Verified above to belong to this tenant
        options: {
          forceFullScan: true,
        },
      },
      {
        tags: [`tenant:${tenantId}`, `mapping:${mappingId}`, 'domain:email'],
      }
    );

    console.log('Full sync triggered:', {
      runId: run.id,
      tenantId,
      mappingId,
    });

    res.json({
      success: true,
      runId: run.id,
      mappingId,
      tenantId,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error triggering full sync:', error);
    res.status(500).json({
      error: 'Failed to trigger sync',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/mappings/:mappingId/delta-sync
 *
 * Trigger a delta sync for a mapping.
 * 
 * Authentication: Required
 * Authorization: Only the mapping's owner tenant can trigger
 * 
 * Similar to full sync but uses stored cursors for incremental sync.
 */
router.post('/mappings/:mappingId/delta-sync', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const mappingId = req.params.mappingId;
    const tenantId = req.tenantId;

    // Validate inputs
    if (!tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!mappingId) {
      res.status(400).json({ error: 'mappingId is required' });
      return;
    }

    // Get database pool
    const pool = req.app.get('db') as Pool;
    if (!pool) {
      res.status(500).json({ error: 'Database not configured' });
      return;
    }

    // SECURITY: Verify mapping belongs to this tenant (RLS-enforced)
    const mappings = await withTenantDb(tenantId, pool, async (db) => {
      return await db
        .select()
        .from(schema.mailboxMapping)
        .where(eq(schema.mailboxMapping.id, mappingId));
    });

    if (mappings.length === 0) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    // Mapping verified to exist and belong to this tenant
    const _mapping = mappings[0]!;

    // Trigger the job via Trigger.dev
    const triggerClient = getTriggerClient();
    
    if (!triggerClient) {
      res.status(500).json({ 
        error: 'Trigger.dev not configured',
        message: 'TRIGGER_DEV_ACCESS_TOKEN and TRIGGER_DEV_BASE_URL must be set'
      });
      return;
    }

    // Enqueue the job with tenant-scoped payload
    const run = await triggerClient.tasks.trigger(
      'run-delta-sync',
      {
        tenantId,           // From authenticated context - cannot be spoofed
        mappingId,          // Verified above to belong to this tenant
        domains: ['email'], // Default to email domain
      },
      {
        tags: [`tenant:${tenantId}`, `mapping:${mappingId}`, 'domain:email', 'type:delta'],
      }
    );

    console.log('Delta sync triggered:', {
      runId: run.id,
      tenantId,
      mappingId,
    });

    res.json({
      success: true,
      runId: run.id,
      mappingId,
      tenantId,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error triggering delta sync:', error);
    res.status(500).json({
      error: 'Failed to trigger sync',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
