// Copyright 2026 OpenHands Agent (Apache-2.0)
// Dependency bundle builder for the worker.
// Wires together: Postgres ledger, IMAP source, JMAP target, cursor store.
// Implements the full ReconcileDeps for runShadowPass.

import {
  type ReconcileDeps,
  type MappingConfig,
  type SourceConnector,
  type TargetWriter,
} from '@openmig/shared';
import { ImapSource, ImapDavMailTarget, type ImapDavTargetConfig } from '@openmig/connectors';
import { JmapTargetWriter } from '@openmig/connectors';
import { PgLedger } from '@openmig/ledger';
import { PgCursorStore } from '@openmig/ledger';
import { createPgDb } from '@openmig/ledger';

/**
 * Build the complete dependency bundle for a shadow pass.
 * This wires together all the components needed for the worker to run.
 */
export async function buildDeps(config: MappingConfig): Promise<ReconcileDeps> {
  // Extract database connection from environment
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL environment variable is required. ' +
      'Example: postgres://user:password@localhost:5432/openmig'
    );
  }

  // Create database connection
  const db = createPgDb(databaseUrl);

  // Create ledger
  const ledger = new PgLedger(db);

  // Create cursor store
  const cursors = new PgCursorStore(db);

  // Build source connector from config
  const source = buildSourceConnector(config.source);

  // Build target writer from config
  const target = buildTargetWriter(config.target);

  return {
    tenantId: config.tenantId as unknown as ReconcileDeps['tenantId'],
    mappingId: config.mappingId as unknown as ReconcileDeps['mappingId'],
    source,
    target,
    ledger,
    cursors,
    concurrency: config.concurrency ?? 4,
  };
}

/**
 * Build a source connector from the mapping config.
 * Currently only supports imap-oauth2 (O365 with XOAUTH2).
 */
function buildSourceConnector(sourceConfig: MappingConfig['source']): SourceConnector {
  // Only ImapOAuth2Source is supported for now
  if (sourceConfig.type !== 'imap-oauth2') {
    throw new Error(`Unsupported source type: ${sourceConfig.type}. Only 'imap-oauth2' is currently supported.`);
  }
  
  const imapConfig = {
    host: sourceConfig.host,
    port: sourceConfig.port,
    tls: true,
    auth: {
      user: sourceConfig.user,
      accessToken: sourceConfig.auth.kind === 'xoauth2' 
        ? process.env[sourceConfig.auth.tokenFromEnv] 
        : undefined,
    },
    authType: 'XOAUTH2' as const,
  };

  return new ImapSource(imapConfig);
}

/**
 * Build a target writer from the mapping config.
 * Supports both JMAP and IMAP/DAV target types.
 */
function buildTargetWriter(targetConfig: MappingConfig['target']): TargetWriter {
  switch (targetConfig.type) {
    case 'jmap': {
      // For JMAP targets, we need to determine the password based on auth type
      // - basic: password from environment variable
      // - bearer: we use the token as password (JMAP library accepts it)
      let password: string;
      if (targetConfig.auth.kind === 'basic') {
        password = process.env[targetConfig.auth.passwordFromEnv] ?? '';
      } else if (targetConfig.auth.kind === 'bearer') {
        // For bearer token auth, we use the token as the password
        password = process.env[targetConfig.auth.tokenFromEnv] ?? '';
      } else {
        throw new Error(`Unsupported JMAP auth kind: ${(targetConfig.auth as {kind: string}).kind}`);
      }

      if (!password) {
        throw new Error(
          `JMAP target password/token not found in environment: ` +
          `check ${targetConfig.auth.kind === 'basic' 
            ? targetConfig.auth.passwordFromEnv 
            : targetConfig.auth.tokenFromEnv}`
        );
      }

      const jmapConfig = {
        baseUrl: targetConfig.baseUrl,
        username: targetConfig.user,
        password,
      };

      return new JmapTargetWriter(jmapConfig);
    }

    case 'imap-dav': {
      // For IMAP/DAV targets, get password from environment
      // Auth can be 'login' (password) or 'xoauth2' (access token)
      let password: string;
      if (targetConfig.auth.kind === 'login') {
        password = process.env[targetConfig.auth.passwordFromEnv] ?? '';
      } else if (targetConfig.auth.kind === 'xoauth2') {
        password = process.env[targetConfig.auth.tokenFromEnv] ?? '';
      } else {
        throw new Error(`Unsupported IMAP/DAV auth kind: ${(targetConfig.auth as {kind: string}).kind}`);
      }
      
      if (!password) {
        throw new Error(
          `IMAP/DAV target credentials not found in environment: ` +
          `check ${targetConfig.auth.kind === 'login' 
            ? targetConfig.auth.passwordFromEnv 
            : targetConfig.auth.tokenFromEnv}`
        );
      }

      const imapConfig: ImapDavTargetConfig = {
        host: targetConfig.host,
        port: targetConfig.port,
        tls: targetConfig.port === 993, // Use TLS for IMAPS
        username: targetConfig.user,
        password,
      };

      return new ImapDavMailTarget(imapConfig);
    }

    default: {
      throw new Error(`Unsupported target type: ${(targetConfig as {type: string}).type}`);
    }
  }
}
