// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Regression test for the 401 handler: it must clear ALL auth state (the raw
 * `auth_token` key AND the zustand-persisted store), so `isAuthenticated` never
 * stays stale after an unauthorized response.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { onUnauthorized } from './api';
import { useAuthStore } from '../stores/auth-store';

describe('onUnauthorized (401 handler)', () => {
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.getState().logout();
    // Replace jsdom's location with a plain stub so the redirect just sets a
    // property (jsdom otherwise logs "Not implemented: navigation").
    Object.defineProperty(globalThis, 'location', {
      value: { href: '' },
      writable: true,
      configurable: true,
    });
  });

  it('clears both the raw token and the persisted auth store', () => {
    // Simulate a logged-in session (login writes auth_token + persists state).
    useAuthStore.getState().login('jwt-token', { id: 'u1', email: 'u@x.io', name: 'U', role: 'admin' }, 't1');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem('auth_token')).toBe('jwt-token');

    onUnauthorized();

    // Raw token key cleared…
    expect(localStorage.getItem('auth_token')).toBeNull();
    // …AND the store reset (no stale isAuthenticated/token).
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(false);
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(s.tenantId).toBeNull();
  });
});
