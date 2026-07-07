import { type Scheduler, type ScheduleHandle } from '@openmig/shared';
import { SingleFlight } from './single-flight';
import { Cron } from 'croner';

/**
 * In-process scheduler for the self-host edition (workplan 0001, T6).
 *
 * `runOnce` is implemented with **single-flight per jobId**: concurrent calls coalesce into one run.
 * `schedule` uses croner; each tick dispatches through the same `SingleFlight` so overlapping ticks
 * coalesce.
 */
export class InProcessScheduler implements Scheduler {
  private readonly sf = new SingleFlight();

  runOnce(jobId: string, task: () => Promise<void>): Promise<void> {
    return this.sf.run(jobId, task);
  }

  schedule(jobId: string, cron: string, task: () => Promise<void>): ScheduleHandle {
    // Use paused: true to prevent immediate execution, then resume to start
    const job = new Cron(cron, { paused: true }, async () => {
      await this.sf.run(jobId, task);
    });

    job.resume();

    return {
      stop: () => {
        job.stop();
      },
    };
  }
}
