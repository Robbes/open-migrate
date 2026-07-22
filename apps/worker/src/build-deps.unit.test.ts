// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

// Regression guard for the IMAP source auth-wiring bug found via a live e2e.yml run
// (workplan 0010 T5): buildImapSource() hardcoded authType: 'XOAUTH2' regardless of the
// configured auth.kind, and never extracted a password for auth.kind: 'login' at all —
// so a login-kind source (like the T5 fixture, or any generic non-O365 IMAP source)
// always sent an empty XOAUTH2 attempt and IMAP servers rejected it with
// "No supported authentication method(s) available".

import { describe, it, expect, vi } from 'vitest';
import { buildDeps } from './build-deps';
import type { MappingConfig, SourceAuth } from '@openmig/shared';

interface ImapSourceInternals {
  config: {
    authType?: 'LOGIN' | 'XOAUTH2';
    auth: { user: string; password?: string; accessToken?: string };
  };
}

function configWith(auth: SourceAuth): MappingConfig {
  return {
    tenantId: '00000000-0000-4000-8000-000000000001',
    mappingId: '11111111-1111-4111-8111-111111111111',
    source: {
      type: 'imap-oauth2',
      host: 'stalwart',
      port: 993,
      user: 'source@dev.local',
      auth,
    },
    target: {
      type: 'jmap',
      baseUrl: 'https://mail.example.net/jmap',
      user: 'u@example.net',
      auth: { kind: 'basic', passwordFromEnv: 'TGT_PASSWORD' },
    },
  };
}

describe('buildDeps IMAP source auth wiring', () => {
  it('wires password-based (login) auth through to the connector, not XOAUTH2', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/none');
    vi.stubEnv('SRC_PASSWORD', 'source_password');
    vi.stubEnv('TGT_PASSWORD', 'pw');
    try {
      const deps = await buildDeps(configWith({ kind: 'login', passwordFromEnv: 'SRC_PASSWORD' }));
      const internals = (deps.source as unknown as ImapSourceInternals).config;
      expect(internals.authType).toBe('LOGIN');
      expect(internals.auth.password).toBe('source_password');
      expect(internals.auth.accessToken).toBeUndefined();
      await deps.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still wires xoauth2 auth through to the connector as XOAUTH2', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:5432/none');
    vi.stubEnv('SRC_TOKEN', 'tok');
    vi.stubEnv('TGT_PASSWORD', 'pw');
    try {
      const deps = await buildDeps(configWith({ kind: 'xoauth2', tokenFromEnv: 'SRC_TOKEN' }));
      const internals = (deps.source as unknown as ImapSourceInternals).config;
      expect(internals.authType).toBe('XOAUTH2');
      expect(internals.auth.accessToken).toBe('tok');
      expect(internals.auth.password).toBeUndefined();
      await deps.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
