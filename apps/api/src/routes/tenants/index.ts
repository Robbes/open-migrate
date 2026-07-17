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
    const tenantId = req.tenantId;
    if (!tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }
    
    const pool = getSharedPool();
    
    // Use withTenant to enforce RLS - tenant context is set automatically
    const tenants = await withTenantDb(tenantId, pool, async (db) => {
      return await db.select().from(schema.tenant);
    });

    res.json({
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        slug: (t.settings as Record<string, unknown>)?.slug || t.name.toLowerCase().replace(/\s+/g, '-'),
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
    const tenantId = req.tenantId;

    if (!tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }

    const pool = getSharedPool();

    // Create tenant in database with RLS enforcement via withTenantDb
    const [newTenant] = await withTenantDb(tenantId, pool, async (db) => {
      return await db.insert(schema.tenant).values({
        name: body.name,
        status: 'active',
        settings: body.settings || {
          maxMappings: 10,
          maxUsers: 5,
        },
      }).returning();
    });

    if (!newTenant) {
      res.status(500).json({
        error: 'Database error',
        message: 'Failed to create tenant',
      });
      return;
    }

    res.status(201).json({
      id: newTenant.id,
      name: newTenant.name,
      slug: (newTenant.settings as Record<string, unknown>)?.slug || body.slug,
      ownerId: req.userId,
      settings: newTenant.settings,
      createdAt: newTenant.createdAt,
    });
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
    
    // Check that the authenticated user has a tenant context
    if (!req.tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Tenant ID not found in authentication context',
      });
      return;
    }
    
    const pool = getSharedPool();

    // Use withTenant to enforce RLS - this proves tenant isolation end-to-end
    // tenantId from params is guaranteed to be a string (it's a required path parameter)
    const tenants = await withTenantDb(req.tenantId, pool, async (db) => {
      return await db.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId!));
    });

    if (tenants.length === 0) {
      res.status(404).json({
        error: 'Not found',
        message: 'Tenant not found',
      });
      return;
    }

    const tenant = tenants[0];
    if (!tenant) {
      res.status(404).json({
        error: 'Not found',
        message: 'Tenant not found',
      });
      return;
    }
    
    res.json({
      id: tenant.id,
      name: tenant.name,
      slug: (tenant.settings as Record<string, unknown>)?.slug || tenant.name.toLowerCase().replace(/\s+/g, '-'),
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
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = UpdateTenantSchema.parse(req.body);
      
      if (!req.tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      const tenantId = req.tenantId;
      const pool = getSharedPool();

      // Update tenant in database with RLS enforcement via withTenantDb
      const [updatedTenant] = await withTenantDb(tenantId, pool, async (db) => {
        const updateData: Partial<typeof schema.tenant.$inferInsert> = {};
        if (body.name) {
          updateData.name = body.name;
        }
        if (body.settings) {
          updateData.settings = body.settings;
        }
        
        return await db
          .update(schema.tenant)
          .set(updateData)
          .where(eq(schema.tenant.id, tenantId))
          .returning();
      });

      if (!updatedTenant) {
        res.status(404).json({
          error: 'Not found',
          message: 'Tenant not found',
        });
        return;
      }

      res.json({
        id: updatedTenant.id,
        name: updatedTenant.name,
        slug: (updatedTenant.settings as Record<string, unknown>)?.slug || updatedTenant.name.toLowerCase().replace(/\s+/g, '-'),
        settings: updatedTenant.settings,
        updatedAt: updatedTenant.createdAt, // Note: schema doesn't have updatedAt yet
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
      if (!req.tenantId) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
        return;
      }

      const tenantId = req.tenantId;
      const pool = getSharedPool();

      // Delete tenant from database with RLS enforcement via withTenantDb
      const [deleted] = await withTenantDb(tenantId, pool, async (db) => {
        return await db
          .delete(schema.tenant)
          .where(eq(schema.tenant.id, tenantId))
          .returning();
      });

      if (!deleted) {
        res.status(404).json({
          error: 'Not found',
          message: 'Tenant not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Tenant deleted successfully',
      });
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
