// Copyright 2026 OpenHands Agent (Apache-2.0)
// imapsync wrapper for bulk initial copy.
// Uses imapsync CLI for fast initial migration, with ledger-gated idempotency.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

// Inline types to avoid dependency issues
interface ImapOAuth2Source {
  readonly type: 'imap-oauth2';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: {
    readonly kind: 'xoauth2' | 'login';
    readonly tokenFromEnv?: string;
    readonly passwordFromEnv?: string;
  };
}

interface ImapDavTarget {
  readonly type: 'imap-dav';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: {
    readonly kind: 'xoauth2' | 'login';
    readonly tokenFromEnv?: string;
    readonly passwordFromEnv?: string;
  };
}

/**
 * Result of a bulk imapsync operation.
 */
export interface BulkSyncResult {
  /** Total messages copied. */
  totalMessages: number;
  /** Messages successfully copied. */
  successCount: number;
  /** Messages that failed. */
  failureCount: number;
  /** List of failed folders/messages (if any). */
  failures: Array<{ folder: string; message: string; error: string }>;
  /** Duration in seconds. */
  durationSeconds: number;
  /** Whether the sync completed successfully (even if some messages failed). */
  completed: boolean;
}

/**
 * Configuration for imapsync bulk sync.
 */
export interface ImapSyncConfig {
  /** Source IMAP configuration. */
  source: ImapOAuth2Source;
  /** Target IMAP configuration. */
  target: ImapDavTarget;
  /** Maximum bytes per second to avoid overwhelming servers (default: 100000). */
  maxBytesPerSecond?: number;
  /** Skip messages larger than this size in bytes (default: 0 = no limit). */
  skipMessageSize?: number;
  /** Timeout in seconds for the imapsync command (default: 3600 = 1 hour). */
  timeoutSeconds?: number;
  /** Enable verbose logging. */
  verbose?: boolean;
}

/**
 * Run imapsync for bulk initial copy between two IMAP servers.
 * 
 * This is an optional optimization for large mailboxes. The ledger-based
 * incremental sync will still run afterward to ensure idempotency and
 * populate the ledger correctly.
 * 
 * @param config - imapsync configuration
 * @returns BulkSyncResult with statistics and status
 */
