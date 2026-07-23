// Copyright 2026 The Open Migration Stack authors (Apache-2.0)
import { describe, it, expect } from 'vitest';
import { collectionSlug } from './dav-collection-path';

describe('collectionSlug', () => {
  it('prefers the folder name over the path', () => {
    expect(collectionSlug('Work Calendar', '/remote.php/dav/calendars/alice/work/', 'calendar')).toBe('work-calendar');
  });

  it('falls back to the last path segment when name is absent', () => {
    expect(collectionSlug(undefined, '/remote.php/dav/calendars/alice/personal/', 'calendar')).toBe('personal');
    expect(collectionSlug('', '/remote.php/dav/addressbooks/users/bob/contacts/', 'contacts')).toBe('contacts');
  });

  it('lowercases and collapses non-alphanumeric runs to single hyphens', () => {
    expect(collectionSlug('My  Fancy_Cal!!', undefined, 'calendar')).toBe('my-fancy-cal');
    expect(collectionSlug('Personal', undefined, 'calendar')).toBe('personal');
  });

  it('uses the fallback when nothing usable is provided', () => {
    expect(collectionSlug(undefined, undefined, 'calendar')).toBe('calendar');
    expect(collectionSlug('   ', '/', 'contacts')).toBe('contacts');
    expect(collectionSlug('!!!', undefined, 'calendar')).toBe('calendar');
  });

  it('re-homes a source folder deterministically (same source -> same slug)', () => {
    const a = collectionSlug('Personal', '/remote.php/dav/calendars/source-user/personal/', 'calendar');
    const b = collectionSlug('Personal', '/remote.php/dav/calendars/source-user/personal/', 'calendar');
    expect(a).toBe(b);
    expect(a).toBe('personal');
  });

  it('preserves the paths the #114 integration stubs relied on', () => {
    // The merged dav-sync.integration.test.ts stubs pass a target-shaped folder whose
    // name is already the slug; re-homing under <user> must reproduce the same path.
    expect(collectionSlug('openmig-e2e-target', 'calendars/testadmin/openmig-e2e-target', 'calendar')).toBe(
      'openmig-e2e-target',
    );
  });
});
