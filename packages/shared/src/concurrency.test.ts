import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

describe('mapWithConcurrency', () => {
  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 4, async (item) => {
      seen.push(item);
    });
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });

  it('never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(items, 3, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1); // actually ran in parallel
  });

  it('resolves immediately for an empty list', async () => {
    let called = 0;
    await mapWithConcurrency([], 4, async () => {
      called += 1;
    });
    expect(called).toBe(0);
  });

  it('rejects if a worker throws', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('fails fast: stops scheduling new work after the first error', async () => {
    let processed = 0;
    const items = Array.from({ length: 100 }, (_, i) => i);
    await expect(
      mapWithConcurrency(items, 4, async (x) => {
        processed += 1;
        if (x === 0) throw new Error('boom');
        await new Promise((r) => setTimeout(r, 1));
      }),
    ).rejects.toThrow('boom');
    expect(processed).toBeLessThan(items.length);
  });
});
