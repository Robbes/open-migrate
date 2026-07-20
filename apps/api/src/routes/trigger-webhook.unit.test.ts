// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Regression tests for the Trigger.dev webhook signature verification
 * (review findings #2 auth-bypass and #4 timingSafeEqual crash).
 */

import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifySignature } from './trigger-webhook';

const SECRET = 'test-webhook-secret';
const PAYLOAD = JSON.stringify({ id: 'run_1', run: { status: 'success' } });

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifySignature (findings #2/#4)', () => {
  it('accepts a correct signature', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, 'other-secret'), SECRET)).toBe(false);
  });

  it('rejects a signature over a different payload', () => {
    expect(verifySignature(PAYLOAD, sign('{"tampered":true}', SECRET), SECRET)).toBe(false);
  });

  it('returns false (does not throw) on a wrong-length / malformed signature (#4)', () => {
    // A short hex string produces a buffer shorter than the 32-byte digest;
    // timingSafeEqual would throw on mismatched lengths if not guarded.
    expect(() => verifySignature(PAYLOAD, 'deadbeef', SECRET)).not.toThrow();
    expect(verifySignature(PAYLOAD, 'deadbeef', SECRET)).toBe(false);
    // Non-hex garbage must also be rejected without throwing.
    expect(() => verifySignature(PAYLOAD, 'not-hex-at-all', SECRET)).not.toThrow();
    expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
  });
});
