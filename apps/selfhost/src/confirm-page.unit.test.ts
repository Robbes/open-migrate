// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect } from 'vitest';
import type { ScopeManifest } from '@openmig/shared';
import { renderConfirmPage, type MappingConfirmView } from './confirm-page';

const MANIFEST: ScopeManifest = {
  version: '2026-07-21',
  migrates: [{ item: 'Files', detail: 'OneDrive / SharePoint document libraries.' }],
  partial: [{ item: 'Permissions', detail: 'Best-effort.' }],
  doesNotMigrate: [{ item: 'Teams chat', detail: 'Not migrated.' }],
};

describe('renderConfirmPage', () => {
  it('shows a scanning placeholder for a mapping with no discovery yet', () => {
    const view: MappingConfirmView = { mappingId: 'm1', status: 'paused', domains: [] };
    const html = renderConfirmPage({ mappings: [view], manifest: MANIFEST });
    expect(html).toContain('Scanning your source');
    expect(html).toContain('m1');
  });

  it('renders discovery counts and a Start migration form for a paused mapping', () => {
    const view: MappingConfirmView = {
      mappingId: 'm1',
      status: 'paused',
      domains: [
        { domain: 'email', collections: 4, items: 1200, bytes: 5_000_000, discoveredAt: '2026-07-21T00:00:00Z' },
      ],
    };
    const html = renderConfirmPage({ mappings: [view], manifest: MANIFEST });
    expect(html).toContain('1200');
    expect(html).toContain('<form method="POST" action="/mappings/m1/start">');
    expect(html).toContain('Start migration');
  });

  it('shows status instead of a Start form once a mapping is already active', () => {
    const view: MappingConfirmView = { mappingId: 'm1', status: 'active', domains: [] };
    const html = renderConfirmPage({ mappings: [view], manifest: MANIFEST });
    expect(html).not.toContain('Start migration');
    expect(html).toContain('active');
  });

  it('surfaces a domain discovery error', () => {
    const view: MappingConfirmView = {
      mappingId: 'm1',
      status: 'paused',
      domains: [
        { domain: 'file', collections: 0, items: 0, discoveredAt: '2026-07-21T00:00:00Z', lastError: 'auth failed' },
      ],
    };
    const html = renderConfirmPage({ mappings: [view], manifest: MANIFEST });
    expect(html).toContain('auth failed');
  });

  it('renders the scope manifest columns', () => {
    const html = renderConfirmPage({ mappings: [], manifest: MANIFEST });
    expect(html).toContain('Files');
    expect(html).toContain('Permissions');
    expect(html).toContain('Teams chat');
    expect(html).toContain('No mappings configured.');
  });

  it('escapes untrusted mapping ids / error text', () => {
    const view: MappingConfirmView = {
      mappingId: '<script>alert(1)</script>',
      status: 'paused',
      domains: [
        { domain: 'email', collections: 0, items: 0, discoveredAt: '2026-07-21T00:00:00Z', lastError: '<b>bad</b>' },
      ],
    };
    const html = renderConfirmPage({ mappings: [view], manifest: MANIFEST });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>bad</b>');
  });
});
