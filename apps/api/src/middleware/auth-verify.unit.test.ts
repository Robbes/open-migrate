// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Tests for the auth middleware's verification wiring (review findings):
 *  - selectAuthMode: managed JWKS wins over a symmetric JWT_SECRET.
 *  - authenticate: self-host HS256 accept / reject / expired-message path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate, selectAuthMode } from './auth';

const SECRET = 'unit-test-secret';

function claims(overrides: Record<string, unknown> = {}) {
  return { sub: 'user-1', tenantId: 'tenant-1', role: 'admin', email: 'u@example.com', ...overrides };
}

function mockRes() {
  const res = { locals: {} } as unknown as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn().mockImplementation((code: number) => {
    (res as { statusCode?: number }).statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn().mockImplementation((b: unknown) => {
    (res as { body?: unknown }).body = b;
    return res;
  }) as unknown as Response['json'];
  return res;
}

function reqWith(token?: string): Request {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as Request;
}

describe('selectAuthMode (precedence)', () => {
  it('prefers the managed JWKS path when JWT_ISSUER is set, even if JWT_SECRET is also set', () => {
    expect(selectAuthMode('https://issuer.example/', SECRET)).toBe('managed');
    expect(selectAuthMode('https://issuer.example/', undefined)).toBe('managed');
  });
  it('uses the local secret only when no issuer is configured', () => {
    expect(selectAuthMode(undefined, SECRET)).toBe('local');
  });
  it('falls back to dev when neither is configured', () => {
    expect(selectAuthMode(undefined, undefined)).toBe('dev');
  });
});

describe('authenticate (self-host HS256)', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
    delete process.env.JWT_ISSUER;
  });
  afterEach(() => {
    delete process.env.JWT_SECRET;
    vi.restoreAllMocks();
  });

  it('accepts a valid token and attaches the tenant context', async () => {
    const token = jwt.sign(claims(), SECRET, { algorithm: 'HS256' });
    const req = reqWith(token);
    const res = mockRes();
    const next = vi.fn();

    await authenticate(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect((req as unknown as { tenantId?: string }).tenantId).toBe('tenant-1');
    expect((req as unknown as { userRole?: string }).userRole).toBe('admin');
  });

  it('rejects an expired token with a distinct "Token expired" message', async () => {
    const token = jwt.sign(claims(), SECRET, { algorithm: 'HS256', expiresIn: '-1s' });
    const res = mockRes();
    const next = vi.fn();

    await authenticate(reqWith(token), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res as { body?: { message?: string } }).body?.message).toBe('Token expired');
  });

  it('rejects a tampered token as Invalid token', async () => {
    const token = jwt.sign(claims(), SECRET, { algorithm: 'HS256' });
    const tampered = `${token.split('.').slice(0, 2).join('.')}.deadbeef`;
    const res = mockRes();
    const next = vi.fn();

    await authenticate(reqWith(tampered), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect((res as { body?: { message?: string } }).body?.message).toBe('Invalid token');
  });

  it('rejects a missing Authorization header', async () => {
    const res = mockRes();
    const next = vi.fn();

    await authenticate(reqWith(undefined), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
