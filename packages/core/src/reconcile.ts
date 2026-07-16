// Copyright 2026 OpenHands Agent (Apache-2.0)
import {
  contentHash,
  mapWithConcurrency as _mapWithConcurrency,
  naturalKeyForItem,
  type RunShadowPass,
  type SourceConnector,
  type TargetWriter,
  type Ledger,
  type CursorStore,
  type TenantId,
  type MappingId,
  type ReconcileResult as _ReconcileResult,
  type MailItem,
  type MailFolder,
  type RawMessage,
} from '@openmig/shared';
import { runDomainSync, type DomainSyncDeps as _DomainSyncDeps } from './domain-sync';

const DEFAULT_CONCURRENCY = 4;

/**
 * One-way, non-destructive shadow pass for a single mapping — workplan 0001, T4.
 *
 * Idempotent (run twice -> the second pass creates 0) and non-destructive (never deletes or
 * overwrites on the target; source deletions are not propagated). Idempotency is anchored on the
 * natural key via the ledger fast-path, and `TargetWriter.upsertEmail` is itself create-if-absent
 * (ADR-0020), so even a wiped ledger cannot produce duplicates.
 *
 * Throughput/memory: folders run sequentially; within a folder, items are processed with BOUNDED
 * CONCURRENCY (`deps.concurrency`, default 4). Items in a folder have distinct Message-IDs, so
 * parallelism is race-free, and the cap bounds peak memory to ~`concurrency` bodies in flight.
 *
 * Incremental cursors: when `deps.cursors` is provided, each folder lists only items changed since
 * the stored cursor and the new cursor is persisted ONLY AFTER the folder completes successfully
 * (a failed folder keeps its old cursor and is re-scanned next pass). Cursors are non-authoritative
 * (ADR-0020): absent/lost/malformed just means a full, still-idempotent re-scan.
 */
export const runShadowPass: RunShadowPass = async (deps) => {
  const { tenantId, mappingId, source, target, ledger, cursors } = deps;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  // Delegate to generalized runDomainSync with mail-specific injections
  const result = await runDomainSync<SourceConnector, TargetWriter, MailItem, MailFolder>({
    tenantId,
    mappingId,
    domain: 'email',
    source,
    target,
    ledger,
    cursors,
    concurrency,
    listFolders: () => source.listFolders(),
    listSince: (folder, cursor) => source.listSince(folder, cursor),
    fetchRaw: async (item) => {
      const raw = await source.fetch(item);
      return { raw, sizeBytes: item.size ?? 0 };
    },
    upsert: async (mailboxId, raw, item) => 
      target.upsertEmail(mailboxId, raw as RawMessage, (item as MailItem).keywords),
    naturalKey: (item) => naturalKeyForItem(item),
    contentHash: (raw) => contentHash((raw as RawMessage).rfc822),
    ensureCollection: (folder) => target.ensureMailbox(folder),
  });

  // Return compatible ReconcileResult (map failed to 0 for backward compatibility)
  return {
    scanned: result.scanned,
    created: result.created,
    skipped: result.skipped,
    drift: result.drift,
  };
};

/**
 * Dependency bundle for a shadow pass (DI for the T4 reconcile loop).
 * This is the original type for backward compatibility.
 */
export interface ReconcileDeps {
  readonly tenantId: TenantId;
  readonly mappingId: MappingId;
  readonly source: SourceConnector;
  readonly target: TargetWriter;
  readonly ledger: Ledger;
  /**
   * Optional cursor persistence: when provided, each folder pass lists only items changed since
   * the stored cursor and persists the new cursor after the folder completes. Absent -> full scan
   * (always correct via the ledger, just more work).
   */
  readonly cursors?: CursorStore;
  /** Max messages processed in parallel per folder (default 4). Bounds throughput and peak memory. */
  readonly concurrency?: number;
}