export async function runImapsyncBulk(config: ImapSyncConfig): Promise<BulkSyncResult> {
  const startTime = Date.now();
  const failures: Array<{ folder: string; message: string; error: string }> = [];
  
  // Create temporary files for passwords
  const sourcePassFile = path.join(tmpdir(), `imapsync-source-${Date.now()}.txt`);
  const targetPassFile = path.join(tmpdir(), `imapsync-target-${Date.now()}.txt`);
  
  try {
    // Get passwords from environment
    const sourcePassword = getSourcePassword(config.source);
    const targetPassword = getTargetPassword(config.target);
    
    if (!sourcePassword || !targetPassword) {
      throw new Error(
        'Source or target password not found in environment. ' +
        'Check the auth configuration for correct environment variable names.'
      );
    }
    
    // Write passwords to temporary files (imapsync --passfile1/2)
    fs.writeFileSync(sourcePassFile, sourcePassword);
    fs.writeFileSync(targetPassFile, targetPassword);
    
    // Build imapsync command
    const cmd = buildImapsyncCommand(config, sourcePassFile, targetPassFile);
    
    if (config.verbose) {
      console.log('[imapsync] Running bulk sync:', cmd);
    }
    
    // Execute imapsync with timeout
    const timeoutMs = (config.timeoutSeconds ?? 3600) * 1000;
    const result = execSync(cmd, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    // Parse output to count messages
    const stats = parseImapsyncOutput(result);
    
    const durationSeconds = (Date.now() - startTime) / 1000;
    
    return {
      totalMessages: stats.total,
      successCount: stats.success,
      failureCount: stats.failures,
      failures,
      durationSeconds,
      completed: true,
    };
    
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (config.verbose) {
      console.error('[imapsync] Bulk sync failed:', errorMessage);
    }
    
    return {
      totalMessages: 0,
      successCount: 0,
      failureCount: 0,
      failures: [{ folder: 'unknown', message: 'Command failed', error: errorMessage }],
      durationSeconds,
      completed: false,
    };
  } finally {
    // Clean up temporary password files
    try {
      if (fs.existsSync(sourcePassFile)) {
        fs.unlinkSync(sourcePassFile);
      }
      if (fs.existsSync(targetPassFile)) {
        fs.unlinkSync(targetPassFile);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Get source password from environment based on auth type.
 */
function getSourcePassword(source: ImapOAuth2Source): string | undefined {
  if (source.auth.kind === 'xoauth2' && source.auth.tokenFromEnv) {
    return process.env[source.auth.tokenFromEnv];
  } else if (source.auth.kind === 'login' && source.auth.passwordFromEnv) {
    return process.env[source.auth.passwordFromEnv];
  }
  return undefined;
}

/**
 * Get target password from environment based on auth type.
 */
function getTargetPassword(target: ImapDavTarget): string | undefined {
  if (target.auth.kind === 'xoauth2' && target.auth.tokenFromEnv) {
    return process.env[target.auth.tokenFromEnv];
  } else if (target.auth.kind === 'login' && target.auth.passwordFromEnv) {
    return process.env[target.auth.passwordFromEnv];
  }
  return undefined;
}

/**
 * Build the imapsync command string.
 */
function buildImapsyncCommand(
  config: ImapSyncConfig,
  sourcePassFile: string,
  targetPassFile: string
): string {
  const { source, target } = config;
  const maxBytes = config.maxBytesPerSecond ?? 100000;
  const skipSize = config.skipMessageSize ?? 0;
  
  // Build command parts
  const parts = [
    'imapsync',
    // Source server
    `--host1 ${source.host}`,
    `--port1 ${source.port}`,
    `--user1 ${source.user}`,
    `--passfile1 ${sourcePassFile}`,
    source.auth.kind === 'xoauth2' ? '--authmech1 XOAUTH2' : '',
    // Target server
    `--host2 ${target.host}`,
    `--port2 ${target.port}`,
    `--user2 ${target.user}`,
    `--passfile2 ${targetPassFile}`,
    target.auth.kind === 'xoauth2' ? '--authmech2 XOAUTH2' : '',
    // Common options
    '--automap', // Automatic folder mapping
    `--skipmessagesize ${skipSize}`,
    `--maxbytespersecond ${maxBytes}`,
    '--nofoldersizes', // Skip folder size calculation (faster)
    '--noskipfolders', // Don't skip any folders
    '--allowmissedargs', // Allow missing arguments
    '--debug', // Enable debug output for logging
  ];
  
  // Filter out empty strings and join
  return parts.filter(p => p.trim()).join(' ');
}

/**
 * Parse imapsync output to extract statistics.
 */
function parseImapsyncOutput(output: string): { total: number; success: number; failures: number } {
  // imapsync outputs statistics at the end like:
  // "Message(s) transferred: N"
  // "Message(s) failed: M"
  
  const transferredMatch = output.match(/Message\(s\) transferred:\s*(\d+)/i);
  const failedMatch = output.match(/Message\(s\) failed:\s*(\d+)/i);
  
  const success = transferredMatch ? parseInt(transferredMatch[1]!, 10) : 0;
  const failures = failedMatch ? parseInt(failedMatch[1]!, 10) : 0;
  
  return {
    total: success + failures,
    success,
    failures,
  };
}

/**
 * Check if imapsync is installed and available.
 */
export function checkImapsyncAvailable(): boolean {
  try {
    const result = execSync('imapsync --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.includes('imapsync');
  } catch {
    return false;
  }
}

/**
 * Get imapsync version if available.
 */
export function getImapsyncVersion(): string | null {
  try {
    const result = execSync('imapsync --version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const match = result.match(/imapsync\s+version\s+([^\s]+)/i);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}
