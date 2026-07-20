// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Pure helpers for turning a stored DAV connection (config + decrypted
 * credentials) into a normalized endpoint. Kept free of DB/secret-store imports
 * so they are cheaply unit-testable (review findings #4).
 */

import type { DavEndpoint } from './dav-factories';

/** Build a DAV endpoint URL from a stored connection config (url/baseUrl/host+port). */
export function davUrl(config: Record<string, unknown>): string {
  if (typeof config.url === 'string') return config.url;
  if (typeof config.baseUrl === 'string') return config.baseUrl;
  const host = config.host;
  if (typeof host !== 'string' || !host) {
    throw new Error('DAV connection config is missing url/baseUrl/host');
  }
  const scheme = config.useSsl === false ? 'http' : 'https';
  const port = typeof config.port === 'number' ? `:${config.port}` : '';
  return `${scheme}://${host}${port}/`;
}

/**
 * Resolve a DAV endpoint from a stored connection's config + decrypted
 * credentials, requiring a username and password. Fails fast with a clear
 * message (naming the role + expected keys) instead of silently building a
 * connector with empty credentials that only fails later as an opaque 401.
 */
export function davEndpointFromCreds(
  role: 'source' | 'target',
  config: Record<string, unknown>,
  creds: Record<string, string>,
): DavEndpoint {
  const username = creds.username;
  const password = creds.password;
  if (!username || !password) {
    throw new Error(
      `${role} DAV connection is missing credentials: expected non-empty "username" and "password" ` +
        `in the decrypted secret (got username=${username ? 'set' : 'missing'}, password=${password ? 'set' : 'missing'}).`,
    );
  }
  return { url: davUrl(config), username, password };
}
