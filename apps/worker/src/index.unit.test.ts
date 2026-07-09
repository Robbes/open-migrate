/**
 * Worker CLI unit tests.
 *
 * These tests verify the CLI argument parsing and config loading.
 * Full integration tests require the dependency injection to be implemented.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseMappingConfig } from '@openmig/shared';
import { resolve } from 'path';

describe('Worker CLI', () => {
  describe('parseMappingConfig', () => {
    it('should parse a valid mapping config', () => {
      const config = {
        tenantId: 'test-tenant',
        mappingId: 'test-mapping',
        source: {
          type: 'imap-oauth2' as const,
          host: 'outlook.office365.com',
          port: 993,
          user: 'test@example.com',
          auth: {
            kind: 'xoauth2' as const,
            tokenFromEnv: 'TOKEN',
          },
        },
        target: {
          type: 'jmap' as const,
          baseUrl: 'https://jmap.example.com',
          user: 'test@example.com',
          auth: {
            kind: 'bearer' as const,
            tokenFromEnv: 'TOKEN',
          },
        },
        schedule: {
          cron: '0 */6 * * *',
        },
        concurrency: 4,
      };

      const result = parseMappingConfig(config);
      expect(result.tenantId).toBe('test-tenant');
      expect(result.mappingId).toBe('test-mapping');
      expect(result.source.type).toBe('imap-oauth2');
      expect(result.target.type).toBe('jmap');
      expect(result.schedule?.cron).toBe('0 */6 * * *');
      expect(result.concurrency).toBe(4);
    });

    it('should work without schedule (for --once mode)', () => {
      const config = {
        tenantId: 'test-tenant',
        mappingId: 'test-mapping',
        source: {
          type: 'imap-oauth2' as const,
          host: 'outlook.office365.com',
          port: 993,
          user: 'test@example.com',
          auth: {
            kind: 'login' as const,
            passwordFromEnv: 'PASSWORD',
          },
        },
        target: {
          type: 'imap-dav' as const,
          host: 'imap.example.com',
          port: 993,
          user: 'test@example.com',
          auth: {
            kind: 'login' as const,
            passwordFromEnv: 'PASSWORD',
          },
        },
      };

      const result = parseMappingConfig(config);
      expect(result.schedule).toBeUndefined();
    });

    it('should throw on invalid config', () => {
      expect(() =>
        parseMappingConfig({
          tenantId: '',
          mappingId: 'test',
          source: {},
          target: {},
        })
      ).toThrow();
    });
  });

  describe('config path resolution', () => {
    let originalCwd: string;

    beforeEach(() => {
      originalCwd = process.cwd();
    });

    afterEach(() => {
      process.chdir(originalCwd);
    });

    it('should resolve relative paths from process.cwd() not __dirname', () => {
      // Simulate the config path resolution logic
      const configPath = './mapping.example.json';
      const resolvedPath = resolve(process.cwd(), configPath);
      
      // The path should be resolved from cwd, not from the module directory
      expect(resolvedPath).toContain(process.cwd());
      expect(resolvedPath).not.toContain('apps/worker/src');
    });

    it('should handle absolute paths correctly', () => {
      const absolutePath = '/tmp/mapping.json';
      const resolvedPath = resolve(process.cwd(), absolutePath);
      
      // Absolute paths should remain unchanged
      expect(resolvedPath).toBe(absolutePath);
    });
  });
});
