// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigDir } from './config-dir';

function validConfig(mappingId: string): string {
  return JSON.stringify({
    tenantId: '00000000-0000-4000-8000-000000000001',
    mappingId,
    source: {
      type: 'imap-oauth2',
      host: 'outlook.office365.com',
      port: 993,
      user: 'user@example.test',
      auth: { kind: 'xoauth2', tokenFromEnv: 'O365_ACCESS_TOKEN' },
    },
    target: {
      type: 'jmap',
      baseUrl: 'http://stalwart:8080',
      user: 'target@dev.local',
      auth: { kind: 'basic', passwordFromEnv: 'TARGET_PASSWORD' },
    },
    schedule: { cron: '*/15 * * * *' },
  });
}

describe('loadConfigDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'selfhost-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads and validates every *.json, sorted, ignoring non-json', () => {
    writeFileSync(join(dir, 'b.json'), validConfig('mapping-b'));
    writeFileSync(join(dir, 'a.json'), validConfig('mapping-a'));
    writeFileSync(join(dir, 'README.md'), 'not a config');

    const loaded = loadConfigDir(dir);
    expect(loaded.map((l) => l.config.mappingId)).toEqual(['mapping-a', 'mapping-b']);
    expect(loaded[0]!.config.schedule?.cron).toBe('*/15 * * * *');
  });

  it('throws with the offending path on an invalid config (never skips silently)', () => {
    writeFileSync(join(dir, 'good.json'), validConfig('ok'));
    writeFileSync(join(dir, 'bad.json'), '{ not valid json');
    expect(() => loadConfigDir(dir)).toThrow(/bad\.json/);
  });

  it('rejects duplicate mappingIds across files', () => {
    writeFileSync(join(dir, 'one.json'), validConfig('dup'));
    writeFileSync(join(dir, 'two.json'), validConfig('dup'));
    expect(() => loadConfigDir(dir)).toThrow(/Duplicate mappingId 'dup'/);
  });

  it('returns [] for an empty directory', () => {
    expect(loadConfigDir(dir)).toEqual([]);
  });
});
