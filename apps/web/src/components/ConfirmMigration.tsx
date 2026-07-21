// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

import React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { mappingApi, scopeManifestApi, type DiscoveryRecord } from '../services/mapping-service';

const DOMAIN_LABEL: Record<DiscoveryRecord['domain'], string> = {
  email: 'Email',
  calendar: 'Calendar',
  contact: 'Contacts',
  file: 'Files',
};

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  return `${n.toFixed(u === 0 ? 0 : 1)} ${units[u]}`;
}

export interface ConfirmMigrationProps {
  readonly mappingId: string;
  /** Called after the migration is successfully started (green light given). */
  readonly onStarted: () => void;
}

/**
 * Pre-sync confirm screen (workplan 0013 T6). Kicks off read-only discovery, polls the per-domain
 * counts, shows them next to the §11.2 scope manifest, and offers the "Start migration" green light
 * that activates the (paused) mapping.
 */
export function ConfirmMigration({ mappingId, onStarted }: ConfirmMigrationProps): React.ReactElement {
  // Kick off discovery once on mount.
  React.useEffect(() => {
    void mappingApi.discover(mappingId);
  }, [mappingId]);

  const discovery = useQuery({
    queryKey: ['discovery', mappingId],
    queryFn: () => mappingApi.getDiscovery(mappingId),
    // Poll until the first pass lands.
    refetchInterval: (query) => (query.state.data?.discovered ? false : 2000),
  });

  const manifest = useQuery({
    queryKey: ['scope-manifest'],
    queryFn: () => scopeManifestApi.get(),
  });

  const startMutation = useMutation({
    mutationFn: () => mappingApi.start(mappingId),
    onSuccess: onStarted,
  });

  const domains = discovery.data?.domains ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Review &amp; confirm</h2>
        <p className="text-sm text-gray-600">
          Nothing has been copied yet. Review what will migrate, then give the green light.
        </p>
      </div>

      {/* Discovery counts */}
      <section aria-label="discovery-counts">
        <h3 className="text-sm font-medium text-gray-700 mb-2">What we found in your source</h3>
        {!discovery.data?.discovered ? (
          <p className="text-sm text-gray-500" role="status">
            Scanning your source (read-only)…
          </p>
        ) : (
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1 pr-4">Type</th>
                <th className="py-1 pr-4">Collections</th>
                <th className="py-1 pr-4">Items</th>
                <th className="py-1 pr-4">Size</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.domain} className="border-t border-gray-100">
                  <td className="py-1 pr-4 font-medium text-gray-900">{DOMAIN_LABEL[d.domain]}</td>
                  <td className="py-1 pr-4">{d.collections}</td>
                  <td className="py-1 pr-4">{d.items}</td>
                  <td className="py-1 pr-4">{formatBytes(d.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Scope manifest (§11.2) */}
      {manifest.data && (
        <section aria-label="scope-manifest" className="grid gap-4 md:grid-cols-3">
          <ManifestColumn title="Migrates" tone="text-green-700" entries={manifest.data.migrates} />
          <ManifestColumn title="Partial" tone="text-amber-700" entries={manifest.data.partial} />
          <ManifestColumn title="Does not migrate" tone="text-gray-500" entries={manifest.data.doesNotMigrate} />
        </section>
      )}

      {startMutation.isError && (
        <p className="text-sm text-red-600" role="alert">
          Could not start the migration. Please try again.
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => startMutation.mutate()}
          disabled={startMutation.isPending}
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {startMutation.isPending ? 'Starting…' : 'Start migration'}
        </button>
      </div>
    </div>
  );
}

function ManifestColumn({
  title,
  tone,
  entries,
}: {
  title: string;
  tone: string;
  entries: ReadonlyArray<{ item: string; detail: string }>;
}): React.ReactElement {
  return (
    <div>
      <h4 className={`text-sm font-semibold ${tone} mb-1`}>{title}</h4>
      <ul className="space-y-1">
        {entries.map((e) => (
          <li key={e.item} className="text-xs text-gray-700">
            <span className="font-medium">{e.item}</span> — {e.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default ConfirmMigration;
