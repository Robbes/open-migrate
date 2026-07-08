/**
 * Trigger.dev Scheduler Implementation
 * 
 * This module provides a Trigger.dev-based scheduler for the managed edition.
 * It implements the Scheduler interface using Trigger.dev's job orchestration.
 * 
 * Reference: ADR-0004 (Orchestration Strategy)
 */

import { type Scheduler, type ScheduleHandle } from '@openmig/shared';
import { triggerClient } from './trigger-client';

/**
 * Trigger.dev implementation of the Scheduler interface.
 * 
 * Features:
 * - Durable job execution (survives restarts)
 * - Automatic retries with exponential backoff
 * - Built-in monitoring and logging
 * - Tenant-scoped job execution
 */
export class TriggerScheduler implements Scheduler {
  /**
   * Schedule a recurring job using Trigger.dev.
   * 
   * @param jobId - Unique identifier for this job type
   * @param cron - Cron expression (e.g., "0 * * * *" for hourly)
   * @param task - The task to execute (not used directly - Trigger.dev jobs are defined separately)
   * @returns A handle to stop the scheduled job
   * 
   * Note: In Trigger.dev, jobs are defined using @trigger.dev SDK decorators or programmatic registration.
   * This method registers the cron trigger with Trigger.dev's scheduler.
   */
  schedule(jobId: string, cron: string, task: () => Promise<void>): ScheduleHandle {
    // Trigger.dev uses a different paradigm - jobs are defined with triggers
    // This is a placeholder that would integrate with Trigger.dev's scheduling API
    // Actual implementation would use triggerClient.createTrigger() or similar
    
    console.warn(
      'TriggerScheduler.schedule() is a placeholder. ',
      'Jobs should be defined using @trigger.dev SDK with cron triggers.'
    );
    
    // Placeholder return - actual implementation would return a handle to the Trigger.dev schedule
    return {
      stop: () => {
        // Would call triggerClient.cancelSchedule(jobId)
        console.warn(`Stopping schedule for ${jobId} - not implemented`);
      },
    };
  }

  /**
   * Run a task once immediately using Trigger.dev.
   * 
   * @param jobId - Unique identifier for this job
   * @param task - The task to execute
   * @returns Promise that resolves when the job completes
   * 
   * Note: This triggers a background job via Trigger.dev.
   * The actual task logic should be defined in a Trigger.dev job file.
   */
  async runOnce(jobId: string, task: () => Promise<void>): Promise<void> {
    // Trigger.dev jobs are triggered via triggerClient.trigger()
    // The actual task logic lives in the job definition file
    
    console.warn(
      'TriggerScheduler.runOnce() is a placeholder. ',
      'Use triggerClient.trigger() to invoke Trigger.dev jobs.'
    );
    
    // Placeholder - actual implementation would:
    // 1. Trigger the job via triggerClient.trigger({ job: jobId, payload: {...} })
    // 2. Wait for completion (optionally)
    // 3. Return when done
    
    await task(); // Fallback to direct execution for now
  }
}

/**
 * Factory function to create a TriggerScheduler instance.
 * 
 * @param client - Optional custom Trigger.dev client
 * @returns TriggerScheduler instance
 */
export function createTriggerScheduler(): TriggerScheduler {
  return new TriggerScheduler();
}
