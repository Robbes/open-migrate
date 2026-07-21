// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect, vi } from 'vitest';
import type { SyncCursor } from '@openmig/shared';
import { discoverSource, type ListingSource } from './discovery';
import { MemorySource } from './__testing__/memory';

describe('discoverSource (0013 T1)', () => {
  it('counts collections and items across a mail source, in listing order', async () => {
    const src = new MemorySource();
    src.add({ folderPath: 'INBOX', messageId: '<a@x>', rfc822: 'a' });
    src.add({ folderPath: 'INBOX', messageId: '<b@x>', rfc822: 'b' });
    src.add({ folderPath: 'Sent', messageId: '<c@x>', rfc822: 'c' });

    const result = await discoverSource(src);

    expect(result.collections).toBe(2);
    expect(result.items).toBe(3);
    expect(result.perCollection).toEqual([
      { name: 'INBOX', items: 2 },
      { name: 'Sent', items: 1 },
    ]);
    // No per-item sizes provided → no bytes reported.
    expect(result.bytes).toBeUndefined();
  });

  it('is body-free: never calls fetch()', async () => {
    const src = new MemorySource();
    src.add({ folderPath: 'INBOX', messageId: '<a@x>', rfc822: 'hello' });
    const fetchSpy = vi.spyOn(src, 'fetch');

    await discoverSource(src);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns zeros for an empty source', async () => {
    const result = await discoverSource(new MemorySource());
    expect(result).toEqual({ collections: 0, items: 0, perCollection: [] });
  });

  it('sums bytes (and per-collection bytes) when itemBytes yields sizes', async () => {
    // A minimal structural file-like source: two folders, items carry a size.
    interface Folder {
      readonly path: string;
      readonly name?: string;
    }
    interface Item {
      readonly size: number;
    }
    const data: Record<string, Item[]> = {
      Documents: [{ size: 100 }, { size: 50 }],
      Photos: [{ size: 900 }],
    };
    const source: ListingSource<Folder, Item> = {
      listFolders: () => Promise.resolve(Object.keys(data).map((path) => ({ path }))),
      listSince: (folder: Folder, _cursor?: SyncCursor) =>
        Promise.resolve({ items: data[folder.path] ?? [], nextCursor: { value: '' } }),
    };

    const result = await discoverSource(source, { itemBytes: (i) => i.size });

    expect(result.collections).toBe(2);
    expect(result.items).toBe(3);
    expect(result.bytes).toBe(1050);
    expect(result.perCollection).toEqual([
      { name: 'Documents', items: 2, bytes: 150 },
      { name: 'Photos', items: 1, bytes: 900 },
    ]);
  });

  it('handles empty collections and honours a custom folderName', async () => {
    interface Folder {
      readonly id: string;
    }
    const source: ListingSource<Folder, unknown> = {
      listFolders: () => Promise.resolve([{ id: 'cal-1' }, { id: 'cal-2' }]),
      listSince: (folder: Folder) =>
        Promise.resolve({
          items: folder.id === 'cal-1' ? [{}, {}] : [],
          nextCursor: { value: '' },
        }),
    };

    const result = await discoverSource(source, { folderName: (f) => f.id.toUpperCase() });

    expect(result.collections).toBe(2);
    expect(result.items).toBe(2);
    expect(result.bytes).toBeUndefined();
    expect(result.perCollection).toEqual([
      { name: 'CAL-1', items: 2 },
      { name: 'CAL-2', items: 0 },
    ]);
  });
});
