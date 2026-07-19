// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Login, { decodeTokenClaims } from '../pages/Login';
import { useAuthStore } from '../stores/auth-store';

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

// Build a JWT with the given payload (header/signature are cosmetic — the app
// only decodes the payload; the API verifies the real signature).
function makeToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const renderLogin = () =>
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>
  );

describe('decodeTokenClaims', () => {
  it('returns claims for a well-formed token', () => {
    const token = makeToken({ sub: 'u1', email: 'a@b.c', tenantId: 't1', role: 'owner' });
    expect(decodeTokenClaims(token)).toEqual({
      sub: 'u1',
      email: 'a@b.c',
      tenantId: 't1',
      role: 'owner',
    });
  });

  it('rejects tokens missing required claims', () => {
    expect(decodeTokenClaims(makeToken({ sub: 'u1' }))).toBeNull();
    expect(decodeTokenClaims('not-a-jwt')).toBeNull();
  });
});

describe('Login', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    useAuthStore.getState().logout();
    localStorage.clear();
  });

  it('signs in with a valid token: stores auth context and navigates', async () => {
    const user = userEvent.setup();
    const token = makeToken({ sub: 'u1', email: 'owner-a@demo.test', tenantId: 'tenant-a', role: 'owner' });

    renderLogin();
    await user.type(screen.getByLabelText(/access token/i), token);
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.tenantId).toBe('tenant-a');
    expect(state.user?.email).toBe('owner-a@demo.test');
    expect(state.token).toBe(token);
    expect(localStorage.getItem('auth_token')).toBe(token);
    expect(navigateMock).toHaveBeenCalledWith('/dashboard');
  });

  it('rejects an invalid token and does not sign in', async () => {
    const user = userEvent.setup();

    renderLogin();
    await user.type(screen.getByLabelText(/access token/i), 'garbage');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
