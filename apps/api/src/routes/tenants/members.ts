/**
 * Tenant Members Routes
 * 
 * Manage users within a tenant (invite, remove, update roles).
 * All endpoints require authentication and enforce tenant isolation.
 * 
 * SECURITY: All tenant-data queries use withTenantDb for RLS enforcement.
 * tenant_id is ALWAYS from req.tenantId (authenticated context), never from client input.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole, getDbPool, withTenantDb } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';
import { eq, and, count } from 'drizzle-orm';
import * as schema from '@openmig/ledger';

const router = Router();

// Lazy pool initialization - created on first use, not at module load
let _dbPool: ReturnType<typeof getDbPool> | null = null;
function getSharedPool() {
  if (!_dbPool) {
    _dbPool = getDbPool();
  }
  return _dbPool;
}

// Schema validation
const InviteMemberSchema = z.object({
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

const UpdateMemberRoleSchema = z.object({
  role: z.enum(['owner', 'admin', 'member', 'viewer']),
});

/**
 * GET /api/tenants/:tenantId/members
 * 
 * List all members of a tenant
 */
router.get(
  '/',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId: _tenantId } = req.params;
      const tenantId = req.tenantId;
      
      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
      }

      const members = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.select({
          id: schema.tenantMember.id,
          tenantId: schema.tenantMember.tenantId,
          userId: schema.tenantMember.userId,
          email: schema.tenantMember.email,
          role: schema.tenantMember.role,
          status: schema.tenantMember.status,
          invitedAt: schema.tenantMember.invitedAt,
          joinedAt: schema.tenantMember.joinedAt,
          createdAt: schema.tenantMember.createdAt,
          updatedAt: schema.tenantMember.updatedAt,
        })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.tenantId, tenantId));
      });

      res.json({ members });
    } catch (error) {
      console.error('Error listing members:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to list members',
      });
    }
  }
);

/**
 * POST /api/tenants/:tenantId/members
 * 
 * Invite a new member to the tenant
 */
router.post(
  '/',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId: _tenantId } = req.params;
      const tenantId = req.tenantId;
      const body = InviteMemberSchema.parse(req.body);

      if (!tenantId) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'Tenant ID not found in authentication context',
        });
      }

      const [newMember] = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.insert(schema.tenantMember).values({
          tenantId,
          userId: req.userId || 'pending-invite',
          email: body.email,
          role: body.role,
          status: 'invited',
          invitedAt: new Date(),
        }).returning();
      });

      res.status(201).json(newMember);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error inviting member:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to invite member',
        });
      }
    }
  }
);

/**
 * GET /api/tenants/:tenantId/members/:memberId
 * 
 * Get member details
 */
router.get(
  '/:memberId',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { memberId } = req.params;
      const tenantId = req.tenantId;
      
      if (!tenantId || !memberId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Tenant ID and member ID required',
        });
      }

      const members = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.select({
          id: schema.tenantMember.id,
          tenantId: schema.tenantMember.tenantId,
          userId: schema.tenantMember.userId,
          email: schema.tenantMember.email,
          role: schema.tenantMember.role,
          status: schema.tenantMember.status,
          invitedAt: schema.tenantMember.invitedAt,
          joinedAt: schema.tenantMember.joinedAt,
          createdAt: schema.tenantMember.createdAt,
          updatedAt: schema.tenantMember.updatedAt,
        })
        .from(schema.tenantMember)
        .where(
          and(
            eq(schema.tenantMember.id, memberId),
            eq(schema.tenantMember.tenantId, tenantId),
          )
        );
      });

      if (members.length === 0) {
        res.status(404).json({
          error: 'Not found',
          message: 'Member not found',
        });
        return;
      }

      res.json(members[0]);
    } catch (error) {
      console.error('Error getting member:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to get member',
      });
    }
  }
);

/**
 * PATCH /api/tenants/:tenantId/members/:memberId
 * 
 * Update member role
 */
router.patch(
  '/:memberId',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { memberId } = req.params;
      const tenantId = req.tenantId;
      const body = UpdateMemberRoleSchema.parse(req.body);

      if (!tenantId || !memberId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Tenant ID and member ID required',
        });
      }

      // Prevent demoting the last owner
      const ownerCount = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        const result = await db.select({ count: count() })
          .from(schema.tenantMember)
          .where(
            and(
              eq(schema.tenantMember.tenantId, tenantId),
              eq(schema.tenantMember.role, 'owner'),
            )
          );
        return result[0]?.count ?? 0;
      });

      if (body.role === 'owner' && ownerCount === 0) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot remove the last owner',
        });
        return;
      }

      const [updatedMember] = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.update(schema.tenantMember)
          .set({ role: body.role, updatedAt: new Date() })
          .where(
            and(
              eq(schema.tenantMember.id, memberId),
              eq(schema.tenantMember.tenantId, tenantId),
            )
          )
          .returning();
      });

      if (!updatedMember) {
        res.status(404).json({
          error: 'Not found',
          message: 'Member not found',
        });
        return;
      }

      res.json({
        id: updatedMember.id,
        tenantId: updatedMember.tenantId,
        role: updatedMember.role,
        updatedAt: updatedMember.updatedAt,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation error',
          details: error.errors,
        });
      } else {
        console.error('Error updating member:', error);
        res.status(500).json({
          error: 'Internal server error',
          message: 'Failed to update member',
        });
      }
    }
  }
);

/**
 * DELETE /api/tenants/:tenantId/members/:memberId
 * 
 * Remove a member from the tenant
 */
router.delete(
  '/:memberId',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { memberId } = req.params;
      const tenantId = req.tenantId;
      
      if (!tenantId || !memberId) {
        return res.status(400).json({
          error: 'Bad Request',
          message: 'Tenant ID and member ID required',
        });
      }

      // Get the member's role first
      const memberData = await withTenantDb(tenantId, getSharedPool(), async (db) => {
        return await db.select({ role: schema.tenantMember.role })
          .from(schema.tenantMember)
          .where(
            and(
              eq(schema.tenantMember.id, memberId),
              eq(schema.tenantMember.tenantId, tenantId),
            )
          );
      });

      if (!memberData || memberData.length === 0) {
        res.status(404).json({
          error: 'Not found',
          message: 'Member not found',
        });
        return;
      }

      const memberRole = memberData[0]!.role;

      // Prevent removing the last owner
      if (memberRole === 'owner') {
        const ownerCount = await withTenantDb(tenantId, getSharedPool(), async (db) => {
          const result = await db.select({ count: count() })
            .from(schema.tenantMember)
            .where(
              and(
                eq(schema.tenantMember.tenantId, tenantId),
                eq(schema.tenantMember.role, 'owner'),
              )
            );
          return result[0]?.count ?? 0;
        });

        if (ownerCount === 1) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'Cannot remove the last owner',
          });
          return;
        }
      }

      // Prevent removing yourself
      if (req.userId === memberId) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot remove yourself from the tenant',
        });
        return;
      }

      await withTenantDb(tenantId, getSharedPool(), async (db) => {
        await db.delete(schema.tenantMember)
          .where(
            and(
              eq(schema.tenantMember.id, memberId),
              eq(schema.tenantMember.tenantId, tenantId),
            )
          );
      });

      res.status(204).send();
    } catch (error) {
      console.error('Error removing member:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to remove member',
      });
    }
  }
);

export default router;
