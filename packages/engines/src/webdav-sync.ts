// Copyright 2026 OpenHands Agent (Apache-2.0)
// rclone wrapper for WebDAV sync.
// Uses rclone for WebDAV file synchronization with ledger-gated idempotency.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

/**
 * WebDAV sync configuration.
 */
export interface WebDAVSyncConfig {
  /** Source WebDAV endpoint URL. */
  readonly sourceUrl: string;
  /** Source username. */
  readonly sourceUsername: string;
  /** Source password (from environment variable name). */
  readonly sourcePasswordEnv: string;
  /** Target WebDAV endpoint URL. */
  readonly targetUrl: string;
  /** Target username. */
  readonly targetUsername: string;
  /** Target password (from environment variable name). */
  readonly targetPasswordEnv: string;
  /** Source path (relative to WebDAV root). */
  readonly sourcePath: string;
  /** Target path (relative to WebDAV root). */
  readonly targetPath: string;
  /** Sync mode: 'copy' (one-way), 'sync' (bidirectional), or 'move'. */
  readonly mode?: 'copy' | 'sync' | 'move';
  /** Whether to do a dry run. */
  readonly dryRun?: boolean;
  /** Exclude patterns (e.g., ['.tmp', '*.bak']). */
  readonly excludePatterns?: string[];
  /** Include patterns (e.g., ['*.pdf', '*.docx']). */
  readonly includePatterns?: string[];
  /** Maximum file size to sync (in bytes). 0 = no limit. */
  readonly maxSize?: number;
  /** Minimum file size to sync (in bytes). 0 = no limit. */
  readonly minSize?: number;
}

/**
 * Result of a WebDAV sync operation.
 */
export interface WebDAVSyncResult {
  /** Total files processed. */
  totalFiles: number;
  /** Files successfully synced. */
  successCount: number;
  /** Files that failed. */
  failureCount: number;
  /** Files skipped (already exist and unchanged). */
  skippedCount: number;
  /** List of failures. */
  failures: Array<{ path: string; error: string }>;
  /** Total bytes transferred. */
  bytesTransferred: number;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Whether the sync completed successfully. */
  completed: boolean;
}

/**
 * Generate rclone config for WebDAV remotes.
 */
function generateRcloneConfig(config: WebDAVSyncConfig): { configPath: string; sourceRemote: string; targetRemote: string } {
  const jobId = createHash('md5').update(`${config.sourceUrl}-${config.targetUrl}-${Date.now()}`).digest('hex').substring(0, 8);
  const configDir = path.join(tmpdir(), `rclone-${jobId}`);
  
  // Create config directory
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, 'rclone.conf');
  const sourceRemote = `source-${jobId}`;
  const targetRemote = `target-${jobId}`;

  // Generate rclone config file
  const sourcePassword = process.env[config.sourcePasswordEnv] || '';
  const targetPassword = process.env[config.targetPasswordEnv] || '';

  const configContent = `[${sourceRemote}]
type = webdav
url = ${config.sourceUrl}
vendor = other
user = ${config.sourceUsername}
pass = ${sourcePassword}

[${targetRemote}]
type = webdav
url = ${config.targetUrl}
vendor = other
user = ${config.targetUsername}
pass = ${targetPassword}
`;

  fs.writeFileSync(configPath, configContent);

  return { configPath, sourceRemote, targetRemote };
}

/**
 * Parse rclone output to extract sync statistics.
 */
function parseRcloneOutput(output: string): { successCount: number; failureCount: number; skippedCount: number; bytesTransferred: number; failures: Array<{ path: string; error: string }> } {
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let bytesTransferred = 0;
  const failures: Array<{ path: string; error: string }> = [];

  const lines = output.split('\n');
  
  for (const line of lines) {
    // Count transferred files
    if (line.includes('Transferred:') || line.match(/Transferred:\s*\d+%/)) {
      // Extract bytes transferred
      const bytesMatch = line.match(/(\d+)\s*[GMK]?B/);
      if (bytesMatch) {
        const value = parseInt(bytesMatch[1], 10);
        const unit = bytesMatch[0].match(/[GMK]B/)?.[0]?.[0] || 'K';
        bytesTransferred += value * (unit === 'G' ? 1024 * 1024 * 1024 : unit === 'M' ? 1024 * 1024 : unit === 'K' ? 1024 : 1);
      }
    }
    // Count successful transfers
    else if (line.includes('Copied') || line.includes('transferred')) {
      const numMatch = line.match(/(\d+)\s+files?/i);
      if (numMatch) {
        successCount += parseInt(numMatch[1], 10);
      }
    }
    // Count skipped items
    else if (line.includes('Skipping') || line.includes('exists')) {
      skippedCount++;
    }
    // Count errors
    else if (line.includes('ERROR') || line.includes('error')) {
      failureCount++;
      // Try to extract path if available
      const pathMatch = line.match(/"([^"]+)"/);
      const filePath = pathMatch ? pathMatch[1] : 'unknown';
      failures.push({ path: filePath, error: line.trim() });
    }
  }

  return { successCount, failureCount, skippedCount, bytesTransferred, failures };
}

