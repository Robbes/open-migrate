// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import type { DomainDiscovery, DiscoveryCollection, SyncCursor } from '@openmig/shared';

/**
 * Pre-sync discovery (workplan 0013 T1).
 *
 * Counts what a source holds for one domain — **read-only and body-free** — by reusing the same
 * `listFolders()` + metadata-only `listSince()` methods every source connector already implements
 * (mail / calendar / contact / file). It never calls `fetch()`, so no message/file bodies are
 * pulled. Implemented generically (structural over the four source shapes) rather than as a
 * per-connector method, so it works for every source — current and future — with zero connector
 * churn and reuses the already-tested listing paths. Connectors that can count more cheaply (IMAP
 * `STATUS`, Graph `totalItemCount`) may specialise later; this is the correct, uniform baseline.
 */

/** The read-only listing surface shared by all source connectors, over folder `F` and item `I`. */
export interface ListingSource<F, I> {
  listFolders(): Promise<ReadonlyArray<F>>;
  listSince(folder: F, cursor?: SyncCursor): Promise<{ items: ReadonlyArray<I>; nextCursor: SyncCursor }>;
}

/** Optional hooks to label collections and read per-item byte sizes. */
export interface DiscoverOptions<F, I> {
  /** Label for a collection; defaults to the folder's `name` then `path`. */
  readonly folderName?: (folder: F) => string;
  /** Cheap per-item byte size, when the listing carries it (mail/files). Return undefined to skip. */
  readonly itemBytes?: (item: I) => number | undefined;
}

/** Best-effort default label from a folder's `name`/`path` fields. */
function defaultFolderName<F>(folder: F): string {
  const f = folder as { name?: string; path?: string };
  return f.name ?? f.path ?? '';
}

/**
 * Produce a {@link DomainDiscovery} for one source by listing every collection's items (metadata
 * only) and tallying counts (and bytes where `itemBytes` yields a number).
 */
export async function discoverSource<F, I>(
  source: ListingSource<F, I>,
  options: DiscoverOptions<F, I> = {},
): Promise<DomainDiscovery> {
  const folders = await source.listFolders();
  const nameOf = options.folderName ?? defaultFolderName;

  let items = 0;
  let bytes = 0;
  let anyBytes = false;
  const perCollection: DiscoveryCollection[] = [];

  for (const folder of folders) {
    // Metadata-only: listSince returns item descriptors; bodies come from fetch(), never called here.
    const { items: folderItems } = await source.listSince(folder);

    let folderBytes = 0;
    let folderHasBytes = false;
    if (options.itemBytes) {
      for (const item of folderItems) {
        const b = options.itemBytes(item);
        if (typeof b === 'number' && Number.isFinite(b)) {
          folderBytes += b;
          folderHasBytes = true;
        }
      }
    }

    items += folderItems.length;
    if (folderHasBytes) {
      bytes += folderBytes;
      anyBytes = true;
    }
    perCollection.push({
      name: nameOf(folder),
      items: folderItems.length,
      ...(folderHasBytes ? { bytes: folderBytes } : {}),
    });
  }

  return {
    collections: folders.length,
    items,
    ...(anyBytes ? { bytes } : {}),
    perCollection,
  };
}
