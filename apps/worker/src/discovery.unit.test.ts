// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect, vi } from 'vitest';
import type {
  DiscoveryStore,
  DiscoveryRecord,
  DomainDiscovery,
  TenantId,
  MappingId,
} from '@openmig/shared';
import { discoverDomains, type DomainDiscoveryTask } from './discovery';

const TENANT = 'tenant-1' as TenantId;
const MAPPING = 'mapping-1' as MappingId;

/** In-memory DiscoveryStore capturing writes. */
function fakeStore() {
  const upserts: Array<{ domain: string; discovery: DomainDiscovery }> = [];
  const errors: Array<{ domain: string; error: string }> = [];
  const store: DiscoveryStore = {
    upsertDiscovery: (_t, _m, domain, discovery) => {
      upserts.push({ domain, discovery });
      return Promise.resolve();
    },
    recordDiscoveryError: (_t, _m, domain, error) => {
      errors.push({ domain, error });
      return Promise.resolve();
    },
    getDiscovery: () => Promise.resolve([] as DiscoveryRecord[]),
  };
  return { store, upserts, errors };
}

describe('discoverDomains (0013 T3)', () => {
  it('upserts each domain that succeeds', async () => {
    const { store, upserts, errors } = fakeStore();
    const tasks: DomainDiscoveryTask[] = [
      { domain: 'email', run: () => Promise.resolve({ collections: 2, items: 10, bytes: 500 }) },
      { domain: 'file', run: () => Promise.resolve({ collections: 1, items: 3 }) },
    ];

    const outcomes = await discoverDomains(tasks, store, TENANT, MAPPING);

    expect(upserts).toEqual([
      { domain: 'email', discovery: { collections: 2, items: 10, bytes: 500 } },
      { domain: 'file', discovery: { collections: 1, items: 3 } },
    ]);
    expect(errors).toHaveLength(0);
    expect(outcomes).toEqual([
      { domain: 'email', ok: true },
      { domain: 'file', ok: true },
    ]);
  });

  it('records a verbatim error and CONTINUES to the other domains (best-effort)', async () => {
    const { store, upserts, errors } = fakeStore();
    const tasks: DomainDiscoveryTask[] = [
      { domain: 'email', run: () => Promise.reject(new Error('IMAP 401 Unauthorized')) },
      { domain: 'calendar', run: () => Promise.resolve({ collections: 1, items: 4 }) },
    ];

    const outcomes = await discoverDomains(tasks, store, TENANT, MAPPING);

    // The failing domain did not abort the run.
    expect(errors).toEqual([{ domain: 'email', error: 'IMAP 401 Unauthorized' }]);
    expect(upserts).toEqual([{ domain: 'calendar', discovery: { collections: 1, items: 4 } }]);
    expect(outcomes).toEqual([
      { domain: 'email', ok: false, error: 'IMAP 401 Unauthorized' },
      { domain: 'calendar', ok: true },
    ]);
  });

  it('stringifies non-Error throwables', async () => {
    const { store, errors } = fakeStore();
    const tasks: DomainDiscoveryTask[] = [
      { domain: 'contact', run: () => Promise.reject('boom') },
    ];

    await discoverDomains(tasks, store, TENANT, MAPPING);

    expect(errors).toEqual([{ domain: 'contact', error: 'boom' }]);
  });

  it('passes tenant + mapping ids through to the store', async () => {
    const { store } = fakeStore();
    const upsertSpy = vi.spyOn(store, 'upsertDiscovery');
    const tasks: DomainDiscoveryTask[] = [
      { domain: 'email', run: () => Promise.resolve({ collections: 0, items: 0 }) },
    ];

    await discoverDomains(tasks, store, TENANT, MAPPING);

    expect(upsertSpy).toHaveBeenCalledWith(TENANT, MAPPING, 'email', { collections: 0, items: 0 });
  });
});
