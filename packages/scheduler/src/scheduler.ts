import { NotImplementedError, type Scheduler, type ScheduleHandle } from '@openmig/shared';
import { SingleFlight } from './single-flight';

/**
 * In-process scheduler for the self-host edition (workplan 0001, T6).
 *
 * `runOnce` is implemented with **single-flight per jobId**: concurrent triggers for the same job
 * coalesce into one run (no overlapping runs). Cron scheduling (`schedule`) is wired with croner by
 * the agent; each tick should dispatch through the same `SingleFlight` so overlapping ticks coalesce.
 */
export class InProcessScheduler implements Scheduler {
  private readonly sf = new SingleFlight();

  runOnce(jobId: string, task: () => Promise<void>): Promise<void> {
    return this.sf.run(jobId, task);
  }

  schedule(_jobId: string, _cron: string, _task: () => Promise<void>): ScheduleHandle {
    // TODO(T6): wire croner. On each tick call `this.sf.run(jobId, task)` so overlapping ticks
    // coalesce, and return a handle whose stop() cancels the croner job.
    throw new NotImplementedError('InProcessScheduler.schedule (workplan 0001, T6) — needs croner');
  }
}
