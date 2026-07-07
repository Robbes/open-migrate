import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('InProcessScheduler.schedule (croner)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers task on cron tick', async () => {
    const sched = new InProcessScheduler();
    let calls = 0;
    const task = async () => {
      calls++;
    };

    // Schedule every 1 second
    const handle = sched.schedule('test-job', '* * * * * *', task);

    // Advance exactly 1 second to trigger one tick
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toBe(1);

    // Stop the job
    handle.stop();

    // Advance another second - should not trigger
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
  });

  it('allows multiple independent scheduled jobs', async () => {
    const sched = new InProcessScheduler();
    let a = 0;
    let b = 0;

    const handleA = sched.schedule('job-a', '* * * * * *', async () => {
      a++;
    });
    const handleB = sched.schedule('job-b', '* * * * * *', async () => {
      b++;
    });

    // Advance exactly 1 second to trigger one tick for each job
    await vi.advanceTimersByTimeAsync(1000);

    expect(a).toBe(1);
    expect(b).toBe(1);

    handleA.stop();
    handleB.stop();
  });
});
