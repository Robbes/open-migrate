/**
 * Run `worker` over `items` with at most `limit` in flight at once.
 *
 * Improves throughput on I/O-bound work (parallel fetch/write) while **bounding peak memory** —
 * at most `limit` items are processed concurrently, so at most `limit` payloads are held at once.
 * Completion order is not guaranteed. **Fail-fast:** on the first worker error it stops scheduling
 * new work, lets in-flight workers settle, then rejects with that first error.
 */
export async function mapWithConcurrency<T>(
  items: ReadonlyArray<T>,
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  const max = Math.max(1, Math.min(Math.floor(limit), n));

  let next = 0;
  let hasError = false;
  let firstError: unknown;
  const runner = async (): Promise<void> => {
    while (!hasError) {
      const i = next;
      next += 1;
      if (i >= n) return;
      const item = items[i];
      if (item === undefined) continue; // unreachable for i < n; satisfies noUncheckedIndexedAccess
      try {
        await worker(item, i);
      } catch (e) {
        if (!hasError) {
          hasError = true;
          firstError = e;
        }
        return; // fail-fast: stop pulling new work; in-flight workers settle, then we rethrow
      }
    }
  };

  await Promise.all(Array.from({ length: max }, () => runner()));
  if (hasError) throw firstError;
}
