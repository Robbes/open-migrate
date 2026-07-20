// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Multi-domain sync orchestration, shared by the worker CLI and the self-host
 * entrypoint (workplan 0010 T2 — "extract/share it, don't fork it"). Runs each
 * enabled domain (mail via runShadowPass; calendar/contact/file via the DAV
 * runners) with per-domain migration_status tracking. Domain failures are
 * recorded and do not block the other domains.
 *
 * Importing this module has no side effects (unlike index.ts, which is the CLI
 * entrypoint and calls main()).
 */

import type { MappingConfig, MigrationStatusStore, TenantId, MappingId } from '@openmig/shared';
import { runShadowPass, runCalendarSync, runContactSync, runFileSync } from '@openmig/core';
import { buildDeps, buildDomainDeps } from './build-deps';

export interface DomainSyncResult {
  domain: 'email' | 'calendar' | 'contact' | 'file';
  scanned: number;
  created: number;
  skipped: number;
  failed: number;
  error?: string;
}

/** Run all enabled domains for one mapping config, with status tracking. */
export async function runAllDomains(
  config: MappingConfig,
  statusStore: MigrationStatusStore,
): Promise<DomainSyncResult[]> {
  const results: DomainSyncResult[] = [];
  const domains: Array<{ name: 'email' | 'calendar' | 'contact' | 'file'; enabled: boolean }> = [
    { name: 'email', enabled: config.domains?.mail?.enabled ?? false },
    { name: 'calendar', enabled: config.domains?.calendar?.enabled ?? false },
    { name: 'contact', enabled: config.domains?.contacts?.enabled ?? false },
    { name: 'file', enabled: config.domains?.files?.enabled ?? false },
  ];

  // Backward compatibility: a config with no domains block but an IMAP source
  // runs mail only.
  const hasDomainConfig = config.domains && Object.values(config.domains).some((d) => d?.enabled);
  const runMailOnly = !hasDomainConfig && config.source.type === 'imap-oauth2';
  if (runMailOnly) {
    domains[0]!.enabled = true;
  }

  for (const { name: domain, enabled } of domains) {
    const tenantId = config.tenantId as TenantId;
    const mappingId = config.mappingId as MappingId;

    await statusStore.initDomainStatus(tenantId, mappingId, domain);

    if (!enabled) {
      await statusStore.markSkipped(tenantId, mappingId, domain);
      results.push({ domain, scanned: 0, created: 0, skipped: 0, failed: 0 });
      continue;
    }

    await statusStore.markInProgress(tenantId, mappingId, domain);

    try {
      // Each builder opens a Postgres pool; always release it after the pass
      // (finally) so a long-running scheduler never leaks a pool per domain.
      if (domain === 'email') {
        const deps = await buildDeps(config);
        try {
          const result = await runShadowPass(deps);
          results.push({ domain, scanned: result.scanned, created: result.created, skipped: result.skipped, failed: 0 });
        } finally {
          await deps.close();
        }
      } else if (domain === 'calendar') {
        const deps = buildDomainDeps(config, 'calendar');
        try {
          const result = await runCalendarSync(deps);
          results.push({ domain, scanned: result.scanned, created: result.created, skipped: result.skipped, failed: result.failed });
        } finally {
          await deps.close();
        }
      } else if (domain === 'contact') {
        const deps = buildDomainDeps(config, 'contact');
        try {
          const result = await runContactSync(deps);
          results.push({ domain, scanned: result.scanned, created: result.created, skipped: result.skipped, failed: result.failed });
        } finally {
          await deps.close();
        }
      } else {
        const deps = buildDomainDeps(config, 'file');
        try {
          const result = await runFileSync(deps);
          results.push({ domain, scanned: result.scanned, created: result.created, skipped: result.skipped, failed: result.failed });
        } finally {
          await deps.close();
        }
      }

      await statusStore.markCompleted(tenantId, mappingId, domain);
      const last = results[results.length - 1]!;
      console.log(`[Worker] ${domain} sync complete: scanned=${last.scanned}, created=${last.created}, skipped=${last.skipped}`);
    } catch (err) {
      const error = err as Error;
      console.error(`[Worker] ${domain} sync failed: ${error.message}`);
      await statusStore.markFailed(tenantId, mappingId, domain, error.message);
      results.push({ domain, scanned: 0, created: 0, skipped: 0, failed: 1, error: error.message });
      // Continue to the next domain — one domain's failure must not block others.
    }
  }

  return results;
}
