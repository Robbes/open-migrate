// Copyright 2026 OpenHands Agent (Apache-2.0)
// Dependency bundle builder for the worker.
// Wires together: Postgres ledger, IMAP source, JMAP target, cursor store.
// Implements the full ReconcileDeps for runShadowPass.

import {
  type ReconcileDeps,
  type MappingConfig,
  type SourceConnector,
  type TargetWriter,
  type Ledger,
  type CursorStore,
} from '@openmig/shared';
import { ImapSource, type ImapSourceConfig } from '@openmig/connectors';
import { JmapTargetWriter, type JmapTargetConfig } from '@openmig/connectors';
import { PgLedger } from '@openmig/ledger';
import { PgCursorStore } from '@openmig/ledger';
import { createPgDb } from '@openmig/ledger';

/**
 * Build the complete dependency bundle for a shadow pass.
 * This wires together all the components needed for the worker to run.
 */
export async function buildDeps(config: MappingConfig): Promise<ReconcileDeps> {
  // Extract database connection from config or environment
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
    tenantId: config.tenantId,
    mappingId: config.mappingId,
    source,
    target,
    ledger,
    cursors,
    concurrency: config.concurrency ?? 4,
  };
}

/**
 * Build a source connector from the mapping config.
 */
function buildSourceConnector(sourceConfig: MappingConfig['source']): SourceConnector {
  if (sourceConfig.type !== 'imap') {
    throw new Error(`Unsupported source type: ${sourceConfig.type}. Only 'imap' is supported.`);
  }

  const imapConfig: ImapSourceConfig = {
    host: sourceConfig.host,
    port: sourceConfig.port,
    tls: sourceConfig.tls ?? true,
    auth: {
      user: sourceConfig.username,
    },
    authType: sourceConfig.authType,
  };

  // Handle authentication
  if ('accessToken' in sourceConfig && sourceConfig.accessToken) {
    // XOAUTH2 authentication
    imapConfig.auth.accessToken = sourceConfig.accessToken;
    imapConfig.authType = 'XOAUTH2';
  } else if ('password' in sourceConfig && sourceConfig.password) {
    // Plain LOGIN authentication
    imapConfig.auth.password = sourceConfig.password;
    imapConfig.authType = 'LOGIN';
  } else {
    throw new Error(
      'IMAP source requires either password (LOGIN) or accessToken (XOAUTH2) authentication'
    );
  }

  return new ImapSource(imapConfig);
}

/**
 * Build a target writer from the mapping config.
 */
function buildTargetWriter(targetConfig: MappingConfig['target']): TargetWriter {
  if (targetConfig.type !== 'jmap') {
    throw new Error(`Unsupported target type: ${targetConfig.type}. Only 'jmap' is supported.`);
  }

  const jmapConfig: JmapTargetConfig = {
    baseUrl: targetConfig.url,
    username: targetConfig.username,
    password: targetConfig.password,
  };

  return new JmapTargetWriter(jmapConfig);
}
