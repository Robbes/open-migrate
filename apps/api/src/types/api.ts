/**
 * Shared API Types
 *
 * Type definitions used across the API server.
 * Placed in a separate file to avoid circular dependencies.
 */

import type { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  tenantId?: string;
  userId?: string;
  userRole?: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
  iat?: number;
  exp?: number;
}
