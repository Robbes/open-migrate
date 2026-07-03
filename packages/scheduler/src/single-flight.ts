/**
 * Coalesces concurrent runs by key: while a run for `key` is in flight, additional calls join the
 * same promise instead of starting a second concurrent run (single-flight). Used by the in-process
 * scheduler so overlapping triggers/ticks for the same job never overlap (workplan 0001, T6).
 */
export class SingleFlight {
  private readonly inflight = new Map<string, Promise<void>>();

  run(key: string, task: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        await task();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  isRunning(key: string): boolean {
    return this.inflight.has(key);
  }
}
