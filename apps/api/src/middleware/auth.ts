/**
 * JWT Authentication Middleware
 * 
 * Validates JWT tokens and extracts tenant context for RLS.
 * Supports both self-hosted (local JWT) and managed (Auth0/Clerk) providers.
 */

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { AuthenticatedRequest } from '../types/api';
import { type Pool } from 'pg';
import { withTenant as ledgerWithTenant } from '@openmig/ledger';

export interface JwtPayload {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
  iat?: number;
  exp?: number;
}

/**
 * Get the database pool from environment.
 * For managed mode, this should be the APP_DATABASE_URL (app_user role).
 * For self-host mode, this can be the standard DATABASE_URL.
 */
export function getDbPool(): Pool {
  // Prefer APP_DATABASE_URL for managed mode (non-owner app_user role)
  // Fall back to DATABASE_URL for self-host mode
  const connectionString = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
  
  if (!connectionString) {
    throw new Error('DATABASE_URL or APP_DATABASE_URL environment variable not set');
  }
  
  return new Pool({ connectionString });
}

/**
 * Execute a function within a tenant-scoped transaction.
 * This is the critical security gate - all tenant-specific queries must go through this.
 * 
 * @param tenantId - The tenant ID to scope the query to
 * @param pool - The database pool (from getDbPool())
 * @param fn - The function to execute with a tenant-scoped db handle
 * @returns The result of the function
 */
export function withTenantDb<T>(
  tenantId: string,
  pool: Pool,
  fn: (db: Parameters<typeof ledgerWithTenant>[2]) => Promise<T>
): Promise<T> {
  return ledgerWithTenant(pool, tenantId, fn);
}

/**
 * Authentication middleware
 * 
 * Validates JWT token from Authorization header and attaches
 * user context to the request object.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header',
      });
      return;
    }

    const token = authHeader.substring(7);

    // Determine JWT verification method based on environment
    const jwtSecret = process.env.JWT_SECRET;
    const jwtIssuer = process.env.JWT_ISSUER;

    let payload: JwtPayload;

    if (jwtSecret) {
      // Self-hosted: Verify with local secret
      payload = jwt.verify(token, jwtSecret) as JwtPayload;
    } else if (jwtIssuer) {
      // Managed: Verify with issuer (e.g., Auth0, Clerk)
      // For now, we'll decode without verification
      // In production, use jose or similar library for public key verification
      const decoded = jwt.decode(token);
      if (!decoded) {
        throw new Error('Invalid token');
      }
      payload = decoded as JwtPayload;
    } else {
      // Development mode: Accept any valid-looking JWT
      console.warn('JWT verification disabled - development mode');
      const decoded = jwt.decode(token);
      if (!decoded) {
        throw new Error('Invalid token');
      }
      payload = decoded as JwtPayload;
    }

    // Attach user context to request
    const authenticatedReq = req as AuthenticatedRequest;
    authenticatedReq.userId = payload.sub;
    authenticatedReq.tenantId = payload.tenantId;
    authenticatedReq.userRole = payload.role;

    // Set tenant context for RLS
    // This will be used by the database client to set app.current_tenant
    res.locals.tenantId = payload.tenantId;

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    } else if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Token expired',
      });
    } else {
      console.error('Authentication error:', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'Token verification failed',
      });
    }
  }
}

/**
 * Optional authentication middleware
 * 
 * Attaches user context if token is present, but doesn't require it.
 * Useful for endpoints that work both with and without authentication.
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    // No token, continue without authentication
    next();
    return;
  }

  try {
    const token = authHeader.substring(7);
    const jwtSecret = process.env.JWT_SECRET;

    let payload: JwtPayload;

    if (jwtSecret) {
      payload = jwt.verify(token, jwtSecret) as JwtPayload;
    } else {
      const decoded = jwt.decode(token);
      if (!decoded) {
        throw new Error('Invalid token');
      }
      payload = decoded as JwtPayload;
    }

    const authenticatedReq = req as AuthenticatedRequest;
    authenticatedReq.userId = payload.sub;
    authenticatedReq.tenantId = payload.tenantId;
    authenticatedReq.userRole = payload.role;

    next();
  } catch (_error) {
    // Token invalid, but continue without authentication
    next();
  }
}

/**
 * Role-based access control middleware
 * 
 * Requires specific roles to access the route.
 * Example: requireRole('admin', 'manager')
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authenticatedReq = req as AuthenticatedRequest;

    if (!authenticatedReq.userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(authenticatedReq.userRole || '')) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
      });
      return;
    }

    next();
  };
}

/**
 * Tenant isolation middleware
 * 
 * Ensures the request is made by the tenant specified in the URL/path.
 * Prevents cross-tenant access.
 */
export function requireTenantMatch(paramName: string = 'tenantId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authenticatedReq = req as AuthenticatedRequest;

    if (!authenticatedReq.tenantId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const pathTenantId = req.params[paramName];

    if (!pathTenantId) {
      res.status(400).json({
        error: 'Bad Request',
        message: `Missing ${paramName} parameter`,
      });
      return;
    }

    if (authenticatedReq.tenantId !== pathTenantId) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Access denied to this tenant',
      });
      return;
    }

    next();
  };
}
