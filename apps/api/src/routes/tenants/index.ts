/**
 * Tenant Management Routes
 * 
 * CRUD operations for tenants and their members.
 * All endpoints require authentication and enforce tenant isolation.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, getDbPool, withTenantDb } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';
import { eq } from 'drizzle-orm';
import * as schema from '@openmig/ledger';

const router = Router();

// Global pool - created once and reused
// In production, this should be a singleton or dependency-injected
let _dbPool: ReturnType<typeof getDbPool> | null = null;
function getSharedPool() {
  if (!_dbPool) {
    _dbPool = getDbPool();
  }
  return _dbPool;
}

// Schema validation
const CreateTenantSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  settings: z.object({
    maxMappings: z.number().default(10),
    maxUsers: z.number().default(5),
  }).optional(),
});

const UpdateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  settings: z.object({
    maxMappings: z.number().optional(),
    maxUsers: z.number().optional(),
  }).optional(),
});

const _InviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

const _UpdateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

/**
 * GET /api/tenants
 * 
 * List all tenants for the authenticated user
 */
router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pool = getSharedPool();
    
    // Use withTenant to enforce RLS - tenant context is set automatically
    const tenants = await withTenantDb(req.tenantId, pool, async (db) => {
      return await db.select().from(schema.tenant);
    });

    res.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.settings?.slug || t.name.toLowerCase().replace(/\s+/g, '-'),
        createdAt: t.createdAt,
      })),
    });
  } catch (error) {
    console.error('Error listing tenants:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to list tenants',
    });
  }
});

/**
 * POST /api/tenants
 * 
 * Create a new tenant
 */
router.post('/', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const body = CreateTenantSchema.parse(req.body);

    // TODO: Create tenant in database
    // const tenant = await db.insert(tenant).values({
    //   name: body.name,
    //   slug: body.slug,
    //   ownerId: req.userId,
    //   settings: body.settings,
    // }).returning();

    // Mock response for now
    const newTenant = {
      id: `tenant-${Date.now()}`,
      name: body.name,
      slug: body.slug,
      ownerId: req.userId,
      settings: body.settings,
      createdAt: new Date().toISOString(),
    };

    res.status(201).json(newTenant);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
    } else {
      console.error('Error creating tenant:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to create tenant',
      });
    }
  }
});

/**
 * GET /api/tenants/:tenantId
 * 
 * Get tenant details
 */
router.get('/:tenantId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tenantId } = req.params;
    const pool = getSharedPool();

    // Use withTenant to enforce RLS - this proves tenant isolation end-to-end
    const tenants = await withTenantDb(req.tenantId, pool, async (db) => {
      return await db.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
    });

    if (tenants.length === 0) {
      res.status(404).json({
        error: 'Not found',
        message: 'Tenant not found',
      });
      return;
    }

    const tenant = tenants[0];
    res.json({
      id: tenant.id,
      name: tenant.name,
      slug: tenant.settings?.slug || tenant.name.toLowerCase().replace(/\s+/g, '-'),
      settings: tenant.settings,
      createdAt: tenant.createdAt,
    });
  } catch (error) {
    console.error('Error getting tenant:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to get tenant',
    });
  }
});

/**
 * PUT /api/tenants/:tenantId
 * 
 * Update tenant settings
 */
router.put(
  '/:tenantId',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId } = req.params;
      const body = UpdateTenantSchema.parse(req.body);

      // TODO: Update tenant in database
      // await db.update(tenant)
      //   .set(body)
      //   .where(eq(tenant.id, tenantId));

      res.json({
        id: tenantId,
        ...body,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error updating tenant:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to update tenant',
        });
      }
    }
  }
);

/**
 * DELETE /api/tenants/:tenantId
 * 
 * Delete a tenant (owner only)
 */
router.delete(
  '/:tenantId',
  authenticate,
  requireRole('owner'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId: _tenantId } = req.params;

      // TODO: Delete tenant from database
      // await db.delete(tenant).where(eq(tenant.id, tenantId));

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting tenant:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to delete tenant',
      });
    }
  }
);

export default router;
