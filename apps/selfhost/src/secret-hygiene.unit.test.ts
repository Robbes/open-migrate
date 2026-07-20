// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Secret-hygiene gate (workplan 0010 T4 — "no secret appears in image layers,
 * logs, or /status output").
 *
 * Two Docker-free properties:
 *
 *  1. `/status` is allow-list based. `buildStatusReport` reads only the
 *     whitelisted status fields (domain/state/counts/timestamps/lastError) — it
 *     never echoes the mapping config or its credentials. We prove this by
 *     feeding a status object that also carries a secret in a non-whitelisted
 *     field and asserting the serialized report does not contain it.
 *
 *  2. The image build context excludes env-files. The self-host Dockerfile
 *     `COPY . .`s the repo, so the root `.dockerignore` must keep `.env` /
 *     `*.env` out of the context (only `*.example` is allowed) — otherwise a
 *     filled-in secret could be baked into an image layer.
 *
 * `lastError` is surfaced verbatim by design (SAD §11.2); the contract is that
 * connectors must not embed secrets in error strings. This test documents that
 * a normal error passes through unchanged and carries no credential.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationStatus } from '@openmig/shared';
import { buildStatusReport } from './status';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

const SECRET = 'hunter2-super-secret-token';

/** A status row that ALSO smuggles a secret in a field `/status` must not read. */
function statusWithHiddenSecret(): MigrationStatus {
  return {
    id: 'run-1',
    tenantId: '00000000-0000-4000-8000-000000000001' as MigrationStatus['tenantId'],
    mappingId: '11111111-1111-4111-8111-111111111111' as MigrationStatus['mappingId'],
    domain: 'email',
    state: 'completed',
    itemsSynced: 42,
    itemsFailed: 0,
    bytesTransferred: 1024,
    startedAt: '2026-07-20T10:00:00.000Z',
    updatedAt: '2026-07-20T10:05:00.000Z',
    completedAt: '2026-07-20T10:05:00.000Z',
    // Not part of MigrationStatus — simulate an upstream row carrying config /
    // credentials the formatter must never surface.
    ...({ password: SECRET, sourceConfig: { auth: { token: SECRET } } } as Record<string, unknown>),
  } as MigrationStatus;
}

describe('self-host /status secret hygiene (T4)', () => {
  it('serializes only whitelisted fields — never config or credentials', () => {
    const report = buildStatusReport([
      { mappingId: 'm1', statuses: [statusWithHiddenSecret()] },
    ]);
    const json = JSON.stringify(report);

    expect(json).not.toContain(SECRET);
    // Sanity: the legitimate, whitelisted fields ARE present.
    const domain = report.mappings[0]!.domains[0]!;
    expect(domain.state).toBe('completed');
    expect(domain.itemsSynced).toBe(42);
    // The formatter exposes no unexpected keys on a domain report.
    expect(Object.keys(domain).sort()).toEqual(
      ['bytesTransferred', 'domain', 'itemsFailed', 'itemsSynced', 'lastSyncedAt', 'state'].sort(),
    );
  });

  it('passes a benign lastError through verbatim (§11.2) without inventing content', () => {
    const base = statusWithHiddenSecret();
    const withError: MigrationStatus = { ...base, state: 'failed', lastError: 'ECONNREFUSED contacting target' };
    const report = buildStatusReport([{ mappingId: 'm1', statuses: [withError] }]);
    const domain = report.mappings[0]!.domains[0]!;
    expect(domain.lastError).toBe('ECONNREFUSED contacting target');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('.dockerignore keeps env-files out of the image build context', () => {
    const dockerignore = readFileSync(join(ROOT, '.dockerignore'), 'utf-8');
    const lines = dockerignore.split('\n').map((l) => l.trim());
    // Secrets must be excluded…
    expect(lines).toContain('**/.env');
    expect(lines).toContain('**/.env.*');
    // …while the committed templates stay available.
    expect(lines).toContain('!**/.env.example');
  });
});
