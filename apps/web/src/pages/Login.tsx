// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { useAuthStore } from '../stores/auth-store';

interface TokenClaims {
  sub: string;
  email: string;
  tenantId: string;
  role: string;
}

/**
 * Decode a JWT payload (no verification — the API verifies the signature on
 * every request). Returns the tenant/user claims the app needs, or null if the
 * token is malformed or missing required claims.
 */
export function decodeTokenClaims(token: string): TokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '='));
    const claims = JSON.parse(json) as Partial<TokenClaims>;
    if (!claims.sub || !claims.email || !claims.tenantId || !claims.role) return null;
    return claims as TokenClaims;
  } catch {
    return null;
  }
}

/**
 * Managed-edition sign-in. There is no password endpoint yet (SSO via
 * Zitadel/Keycloak is a later slice — SAD §7.3); until then the operator signs
 * in with an access token issued by the seed script or an IdP. The token is
 * stored and sent as `Authorization: Bearer` on every API call, where it is
 * signature-verified server-side.
 */
const Login: React.FC = () => {
  const navigate = useNavigate();
  const loginToStore = useAuthStore((s) => s.login);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const claims = decodeTokenClaims(token.trim());
    if (!claims) {
      setError('That does not look like a valid access token (need sub, email, tenantId, role).');
      return;
    }

    loginToStore(
      token.trim(),
      {
        id: claims.sub,
        email: claims.email,
        name: claims.email.split('@')[0],
        role: claims.role,
      },
      claims.tenantId,
    );
    navigate('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div>
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-blue-600 rounded-lg flex items-center justify-center">
              <LogIn className="w-10 h-10 text-white" />
            </div>
          </div>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Sign in to Open Migrate
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600">
            Sovereign data migration for families and SMBs
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleLogin}>
          <div>
            <label htmlFor="token" className="block text-sm font-medium text-gray-700 mb-1">
              Access token
            </label>
            <textarea
              id="token"
              name="token"
              required
              rows={4}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm font-mono"
              placeholder="eyJhbGciOi..."
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}

          <div>
            <button
              type="submit"
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
            >
              Sign in
            </button>
          </div>

          <div className="text-center text-sm text-gray-600">
            <p>
              Paste the access token from the seed script
              (<code>pnpm --filter @openmig/api seed:managed</code>) or your identity provider.
            </p>
          </div>
        </form>
      </div>
    </div>
  );
};

export default Login;
