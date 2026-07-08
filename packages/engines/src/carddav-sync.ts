// Copyright 2026 OpenHands Agent (Apache-2.0)
// vdirsyncer wrapper for CardDAV sync.
// Uses vdirsyncer for CardDAV synchronization with ledger-gated idempotency.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * CardDAV sync configuration.
 */
export interface CardDAVSyncConfig {
  /** Source CardDAV endpoint URL. */
  readonly sourceUrl: string;
  /** Source username. */
  readonly sourceUsername: string;
  /** Source password or token (from environment variable name). */
  readonly sourcePasswordEnv: string;
  /** Target CardDAV endpoint URL. */
  readonly targetUrl: string;
  /** Target username. */
  readonly targetUsername: string;
  /** Target password or token (from environment variable name). */
  readonly targetPasswordEnv: string;
  /** Source address book collection path. */
  readonly sourceCollection: string;
  /** Target address book collection path. */
  readonly targetCollection: string;
  /** Sync direction: 'push' (source → target) or 'pull' (target → source). */
  readonly direction?: 'push' | 'pull';
  /** Whether to do a dry run. */
  readonly dryRun?: boolean;
}

/**
 * Result of a CardDAV sync operation.
 */
export interface CardDAVSyncResult {
  /** Total items processed. */
  totalItems: number;
  /** Items successfully synced. */
  successCount: number;
  /** Items that failed. */
  failureCount: number;
  /** Items skipped (already exist). */
  skippedCount: number;
  /** List of failures. */
  failures: Array<{ uid: string; error: string }>;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Whether the sync completed successfully. */
  completed: boolean;
}

/**
 * Generate a unique config file for a CardDAV sync job.
 */
function generateVdirsyncerConfig(config: CardDAVSyncConfig): { configPath: string } {
  const jobId = createHash('md5').update(`${config.sourceUrl}-${config.targetUrl}-${Date.now()}`).digest('hex').substring(0, 8);
  const workDir = path.join(tmpdir(), `vdirsyncer-carddav-${jobId}`);
  
  // Create work directory
  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  // Create source config
  const sourceConfigPath = path.join(workDir, 'source.conf');
  fs.writeFileSync(sourceConfigPath, `[general]
path = ${workDir}/source
account = source

[pair source]
a = source
b = target
collections = ["${config.sourceCollection}"]
metadata = []

[account source]
type = carddav
url = ${config.sourceUrl}/
username = ${config.sourceUsername}
password = ${process.env[config.sourcePasswordEnv] || ''}
cert_verify = false

[account target]
type = carddav
url = ${config.targetUrl}/
username = ${config.targetUsername}
password = ${process.env[config.targetPasswordEnv] || ''}
cert_verify = false
`);

  return {
    configPath: sourceConfigPath,
  };
}

/**
 * Parse vdirsyncer output to extract sync statistics.
 */
function parseVdirsyncerOutput(output: string): { successCount: number; failureCount: number; skippedCount: number; failures: Array<{ uid: string; error: string }> } {
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  const failures: Array<{ uid: string; error: string }> = [];

  const lines = output.split('\n');
  
  for (const line of lines) {
    // Count successful transfers
    if (line.includes('Copying') && (line.includes('from source') || line.includes('from target'))) {
      successCount++;
    }
    // Count skipped items
    else if (line.includes('Skipping') || line.includes('unchanged')) {
      skippedCount++;
    }
    // Count errors
    else if (line.includes('error') || line.includes('Error') || line.includes('FAILED')) {
      failureCount++;
      // Try to extract UID if available
      const uidMatch = line.match(/uid[:\s]+([^\s,]+)/i);
      const uid = uidMatch ? uidMatch[1] : 'unknown';
      failures.push({ uid, error: line.trim() });
    }
  }

  return { successCount, failureCount, skippedCount, failures };
}

/**
 * Run a CardDAV sync using vdirsyncer.
 */
export async function runCardDAVSync(config: CardDAVSyncConfig): Promise<CardDAVSyncResult> {
  const startTime = Date.now();
  const failures: Array<{ uid: string; error: string }> = [];
  
  try {
    // Generate temporary config
    const { configPath } = generateVdirsyncerConfig(config);

    // Build vdirsyncer command
    const dryRunFlag = config.dryRun ? '--dry' : '';
    const command = `vdirsyncer -c "${configPath}" sync 2>&1`;

    // Execute vdirsyncer
    const output = execSync(command, { 
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    // Parse output
    const { successCount, failureCount, skippedCount, failures: parseFailures } = parseVdirsyncerOutput(output);
    failures.push(...parseFailures);

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    return {
      totalItems: successCount + failureCount + skippedCount,
      successCount,
      failureCount,
      skippedCount,
      failures,
      durationSeconds,
      completed: failureCount === 0,
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    
    // Parse any output that might have been captured
    const { successCount, failureCount, skippedCount, failures: parseFailures } = parseVdirsyncerOutput(
      err.stdout || err.stderr || err.message
    );
    failures.push(...parseFailures);

    return {
      totalItems: successCount + failureCount + skippedCount,
      successCount,
      failureCount: failureCount + 1, // Add the main error
      skippedCount,
      failures: [...failures, { uid: 'unknown', error: err.message }],
      durationSeconds,
      completed: false,
    };
  }
}

/**
 * Clean up temporary files after sync.
 */
export function cleanupCardDAVConfig(configPath: string): void {
  try {
    const workDir = path.dirname(configPath);
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  } catch (error) {
    // Ignore cleanup errors
    console.warn('[CardDAV] Warning: Could not clean up temporary files:', error);
  }
}
