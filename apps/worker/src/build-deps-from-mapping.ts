// Copyright 2026 OpenHands Agent (Apache-2.0)
// Build dependencies from database-stored connections with encrypted credentials.
// Used by Trigger.dev jobs to construct real source/target connectors.

import { Pool } from 'pg';
import { eq, and } from 'drizzle-orm';

import {
  type ReconcileDeps,
  type MappingConfig,
  type SourceConnector,
  type TargetWriter,
  type ThrottleLimiter,
  type ThrottleConfigMapping,
  createThrottleLimiterFromMapping,
  type TenantId,
  type MappingId,
  type Ledger,
  type CursorStore,
  type SourceConfig,
  type TargetConfig,
} from '@openmig/shared';
import { connection as connectionTable } from '@openmig/ledger';
import { 
  ImapSource, 
  ImapDavMailTarget, 
  type ImapDavTargetConfig, 
} from '@openmig/connectors';
import { JmapTargetWriter } from '@openmig/connectors';
import { PgLedger, PgCursorStore, createPgDb, withTenant } from '@openmig/ledger';
import { SecretStore } from '@openmig/core/secret-store';

/**
 * Build dependencies from database-stored connections with encrypted credentials.
 * 
 * This is the job-oriented version that:
 * 1. Loads the source and target connections from the database (with RLS)
 * 2. Decrypts credentials using the secret store
 * 3. Constructs the same ReconcileDeps as buildDeps()
 * 
 * SECURITY: All database operations are wrapped in withTenant() to enforce
 * row-level security. The tenantId must come from an authenticated request.
 * 
 * @param pool - PostgreSQL pool
 * @param tenantId - The tenant ID (from authenticated API request)
 * @param mappingId - The mapping ID to track (not used for config loading)
 * @returns ReconcileDeps with real source/target connectors
 * @throws Error if tenantId is missing, connections not found, or credentials unavailable
 */
export async function buildDepsFromMapping(
  pool: Pool,
  tenantId: string,
  mappingId: string
): Promise<ReconcileDeps> {
  // SECURITY: Fail closed if tenantId is missing or invalid
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required and must be a valid UUID');
  }

  // Load connections and credentials WITHIN tenant context (RLS enforced)
  const { sourceConfig, targetConfig, sourceCredentials, targetCredentials } = await withTenant(pool, tenantId, async (txDb) => {
    // Load source connection (RLS-enforced)
    const sourceConnections = await txDb.select()
      .from(connectionTable)
      .where(
        and(
          eq(connectionTable.tenantId, tenantId),
          eq(connectionTable.role, 'source')
        )
      );
    
    if (sourceConnections.length === 0) {
      throw new Error(`Source connection not found for tenant: ${tenantId}`);
    }
    
    const sourceConnection = sourceConnections[0]!;
    
    // Load target connection (RLS-enforced)
    const targetConnections = await txDb.select()
      .from(connectionTable)
      .where(
        and(
          eq(connectionTable.tenantId, tenantId),
          eq(connectionTable.role, 'target')
        )
      );
    
    if (targetConnections.length === 0) {
      throw new Error(`Target connection not found for tenant: ${tenantId}`);
    }
    
    const targetConnection = targetConnections[0]!;
    
    // Parse connector configs from the connection config JSONB
    const sourceConfig = sourceConnection.config as unknown as SourceConfig;
    const targetConfig = targetConnection.config as unknown as TargetConfig;
    
    // Decrypt source credentials
    let sourceCredentials: Record<string, string>;
    if (sourceConnection.secretRef) {
      sourceCredentials = SecretStore.decryptCredentials(sourceConnection.secretRef);
    } else {
      // Fallback: credentials stored in config (unencrypted - for migration/testing only)
      const configObj = sourceConnection.config as Record<string, unknown>;
      if (configObj.credentials && typeof configObj.credentials === 'object') {
        sourceCredentials = configObj.credentials as Record<string, string>;
      } else {
        throw new Error('Source connection has no credentials');
      }
    }
    
    // Decrypt target credentials
    let targetCredentials: Record<string, string>;
    if (targetConnection.secretRef) {
      targetCredentials = SecretStore.decryptCredentials(targetConnection.secretRef);
    } else {
      const configObj = targetConnection.config as Record<string, unknown>;
      if (configObj.credentials && typeof configObj.credentials === 'object') {
        targetCredentials = configObj.credentials as Record<string, string>;
      } else {
        throw new Error('Target connection has no credentials');
      }
    }
    
    return {
      sourceConfig,
      targetConfig,
      sourceCredentials,
      targetCredentials,
    };
  });
  
  // Build the MappingConfig from source/target configs
  const mappingConfig: MappingConfig = {
    tenantId,
    mappingId,
    source: sourceConfig,
    target: targetConfig,
  };
  
  // Now build the actual dependencies OUTSIDE the transaction
  const db = createPgDb(process.env.DATABASE_URL!);
  
  // Build throttle limiter from mapping config
  // Extract throttle configs from domains if present
  const throttleConfigMapping: ThrottleConfigMapping = {};
  if (mappingConfig.domains) {
    for (const [domainName, domainConfig] of Object.entries(mappingConfig.domains)) {
      if (domainConfig?.throttleConfig) {
        throttleConfigMapping[domainName] = domainConfig.throttleConfig;
      }
    }
  }
  const throttleLimiter = Object.keys(throttleConfigMapping).length > 0
    ? createThrottleLimiterFromMapping(throttleConfigMapping)
    : undefined;
  
  // Build source connector with decrypted credentials
  const source = buildSourceConnectorFromCredentials(
    mappingConfig.source,
    sourceCredentials,
    throttleLimiter
  );
  
  // Build target writer with decrypted credentials
  const target = buildTargetWriterFromCredentials(mappingConfig.target, targetCredentials);
  
  // Create ledger and cursor store
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);
  
  return {
    tenantId: tenantId as ReconcileDeps['tenantId'],
    mappingId: mappingId as ReconcileDeps['mappingId'],
    source,
    target,
    ledger,
    cursors,
    concurrency: mappingConfig.concurrency ?? 4,
  };
}

