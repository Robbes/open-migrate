// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Pre-sync discovery orchestration (workplan 0013 T3), shared by the managed job and the self-host
 * entrypoint. Runs each enabled domain's read-only, body-free count (built on `discoverSource`,
 * @openmig/core T1) and persists it via a {@link DiscoveryStore} (T2). Best-effort per domain: one
 * domain's failure records a verbatim error (§11.2) and never blocks the others.
 *
 * Trigger.dev-free: importing this has no managed-only deps, so the self-host path can use it too
 * (hard rule 5). Each edition supplies the per-domain `run()` thunk — managed builds its source
 * from the DB (RLS), self-host from the config file — keeping this orchestration edition-agnostic
 * and unit-testable with fakes.
 */

import type {
  DiscoveryStore,
  DiscoveryDomain,
  DomainDiscovery,
  TenantId,
  MappingId,
} from '@openmig/shared';

/** One domain's discovery unit: `run()` produces its counts (and closes any connection it opened). */
export interface DomainDiscoveryTask {
  readonly domain: DiscoveryDomain;
  run(): Promise<DomainDiscovery>;
}

/** Result of a discovery pass over one domain. */
export interface DomainDiscoveryOutcome {
  readonly domain: DiscoveryDomain;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Discover each task's domain and persist the counts; on failure, record the verbatim error and
 * continue. Returns a per-domain outcome (useful for logging/telemetry).
 */
export async function discoverDomains(
  tasks: readonly DomainDiscoveryTask[],
  store: DiscoveryStore,
  tenantId: TenantId,
  mappingId: MappingId,
): Promise<DomainDiscoveryOutcome[]> {
  const outcomes: DomainDiscoveryOutcome[] = [];
  for (const task of tasks) {
    try {
      const result = await task.run();
      await store.upsertDiscovery(tenantId, mappingId, task.domain, result);
      outcomes.push({ domain: task.domain, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Best-effort: never let one domain's failure abort discovery of the rest.
      await store.recordDiscoveryError(tenantId, mappingId, task.domain, message);
      outcomes.push({ domain: task.domain, ok: false, error: message });
    }
  }
  return outcomes;
}
