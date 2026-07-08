/**
 * Trigger.dev Client Configuration
 *
 * This module sets up the Trigger.dev client for the managed edition.
 * Configure environment variables in .env:
 *
 * TRIGGER_DEV_ACCESS_TOKEN=your_access_token
 * TRIGGER_DEV_BASE_URL=https://api.trigger.dev (Cloud) or http://localhost:3000 (self-hosted)
 */

import { TriggerClient } from '@trigger.dev/sdk/v3';

export const triggerClient = new TriggerClient({
  accessToken: process.env.TRIGGER_DEV_ACCESS_TOKEN,
  baseURL: process.env.TRIGGER_DEV_BASE_URL || 'http://localhost:3000',
});

/**
 * Helper to get the client for manual triggers
 */
export function getTriggerClient(): TriggerClient {
  return triggerClient;
}