/**
 * Build domain-specific dependencies from database-stored connections.
 * For now, delegates to buildDepsFromMapping which handles mail sync.
 */
export async function buildDomainDepsFromMapping(
  pool: Pool,
  tenantId: string,
  mappingId: string,
  _domain: 'mail' | 'calendar' | 'contacts' | 'files'
): Promise<{
  tenantId: TenantId;
  mappingId: MappingId;
  source: SourceConnector;
  target: TargetWriter;
  ledger: Ledger;
  cursors: CursorStore;
  concurrency: number;
}> {
  // Delegate to buildDepsFromMapping which handles mail sync
  const deps = await buildDepsFromMapping(pool, tenantId, mappingId);
  
  return {
    tenantId: deps.tenantId,
    mappingId: deps.mappingId,
    source: deps.source,
    target: deps.target,
    ledger: deps.ledger,
    cursors: deps.cursors!,
    concurrency: deps.concurrency!,
  };
}

/**
 * Build source connector from config and decrypted credentials.
 * Currently only supports imap-oauth2 for mail sync.
 */
function buildSourceConnectorFromCredentials(
  sourceConfig: SourceConfig,
  credentials: Record<string, string>,
  throttleLimiter?: ThrottleLimiter
): SourceConnector {
  if (sourceConfig.type !== 'imap-oauth2') {
    throw new Error(`buildDepsFromMapping currently only supports imap-oauth2, got: ${sourceConfig.type}`);
  }

  return buildImapSourceFromCredentials(sourceConfig, credentials, throttleLimiter);
}

/**
 * Build IMAP OAuth2 source from credentials.
 */
function buildImapSourceFromCredentials(
  sourceConfig: SourceConfig,
  credentials: Record<string, string>,
  throttleLimiter?: ThrottleLimiter
): SourceConnector {
  if (sourceConfig.type !== 'imap-oauth2') {
    throw new Error(`Expected imap-oauth2, got: ${(sourceConfig as { type: string }).type}`);
  }

  const accessToken = credentials.accessToken || credentials.oauth2_token;
  if (!accessToken) {
    throw new Error('OAuth2 access token not found in credentials');
  }

  const imapConfig = {
    host: sourceConfig.host,
    port: sourceConfig.port,
    tls: true,
    auth: {
      user: sourceConfig.user,
      accessToken,
    },
    authType: 'XOAUTH2' as const,
    throttleLimiter,
  };

  return new ImapSource(imapConfig);
}

/**
 * Build target writer from config and decrypted credentials.
 */
function buildTargetWriterFromCredentials(
  targetConfig: TargetConfig,
  credentials: Record<string, string>
): TargetWriter {
  switch (targetConfig.type) {
    case 'jmap': {
      const password = credentials.password || credentials.token || credentials.api_key;
      if (!password) {
        throw new Error('JMAP target password/token not found in credentials');
      }

      const jmapConfig = {
        baseUrl: targetConfig.baseUrl,
        username: targetConfig.user,
        password,
      };

      return new JmapTargetWriter(jmapConfig);
    }

    case 'imap-dav': {
      const password = credentials.password || credentials.access_token;
      if (!password) {
        throw new Error('IMAP/DAV target password not found in credentials');
      }

      const imapConfig: ImapDavTargetConfig = {
        host: targetConfig.host,
        port: targetConfig.port,
        tls: targetConfig.port === 993,
        username: targetConfig.user,
        password,
      };

      return new ImapDavMailTarget(imapConfig);
    }

    default:
      throw new Error(`Unsupported target type: ${(targetConfig as { type: string }).type}`);
  }
}
