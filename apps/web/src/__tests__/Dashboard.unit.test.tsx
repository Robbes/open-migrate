// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Dashboard from '../pages/Dashboard';
import { mappingApi, type Mapping } from '../services/mapping-service';

// The Dashboard loads data through the real service layer (mappingApi -> apiClient
// -> /api). We mock the service so the test drives loading / data / error states
// without a backend, proving the component is wired to the API contract.
vi.mock('../services/mapping-service', () => ({
  mappingApi: { list: vi.fn() },
}));

const listMock = vi.mocked(mappingApi.list);

const renderDashboard = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>
  );
};

const sampleMapping = (over: Partial<Mapping> = {}): Mapping => ({
  id: 'm1',
  tenantId: 't1',
  name: 'Inbox',
  sourceType: 'imap',
  targetType: 'jmap',
  sourceConfig: { host: 's', port: 993, username: 'u' },
  targetConfig: { host: 't', port: 993, username: 'u', password: 'p' },
  syncConfig: { domains: ['email'] },
  status: 'active',
  createdAt: '2026-07-01T00:00:00Z',
  ...over,
});

describe('Dashboard', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it('renders mapping stats once the API resolves', async () => {
    listMock.mockResolvedValue([
      sampleMapping({ id: 'a', status: 'active' }),
      sampleMapping({ id: 'b', status: 'completed' }),
      sampleMapping({ id: 'c', status: 'error' }),
    ]);

    renderDashboard();

    expect(await screen.findByText('Total Mappings')).toBeInTheDocument();
    // 3 total mappings derived from the API response.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('surfaces API errors verbatim (SAD §11.2)', async () => {
    listMock.mockRejectedValue(new Error('connector auth failed: 401'));

    renderDashboard();

    // The exact error message must be shown to the user, not masked.
    expect(
      await screen.findByText('connector auth failed: 401')
    ).toBeInTheDocument();
  });
});
