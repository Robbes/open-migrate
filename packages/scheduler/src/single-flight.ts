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
    // Defer task() to a microtask so `set` below always runs before the promise
    // can settle. A task that throws SYNCHRONOUSLY then becomes a rejection that
    // is still tracked and cleaned up — never left stuck in the map (which would
    // permanently wedge this key).
    const p = Promise.resolve().then(task);
    this.inflight.set(key, p);
    // Clean up on settle (both branches handled, so the cleanup chain itself
    // never surfaces an unhandled rejection; callers still see `p` reject).
    p.then(
      () => this.inflight.delete(key),
      () => this.inflight.delete(key),
    );
    return p;
  }

  isRunning(key: string): boolean {
    return this.inflight.has(key);
  }
}
