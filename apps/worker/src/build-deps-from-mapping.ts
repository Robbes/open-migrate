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
import type { CalendarSyncDeps, ContactSyncDeps, FileSyncDeps } from '@openmig/core';
import {
  buildCalendarSource,
  buildCalendarTarget,
  buildContactSource,
  buildContactTarget,
  buildFileSource,
  buildFileTarget,
} from './dav-factories';
import { PgLedger, PgCursorStore, createPgDb, withTenant } from '@openmig/ledger';
import { SecretStore } from '@openmig/core/secret-store';
import { mailboxMapping } from '@openmig/ledger';
import { withClose, type WithClose } from './deps-lifecycle';

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
): Promise<WithClose<ReconcileDeps>> {
  // SECURITY: Fail closed if tenantId is missing or invalid
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required and must be a valid UUID');
  }

  // Validate mapping exists and belongs to tenant (RLS-enforced)
  // Use TEST_DATABASE_URL for integration tests, fall back to DATABASE_URL
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL must be set');
  }
  const db = createPgDb(databaseUrl);
  const mappings = await db.select()
    .from(mailboxMapping)
    .where(
      and(
        eq(mailboxMapping.tenantId, tenantId),
        eq(mailboxMapping.id, mappingId)
      )
    );

  if (mappings.length === 0) {
    throw new Error('Mapping not found or access denied');
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

  // Attach close() so the caller releases the pool after the pass (never leak it).
  return withClose(
    {
      tenantId: tenantId as ReconcileDeps['tenantId'],
      mappingId: mappingId as ReconcileDeps['mappingId'],
      source,
      target,
      ledger,
      cursors,
      concurrency: mappingConfig.concurrency ?? 4,
    },
    db,
  );
}

/** Build a DAV endpoint URL from a stored connection config (url/baseUrl/host+port). */
function davUrl(config: Record<string, unknown>): string {
  if (typeof config.url === 'string') return config.url;
  if (typeof config.baseUrl === 'string') return config.baseUrl;
  const host = config.host;
  if (typeof host !== 'string' || !host) {
    throw new Error('DAV connection config is missing url/baseUrl/host');
  }
  const scheme = config.useSsl === false ? 'http' : 'https';
  const port = typeof config.port === 'number' ? `:${config.port}` : '';
  return `${scheme}://${host}${port}/`;
}

/** Load source + target connection config/credentials for a tenant (RLS-enforced). */
async function loadDomainConnections(
  pool: Pool,
  tenantId: string,
): Promise<{
  source: { config: Record<string, unknown>; creds: Record<string, string> };
  target: { config: Record<string, unknown>; creds: Record<string, string> };
}> {
  return withTenant(pool, tenantId, async (txDb) => {
    const load = async (role: 'source' | 'target') => {
      const rows = await txDb
        .select()
        .from(connectionTable)
        .where(and(eq(connectionTable.tenantId, tenantId), eq(connectionTable.role, role)));
      const conn = rows[0];
      if (!conn) {
        throw new Error(`${role} connection not found for tenant: ${tenantId}`);
      }
      const config = (conn.config ?? {}) as Record<string, unknown>;
      let creds: Record<string, string>;
      if (conn.secretRef) {
        creds = SecretStore.decryptCredentials(conn.secretRef);
      } else if (config.credentials && typeof config.credentials === 'object') {
        creds = config.credentials as Record<string, string>;
      } else {
        throw new Error(`${role} connection has no credentials`);
      }
      return { config, creds };
    };
    return { source: await load('source'), target: await load('target') };
  });
}

/**
 * Build domain-specific sync dependencies from database-stored connections.
 *
 * Mail delegates to buildDepsFromMapping (IMAP/JMAP). Calendar/contact/file build
 * the native DAV source connectors + engine target writers from the stored
 * connection config + decrypted credentials — credentials are passed directly
 * (never via env) so the managed path is per-tenant safe. RLS-enforced.
 */
export function buildDomainDepsFromMapping(pool: Pool, tenantId: string, mappingId: string, domain: 'mail'): Promise<WithClose<ReconcileDeps>>;
export function buildDomainDepsFromMapping(pool: Pool, tenantId: string, mappingId: string, domain: 'calendar'): Promise<WithClose<CalendarSyncDeps>>;
export function buildDomainDepsFromMapping(pool: Pool, tenantId: string, mappingId: string, domain: 'contact'): Promise<WithClose<ContactSyncDeps>>;
export function buildDomainDepsFromMapping(pool: Pool, tenantId: string, mappingId: string, domain: 'file'): Promise<WithClose<FileSyncDeps>>;
export async function buildDomainDepsFromMapping(
  pool: Pool,
  tenantId: string,
  mappingId: string,
  domain: 'mail' | 'calendar' | 'contact' | 'file',
): Promise<WithClose<ReconcileDeps | CalendarSyncDeps | ContactSyncDeps | FileSyncDeps>> {
  if (domain === 'mail') {
    return buildDepsFromMapping(pool, tenantId, mappingId);
  }

  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or TEST_DATABASE_URL must be set');
  }
  const db = createPgDb(databaseUrl);
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);
  const tId = tenantId as TenantId;
  const mId = mappingId as MappingId;

  const { source: src, target: tgt } = await loadDomainConnections(pool, tenantId);
  const common = { tenantId: tId, mappingId: mId, ledger, cursors };
  const targetDeps = { ledger, tenantId: tId, mappingId: mId };
  const srcEndpoint = { url: davUrl(src.config), username: src.creds.username ?? '', password: src.creds.password ?? '' };
  const tgtEndpoint = { url: davUrl(tgt.config), username: tgt.creds.username ?? '', password: tgt.creds.password ?? '' };

  // Attach close() so the caller releases the pool after the pass (never leak it).
  if (domain === 'calendar') {
    return withClose(
      {
        ...common,
        source: buildCalendarSource(srcEndpoint),
        target: buildCalendarTarget(tgtEndpoint, targetDeps),
      } satisfies CalendarSyncDeps,
      db,
    );
  }
  if (domain === 'contact') {
    return withClose(
      {
        ...common,
        source: buildContactSource(srcEndpoint),
        target: buildContactTarget(tgtEndpoint, targetDeps),
      } satisfies ContactSyncDeps,
      db,
    );
  }
  return withClose(
    {
      ...common,
      source: buildFileSource(srcEndpoint),
      target: buildFileTarget(tgtEndpoint, targetDeps),
    } satisfies FileSyncDeps,
    db,
  );
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
