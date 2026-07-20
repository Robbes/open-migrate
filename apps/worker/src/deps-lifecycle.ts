// Copyright 2026 The Open Migration Stack authors (Apache-2.0)

/**
 * Deps-lifecycle helper (bug fix — self-host pool leak).
 *
 * The deps-builders (`build-deps.ts`, `build-deps-from-mapping.ts`) open a
 * Postgres pool (`createPgDb`) to back the ledger/cursor stores for a single
 * pass. That pool must be released when the pass finishes, or a long-running
 * process (the self-host appliance's scheduler, a busy worker) leaks a pool per
 * pass until Postgres runs out of connections.
 *
 * The deps interfaces (`ReconcileDeps`, `CalendarSyncDeps`, …) are shared and
 * carry no disposal hook, so we augment the returned object with a `close()`
 * that ends the pool. Callers run the pass in `try { … } finally { await
 * deps.close() }`. `close()` is idempotent (pool.end() is safe to call once;
 * we guard against a double call).
 */

/** Deps augmented with a handle that releases the Postgres pool the builder opened. */
export type WithClose<T> = T & { readonly close: () => Promise<void> };

/** Attach an idempotent `close()` (backed by `db.close()`) to a deps object. */
export function withClose<T extends object>(
  deps: T,
  db: { close: () => Promise<void> },
): WithClose<T> {
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await db.close();
  };
  return Object.assign(deps, { close }) as WithClose<T>;
}