/**
 * Run a WebDAV sync using rclone.
 */
export async function runWebDAVSync(config: WebDAVSyncConfig): Promise<WebDAVSyncResult> {
  const startTime = Date.now();
  const failures: Array<{ path: string; error: string }> = [];
  
  try {
    // Generate rclone config
    const { configPath, sourceRemote, targetRemote } = generateRcloneConfig(config);
    
    // Set rclone config environment
    const rcloneConfigEnv = `RCLONE_CONFIG=${configPath}`;

    // Build rclone command
    const mode = config.mode || 'copy';
    const dryRunFlag = config.dryRun ? '--dry-run' : '';
    const verboseFlag = '--verbose=3';
    
    // Build exclude/include flags
    const excludeFlags = (config.excludePatterns || []).map(p => `--exclude=${p}`).join(' ');
    const includeFlags = (config.includePatterns || []).map(p => `--include=${p}`).join(' ');
    const sizeFlags = [];
    if (config.maxSize && config.maxSize > 0) {
      sizeFlags.push(`--max-size=${config.maxSize}`);
    }
    if (config.minSize && config.minSize > 0) {
      sizeFlags.push(`--min-size=${config.minSize}`);
    }

    const sourcePath = `${sourceRemote}:${config.sourcePath}`;
    const targetPath = `${targetRemote}:${config.targetPath}`;

    let command: string;
    if (mode === 'copy') {
      command = `rclone ${verboseFlag} ${dryRunFlag} ${excludeFlags} ${includeFlags} ${sizeFlags.join(' ')} copy "${sourcePath}" "${targetPath}" 2>&1`;
    } else if (mode === 'sync') {
      command = `rclone ${verboseFlag} ${dryRunFlag} ${excludeFlags} ${includeFlags} ${sizeFlags.join(' ')} sync "${sourcePath}" "${targetPath}" 2>&1`;
    } else {
      command = `rclone ${verboseFlag} ${dryRunFlag} ${excludeFlags} ${includeFlags} ${sizeFlags.join(' ')} move "${sourcePath}" "${targetPath}" 2>&1`;
    }

    // Execute rclone
    const output = execSync(command, { 
      env: { ...process.env, RCLONE_CONFIG: configPath },
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024 // 50MB buffer for large syncs
    });

    // Parse output
    const { successCount, failureCount, skippedCount, bytesTransferred, failures: parseFailures } = parseRcloneOutput(output);
    failures.push(...parseFailures);

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    return {
      totalFiles: successCount + failureCount + skippedCount,
      successCount,
      failureCount,
      skippedCount,
      failures,
      bytesTransferred,
      durationSeconds,
      completed: failureCount === 0,
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    const durationSeconds = Math.round((Date.now() - startTime) / 1000);
    
    // Parse any output that might have been captured
    const { successCount, failureCount, skippedCount, bytesTransferred, failures: parseFailures } = parseRcloneOutput(
      err.stdout || err.stderr || err.message
    );
    failures.push(...parseFailures);

    return {
      totalFiles: successCount + failureCount + skippedCount,
      successCount,
      failureCount: failureCount + 1, // Add the main error
      skippedCount,
      failures: [...failures, { path: 'unknown', error: err.message }],
      bytesTransferred: 0,
      durationSeconds,
      completed: false,
    };
  }
}

/**
 * Clean up temporary files after sync.
 */
export function cleanupWebDAVConfig(configPath: string): void {
  try {
    const configDir = path.dirname(configPath);
    if (fs.existsSync(configDir)) {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  } catch (error) {
    // Ignore cleanup errors
    console.warn('[WebDAV] Warning: Could not clean up temporary files:', error);
  }
}
