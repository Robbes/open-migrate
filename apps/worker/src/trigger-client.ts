/**
 * Trigger.dev Client Configuration
 * 
 * This module sets up the Trigger.dev client for the managed edition.
 * Configure environment variables in .env:
 * 
 * TRIGGER_DEV_API_KEY=your_api_key
 * TRIGGER_DEV_API_URL=https://app.trigger.dev (Cloud) or http://localhost:3000 (self-hosted)
 */

import { TriggerClient } from '@trigger.dev/sdk';

export const triggerClient = new TriggerClient({
  id: 'open-migrate-worker',
  apiKey: process.env.TRIGGER_DEV_API_KEY,
  apiUrl: process.env.TRIGGER_DEV_API_URL || 'http://localhost:3000',
});

/**
 * Helper to get the client for manual triggers
 */
export function getTriggerClient(): TriggerClient {
  return triggerClient;
}
