// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect, vi } from 'vitest';
import { withClose } from './deps-lifecycle';
import { buildDeps, buildDomainDeps } from './build-deps';
import type { MappingConfig } from '@openmig/shared';

describe('withClose', () => {
  it('attaches a close() that delegates to the pool and is idempotent', async () => {
    const dbClose = vi.fn().mockResolvedValue(undefined);
    const deps = withClose({ a: 1 }, { close: dbClose });

    expect(deps.a).toBe(1);
    expect(typeof deps.close).toBe('function');

    await deps.close();
    await deps.close(); // second call must be a no-op, not a double pool.end()

    expect(dbClose).toHaveBeenCalledTimes(1);
  });
});

// Regression guard for the self-host pool leak: the deps-builders MUST return a
// closeable so the scheduler can release the pool after every pass. Before the
// fix these returned bare deps with no close(), and a long-running appliance
// leaked a pool per domain per pass. A bogus DATABASE_URL is fine — the pool is
// created lazily and never connected (we never run a query, only close()).
describe('deps-builders return a closeable pool handle', () => {
  const config: MappingConfig = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    mappingId: '11111111-1111-4111-8111-111111111111',
    source: {
      type: 'imap-oauth2',
      host: 'imap.example.com',
      port: 993,
      user: 'u@example.com',
      auth: { kind: 'xoauth2', tokenFromEnv: 'SRC_TOKEN' },
    },
    target: {
      type: 'jmap',
      baseUrl: 'https://mail.example.net/jmap',
      user: 'u@example.net',
      auth: { kind: 'basic', passwordFromEnv: 'TGT_PASSWORD' },
    },
    domains: {
      calendar: {
        enabled: true,
        source: { type: 'caldav', url: 'https://dav.example.com/cal', user: 'u', auth: { kind: 'login', passwordFromEnv: 'CAL_PW' } },
        target: { type: 'caldav', url: 'https://dav.example.net/cal', user: 'u', auth: { kind: 'login', passwordFromEnv: 'CAL_PW' } },
      },
    },
  };

  it('buildDeps returns close() and it resolves', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/none');
    vi.stubEnv('SRC_TOKEN', 'tok');
    vi.stubEnv('TGT_PASSWORD', 'pw');
    try {
      const deps = await buildDeps(config);
      expect(typeof deps.close).toBe('function');
      await expect(deps.close()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('buildDomainDeps returns close() and it resolves', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/none');
    vi.stubEnv('CAL_PW', 'pw');
    try {
      const deps = buildDomainDeps(config, 'calendar');
      expect(typeof deps.close).toBe('function');
      await expect(deps.close()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
