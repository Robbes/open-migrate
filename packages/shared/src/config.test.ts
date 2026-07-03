import { describe, it, expect } from 'vitest';
import { parseMappingConfig, parseMappingConfigJson, ConfigError } from './config';

const example = {
  tenantId: 'tenant-1',
  mappingId: 'inbox-mail',
  source: {
    type: 'imap-oauth2',
    host: 'outlook.office365.com',
    port: 993,
    user: 'user@example.onmicrosoft.com',
    auth: { kind: 'xoauth2', tokenFromEnv: 'O365_ACCESS_TOKEN' },
  },
  target: {
    type: 'jmap',
    baseUrl: 'http://stalwart:8080',
    user: 'target@dev.local',
    auth: { kind: 'basic', passwordFromEnv: 'TARGET_PASSWORD' },
  },
  schedule: { cron: '*/15 * * * *' },
  _note: 'ignored extra key',
};

describe('parseMappingConfig', () => {
  it('parses a valid config and ignores unknown keys', () => {
    const cfg = parseMappingConfig(example);
    expect(cfg.tenantId).toBe('tenant-1');
    expect(cfg.source.type).toBe('imap-oauth2');
    expect(cfg.target.type).toBe('jmap');
    expect(cfg.schedule?.cron).toBe('*/15 * * * *');
    expect(cfg.concurrency).toBeUndefined();
  });

  it('accepts the imap-dav target family and a concurrency knob', () => {
    const cfg = parseMappingConfig({
      ...example,
      target: { type: 'imap-dav', host: 'imap.soverin.net', port: 993, user: 'me@dom', auth: { kind: 'login', passwordFromEnv: 'PW' } },
      concurrency: 8,
    });
    expect(cfg.target.type).toBe('imap-dav');
    expect(cfg.concurrency).toBe(8);
  });

  it('rejects a missing tenantId', () => {
    const { tenantId: _omit, ...bad } = example;
    expect(() => parseMappingConfig(bad)).toThrow(ConfigError);
    expect(() => parseMappingConfig(bad)).toThrow(/tenantId/);
  });

  it('rejects an unsupported source type', () => {
    expect(() => parseMappingConfig({ ...example, source: { ...example.source, type: 'pop3' } })).toThrow(/source\.type/);
  });

  it('rejects a non-integer port', () => {
    expect(() => parseMappingConfig({ ...example, source: { ...example.source, port: 99.5 } })).toThrow(/source\.port/);
  });

  it('rejects an unsupported target type', () => {
    expect(() => parseMappingConfig({ ...example, target: { type: 'dropbox' } })).toThrow(/target\.type/);
  });

  it('rejects a non-object root', () => {
    expect(() => parseMappingConfig([])).toThrow(/root/);
    expect(() => parseMappingConfig(null)).toThrow(ConfigError);
  });
});

describe('parseMappingConfigJson', () => {
  it('parses JSON text', () => {
    expect(parseMappingConfigJson(JSON.stringify(example)).mappingId).toBe('inbox-mail');
  });
  it('throws ConfigError on invalid JSON', () => {
    expect(() => parseMappingConfigJson('{ not json')).toThrow(ConfigError);
  });
});
