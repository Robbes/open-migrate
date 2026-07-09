/**
 * Tenant Members Routes
 * 
 * Manage users within a tenant (invite, remove, update roles).
 * All endpoints require authentication and enforce tenant isolation.
 */

import { Router } from 'express';
import type { Response } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import type { AuthenticatedRequest } from '../../types/api';

const router = Router();

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
  '/:tenantId/members',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId: _tenantId } = req.params;

      // TODO: Query database for tenant members
      // const members = await db.query.tenantMember.findMany({
      //   where: eq(tenantMember.tenantId, tenantId),
      //   with: {
      //     user: true,
      //   },
      // });

      // Mock response
      res.json({
        members: [
          {
            id: 'member-1',
            userId: 'user-1',
            email: 'owner@example.com',
            role: 'owner',
            invitedAt: new Date().toISOString(),
          },
          {
            id: 'member-2',
            userId: 'user-2',
            email: 'admin@example.com',
            role: 'admin',
            invitedAt: new Date().toISOString(),
          },
        ],
      });
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
  '/:tenantId/members',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId } = req.params;
      const body = InviteMemberSchema.parse(req.body);

      // TODO: Create tenant member invitation
      // const member = await db.insert(tenantMember).values({
      //   tenantId,
      //   email: body.email,
      //   role: body.role,
      //   status: 'pending',
      // }).returning();

      // Mock response
      const newMember = {
        id: `member-${Date.now()}`,
        tenantId,
        email: body.email,
        role: body.role,
        status: 'pending',
        invitedAt: new Date().toISOString(),
        invitedBy: req.userId,
      };

      // TODO: Send invitation email
      // await sendInvitationEmail({
      //   to: body.email,
      //   tenantName: 'Demo Tenant',
      //   invitedBy: req.userId,
      // });

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
  '/:tenantId/members/:memberId',
  authenticate,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId, memberId } = req.params;

      // TODO: Query database
      // const member = await db.query.tenantMember.findFirst({
      //   where: and(
      //     eq(tenantMember.id, memberId),
      //     eq(tenantMember.tenantId, tenantId),
      //   ),
      // });

      // Mock response
      res.json({
        id: memberId,
        tenantId,
        email: 'member@example.com',
        role: 'member',
        status: 'active',
        invitedAt: new Date().toISOString(),
        joinedAt: new Date().toISOString(),
      });
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
  '/:tenantId/members/:memberId',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId, memberId } = req.params;
      const body = UpdateMemberRoleSchema.parse(req.body);

      // Prevent demoting the last owner
      // TODO: Check if this is the last owner
      // const ownerCount = await db.select({ count: count() })
      //   .from(tenantMember)
      //   .where(and(
      //     eq(tenantMember.tenantId, tenantId),
      //     eq(tenantMember.role, 'owner'),
      //   ));

      // if (body.role === 'owner' && ownerCount[0].count === 0) {
      //   throw new Error('Cannot remove the last owner');
      // }

      // TODO: Update member role
      // await db.update(tenantMember)
      //   .set({ role: body.role })
      //   .where(and(
      //     eq(tenantMember.id, memberId),
      //     eq(tenantMember.tenantId, tenantId),
      //   ));

      res.json({
        id: memberId,
        tenantId,
        role: body.role,
        updatedAt: new Date().toISOString(),
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
  '/:tenantId/members/:memberId',
  authenticate,
  requireRole('owner', 'admin'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tenantId: _tenantId, memberId } = req.params;

      // Prevent removing the last owner
      if (req.userId === memberId) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Cannot remove yourself from the tenant',
        });
        return;
      }

      // TODO: Delete member from database
      // await db.delete(tenantMember)
      //   .where(and(
      //     eq(tenantMember.id, memberId),
      //     eq(tenantMember.tenantId, tenantId),
      //   ));

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
