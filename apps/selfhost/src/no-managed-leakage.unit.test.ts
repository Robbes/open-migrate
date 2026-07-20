// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Hard rule 5 guard (workplan 0010, T2/T3 "no managed leakage").
 *
 * The self-host appliance must never load managed-only code — no Trigger.dev,
 * no billing/Mollie, no RLS app-user path. This test walks the *actual*
 * transitive `@openmig`/relative import graph starting from the selfhost
 * entrypoint and fails if any reachable module imports a forbidden specifier.
 *
 * It is a real graph walk (not a grep of one file), so it catches transitive
 * regressions — e.g. importing `@openmig/scheduler` (the package index, which
 * re-exports the Trigger.dev client) instead of `@openmig/scheduler/in-process`.
 * It resolves only `@openmig/*` and relative imports (the code we own); bare
 * third-party specifiers are checked against the forbidden list but not walked.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/selfhost/src -> repo root
const ROOT = resolve(HERE, '..', '..', '..');
const ENTRY = join(ROOT, 'apps/selfhost/src/index.ts');

const PKG_DIRS: Record<string, string> = {
  '@openmig/shared': 'packages/shared/src',
  '@openmig/ledger': 'packages/ledger/src',
  '@openmig/core': 'packages/core/src',
  '@openmig/connectors': 'packages/connectors/src',
  '@openmig/engines': 'packages/engines/src',
  '@openmig/provisioner': 'packages/provisioner/src',
  '@openmig/scheduler': 'packages/scheduler/src',
  '@openmig/worker': 'apps/worker/src',
};

/** A specifier that must never be reachable from the self-host graph. */
function forbiddenReason(spec: string): string | null {
  if (/^@trigger\.dev(\/|$)/.test(spec)) return 'Trigger.dev SDK (managed orchestration)';
  if (/^@mollie(\/|$)/.test(spec) || /mollie/i.test(spec)) return 'Mollie billing client';
  if (/(^|\/)billing(\/|$)/.test(spec)) return 'billing module';
  // The scheduler index re-exports the Trigger.dev client — self-host must use
  // the trigger-free `/in-process` subpath instead.
  if (spec === '@openmig/scheduler' || spec === '@openmig/scheduler/index') {
    return 'scheduler package index (use @openmig/scheduler/in-process)';
  }
  return null;
}

/** Resolve an `@openmig/*` or relative specifier to an on-disk .ts file, or null. */
function resolveToFile(spec: string, fromFile: string): string | null {
  if (spec === '@openmig/scheduler/in-process') {
    return join(ROOT, 'packages/scheduler/src/scheduler.ts');
  }
  if (spec === '@openmig/worker/orchestration') {
    return join(ROOT, 'apps/worker/src/orchestration.ts');
  }

  let base: string | null = null;
  if (spec.startsWith('.')) {
    base = resolve(dirname(fromFile), spec);
  } else {
    const m = /^(@openmig\/[a-z]+)(?:\/(.+))?$/.exec(spec);
    if (m) {
      const dir = PKG_DIRS[m[1]!];
      if (!dir) return null;
      base = join(ROOT, dir, m[2] ?? 'index');
    }
  }
  if (!base) return null;

  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

const IMPORT_RE = /(?:from|import)\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(source: string): string[] {
  const specs = new Set<string>();
  for (const re of [IMPORT_RE, DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) specs.add(m[1]!);
  }
  return [...specs];
}

interface Violation {
  file: string;
  spec: string;
  reason: string;
}

function walk(entry: string): { visited: Set<string>; violations: Violation[] } {
  const visited = new Set<string>();
  const violations: Violation[] = [];
  const queue: string[] = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = readFileSync(file, 'utf-8');
    for (const spec of specifiersOf(source)) {
      const reason = forbiddenReason(spec);
      if (reason) {
        violations.push({ file: file.slice(ROOT.length + 1), spec, reason });
      }
      const next = resolveToFile(spec, file);
      if (next && !visited.has(next)) queue.push(next);
    }
  }
  return { visited, violations };
}

describe('self-host has no managed-only leakage (hard rule 5)', () => {
  const { visited, violations } = walk(ENTRY);

  it('walks a non-trivial module graph (guards against a broken resolver)', () => {
    // The entrypoint reaches shared/ledger/scheduler/worker-orchestration and
    // their local deps — if this collapses to a couple of files the walk is
    // broken and the leakage check below would pass vacuously.
    expect(visited.size).toBeGreaterThan(8);
  });

  it('imports no Trigger.dev / billing / Mollie anywhere in its reachable graph', () => {
    expect(violations).toEqual([]);
  });
});
