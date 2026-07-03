import { describe, it, expect } from 'vitest';
import { SingleFlight } from './single-flight';

describe('SingleFlight', () => {
  it('reports running state and clears after completion', async () => {
    const sf = new SingleFlight();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = sf.run('k', async () => {
      await gate;
    });
    expect(sf.isRunning('k')).toBe(true);
    release();
    await p;
    expect(sf.isRunning('k')).toBe(false);
  });

  it('clears the key even if the task throws', async () => {
    const sf = new SingleFlight();
    await expect(
      sf.run('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(sf.isRunning('k')).toBe(false);
  });
});
