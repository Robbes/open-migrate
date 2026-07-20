// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Regression tests for review findings #3 and #4 (0010 self-host review).
 *  #3 — the mail domain must honor `domains.mail.source/target` when present.
 *  #4 — the managed DAV path must reject missing credentials with a clear error.
 */

import { describe, it, expect } from 'vitest';
import type { MappingConfig, SourceConfig, TargetConfig } from '@openmig/shared';
import { resolveMailConfig } from './build-deps';
import { davEndpointFromCreds } from './dav-endpoint';

const topSource: SourceConfig = {
  type: 'imap-oauth2',
  host: 'top.example.com',
  port: 993,
  user: 'top@example.com',
  auth: { kind: 'xoauth2', tokenFromEnv: 'TOP_TOKEN' },
};
const topTarget: TargetConfig = {
  type: 'jmap',
  baseUrl: 'https://top.example.net/jmap',
  user: 'top@example.net',
  auth: { kind: 'basic', passwordFromEnv: 'TOP_PW' },
};

const base: MappingConfig = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  mappingId: '11111111-1111-4111-8111-111111111111',
  source: topSource,
  target: topTarget,
};

describe('resolveMailConfig (finding #3)', () => {
  it('uses the top-level source/target when no domains.mail is set', () => {
    const r = resolveMailConfig(base);
    expect(r.source).toBe(topSource);
    expect(r.target).toBe(topTarget);
    expect(r.concurrency).toBe(4);
  });

  it('honors domains.mail.source/target/concurrency when present', () => {
    const mailSource: SourceConfig = {
      type: 'imap-oauth2',
      host: 'mail-domain.example.com',
      port: 993,
      user: 'md@example.com',
      auth: { kind: 'xoauth2', tokenFromEnv: 'MD_TOKEN' },
    };
    const mailTarget: TargetConfig = {
      type: 'jmap',
      baseUrl: 'https://mail-domain.example.net/jmap',
      user: 'md@example.net',
      auth: { kind: 'basic', passwordFromEnv: 'MD_PW' },
    };
    const config: MappingConfig = {
      ...base,
      concurrency: 2,
      domains: { mail: { enabled: true, source: mailSource, target: mailTarget, concurrency: 8 } },
    };
    const r = resolveMailConfig(config);
    expect(r.source).toBe(mailSource); // NOT the top-level source
    expect(r.target).toBe(mailTarget);
    expect(r.concurrency).toBe(8); // per-domain wins over top-level (2)
  });

  it('falls back to the top-level concurrency when domains.mail omits it', () => {
    const config: MappingConfig = {
      ...base,
      concurrency: 6,
      domains: { mail: { enabled: true, source: topSource, target: topTarget } },
    };
    expect(resolveMailConfig(config).concurrency).toBe(6);
  });
});

describe('davEndpointFromCreds (finding #4)', () => {
  const config = { url: 'https://dav.example.com/cal' };

  it('builds an endpoint when username + password are present', () => {
    const e = davEndpointFromCreds('source', config, { username: 'u', password: 'p' });
    expect(e).toEqual({ url: 'https://dav.example.com/cal', username: 'u', password: 'p' });
  });

  it('throws a clear error (naming the role) when the password is missing', () => {
    expect(() => davEndpointFromCreds('target', config, { username: 'u' } as Record<string, string>))
      .toThrow(/target DAV connection is missing credentials/);
  });

  it('throws when the username is missing', () => {
    expect(() => davEndpointFromCreds('source', config, { password: 'p' } as Record<string, string>))
      .toThrow(/source DAV connection is missing credentials/);
  });
});
