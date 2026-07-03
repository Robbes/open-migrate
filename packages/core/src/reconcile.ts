import {
  contentHash,
  mapWithConcurrency,
  naturalKeyForItem,
  type RunShadowPass,
} from '@openmig/shared';

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
  let scanned = 0;
  let created = 0;
  let skipped = 0;

  const folders = await source.listFolders();
  for (const folder of folders) {
    const mailboxId = await target.ensureMailbox(folder);
    const prev = cursors ? await cursors.get(tenantId, mappingId, folder.path) : undefined;
    const { items, nextCursor } = await source.listSince(folder, prev);

    await mapWithConcurrency(items, concurrency, async (item) => {
      scanned += 1;
      const naturalKeyHash = naturalKeyForItem(item);

      // Ledger fast-path: already migrated -> skip without fetching the body.
      const known = await ledger.find(tenantId, mappingId, naturalKeyHash);
      if (known) {
        skipped += 1;
        return;
      }

      // Create-if-absent on the target (handles a wiped ledger without duplicating).
      const raw = await source.fetch(item);
      const ch = contentHash(raw.rfc822);
      const result = await target.upsertEmail(mailboxId, raw, item.keywords);

      await ledger.recordIfAbsent({
        tenantId,
        mappingId,
        naturalKeyHash,
        contentHash: ch,
        targetId: result.targetId,
        createdAt: new Date().toISOString(),
      });

      if (result.created) created += 1;
      else skipped += 1;
    });

    // Persist the cursor only after the whole folder succeeded (fail-fast above throws first).
    if (cursors) await cursors.set(tenantId, mappingId, folder.path, nextCursor);
  }

  // Drift (source items absent on a later pass) is logged, never propagated; deferred to a later slice.
  return { scanned, created, skipped, drift: 0 };
};
