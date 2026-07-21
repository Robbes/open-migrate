// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

vi.mock('../services/mapping-service', () => ({
  mappingApi: {
    discover: vi.fn().mockResolvedValue({}),
    getDiscovery: vi.fn().mockResolvedValue({
      mappingId: 'm1',
      discovered: true,
      domains: [
        { domain: 'email', collections: 2, items: 10, bytes: 1024, discoveredAt: '2026-01-01T00:00:00Z' },
      ],
    }),
    start: vi.fn().mockResolvedValue({ id: 'm1', status: 'active' }),
  },
  scopeManifestApi: {
    get: vi.fn().mockResolvedValue({
      version: 'v1',
      migrates: [{ item: 'Files', detail: 'document libraries' }],
      partial: [{ item: 'Permissions', detail: 'guided' }],
      doesNotMigrate: [{ item: 'Teams chat', detail: 'not migrated' }],
    }),
  },
}));

import { ConfirmMigration } from './ConfirmMigration';
import { mappingApi } from '../services/mapping-service';

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('ConfirmMigration (0013 T6)', () => {
  it('kicks off discovery, shows counts + scope manifest, and starts on the green light', async () => {
    const onStarted = vi.fn();
    renderWithClient(<ConfirmMigration mappingId="m1" onStarted={onStarted} />);

    // Discovery is kicked off on mount (read-only).
    expect(mappingApi.discover).toHaveBeenCalledWith('m1');

    // Counts render once discovery resolves.
    expect(await screen.findByText('Email')).toBeInTheDocument();
    expect(await screen.findByText('10')).toBeInTheDocument();

    // Scope manifest (§11.2) renders, incl. the explicit "does not migrate" list.
    expect(await screen.findByText(/Teams chat/)).toBeInTheDocument();

    // The green light starts the migration and calls back.
    fireEvent.click(screen.getByRole('button', { name: /start migration/i }));
    await waitFor(() => expect(mappingApi.start).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
  });
});
