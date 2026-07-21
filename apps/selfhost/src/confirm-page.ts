// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Minimal, dependency-free confirm page for the self-host appliance (workplan 0013 T7). Rendered
 * as a single static HTML string (no bundler, no framework — hard rule 5) showing the read-only
 * discovery counts + the §11.2 scope manifest per configured mapping, with a "Start migration"
 * button that POSTs to the appliance's activation endpoint. Pure function → fully unit-testable.
 */

import type { DiscoveryRecord, ScopeManifest, DiscoveryDomain } from '@openmig/shared';

export interface MappingConfirmView {
  readonly mappingId: string;
  /** 'paused' (awaiting green light) | 'active' | 'cutover' | 'done'. */
  readonly status: string;
  readonly domains: ReadonlyArray<DiscoveryRecord>;
}

export interface ConfirmPageData {
  readonly mappings: ReadonlyArray<MappingConfirmView>;
  readonly manifest: ScopeManifest;
}

const DOMAIN_LABEL: Record<DiscoveryDomain, string> = {
  email: 'Email',
  calendar: 'Calendar',
  contact: 'Contacts',
  file: 'Files',
};

/** Escape text for safe interpolation into HTML. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

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

function countsTable(domains: ReadonlyArray<DiscoveryRecord>): string {
  if (domains.length === 0) {
    return `<p class="muted">Scanning your source (read-only)…</p>`;
  }
  const rows = domains
    .map(
      (d) =>
        `<tr><td>${esc(DOMAIN_LABEL[d.domain])}</td><td>${d.collections}</td><td>${d.items}</td><td>${esc(formatBytes(d.bytes))}</td>${d.lastError ? `<td class="err">${esc(d.lastError)}</td>` : '<td></td>'}</tr>`,
    )
    .join('');
  return `<table><thead><tr><th>Type</th><th>Collections</th><th>Items</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function manifestColumn(title: string, entries: ScopeManifest['migrates']): string {
  const items = entries.map((e) => `<li><b>${esc(e.item)}</b> — ${esc(e.detail)}</li>`).join('');
  return `<div class="col"><h4>${esc(title)}</h4><ul>${items}</ul></div>`;
}

function mappingSection(m: MappingConfirmView): string {
  const startForm =
    m.status === 'paused'
      ? `<form method="POST" action="/mappings/${encodeURIComponent(m.mappingId)}/start"><button type="submit">Start migration</button></form>`
      : `<p class="active">Status: <b>${esc(m.status)}</b></p>`;
  return `<section class="mapping"><h3>${esc(m.mappingId)}</h3>${countsTable(m.domains)}${startForm}</section>`;
}

/** Render the whole confirm page as an HTML document string. */
export function renderConfirmPage(data: ConfirmPageData): string {
  const mappings = data.mappings.map(mappingSection).join('');
  const manifest = `<section class="manifest"><h3>What migrates</h3><div class="cols">${manifestColumn(
    'Migrates',
    data.manifest.migrates,
  )}${manifestColumn('Partial', data.manifest.partial)}${manifestColumn(
    'Does not migrate',
    data.manifest.doesNotMigrate,
  )}</div></section>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Migration — review &amp; confirm</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem} h3{margin-top:1.5rem} .muted{color:#666} .err{color:#b00}
table{border-collapse:collapse;width:100%;font-size:.9rem} th,td{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #eee}
button{background:#2563eb;color:#fff;border:0;border-radius:.4rem;padding:.5rem 1.25rem;font-size:1rem;cursor:pointer;margin-top:.75rem}
.cols{display:flex;gap:1rem;flex-wrap:wrap} .col{flex:1;min-width:200px} .col li{font-size:.8rem;margin:.2rem 0} .active{color:#155}
</style></head>
<body>
<h1>Review &amp; confirm your migration</h1>
<p class="muted">Nothing has been copied yet. Review what will migrate, then start it.</p>
${mappings || '<p class="muted">No mappings configured.</p>'}
${manifest}
</body></html>`;
}
