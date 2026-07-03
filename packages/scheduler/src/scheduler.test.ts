import { describe, it, expect } from 'vitest';
import { InProcessScheduler } from './scheduler';

describe('InProcessScheduler.runOnce (single-flight)', () => {
  it('coalesces concurrent runs of the same job', async () => {
    const sched = new InProcessScheduler();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const task = async () => {
      calls++;
      await gate;
    };

    const p1 = sched.runOnce('job', task);
    const p2 = sched.runOnce('job', task); // joins the in-flight run instead of starting a second
    release();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  it('runs again after the previous run finished', async () => {
    const sched = new InProcessScheduler();
    let calls = 0;
    const task = async () => {
      calls++;
    };
    await sched.runOnce('job', task);
    await sched.runOnce('job', task);
    expect(calls).toBe(2);
  });

  it('runs different jobs independently', async () => {
    const sched = new InProcessScheduler();
    let a = 0;
    let b = 0;
    await Promise.all([
      sched.runOnce('a', async () => {
        a++;
      }),
      sched.runOnce('b', async () => {
        b++;
      }),
    ]);
    expect([a, b]).toEqual([1, 1]);
  });
});
