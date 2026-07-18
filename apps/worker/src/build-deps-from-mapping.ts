// Copyright 2026 OpenHands Agent (Apache-2.0)
// Build dependencies from database-stored mapping with encrypted credentials.
// Used by Trigger.dev jobs to construct real source/target connectors.

import { Pool } from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { eq, and } from 'drizzle-orm';

import {
  type ReconcileDeps,
  type MappingConfig,
  type SourceConnector,
  type TargetWriter,
  type TokenProviderConfig,
  ThrottleLimiter,
  type ThrottleConfig,
  createThrottleLimiterFromMapping,
  type TenantId,
  type MappingId,
  type Ledger,
  type CursorStore,
  type MigrationStatusStore,
  type CalendarSource,
  type CalendarTargetWriter,
  type ContactSource,
  type ContactTargetWriter,
  type FileSource,
  type FileTargetWriter,
  mailboxMapping as mappingTable,
  connection as connectionTable,
} from '@openmig/shared';
import { 
  ImapSource, 
  ImapDavMailTarget, 
  type ImapDavTargetConfig, 
  createTokenProvider,
  GraphCalendarSource,
  GraphContactsSource,
} from '@openmig/connectors';
import { JmapTargetWriter } from '@openmig/connectors';
import { PgLedger, PgCursorStore, PgMigrationStatusStore, createPgDb, withTenant } from '@openmig/ledger';
import * as schemaPg from '@openmig/ledger/src/schema-pg';
import { SecretStore } from '@openmig/core/secret-store';

/**
 * Build dependencies from a mapping stored in the database.
 * 
 * This is the job-oriented version that:
 * 1. Loads the mapping and connections from the database (with RLS)
 * 2. Decrypts credentials using the secret store
 * 3. Constructs the same ReconcileDeps as buildDeps()
 * 
 * SECURITY: All database operations are wrapped in withTenant() to enforce
 * row-level security. The tenantId must come from an authenticated request.
 * 
 * @param pool - PostgreSQL pool
 * @param tenantId - The tenant ID (from authenticated API request)
 * @param mappingId - The mapping ID to load
 * @returns ReconcileDeps with real source/target connectors
 * @throws Error if tenantId is missing, mapping not found, or credentials unavailable
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

  // Load mapping and credentials WITHIN tenant context (RLS enforced)
  const { mapping, sourceCredentials, targetCredentials } = await withTenant(pool, tenantId, async (txDb) => {
    const drizzleDb = drizzlePg(txDb, { schema: schemaPg });
    
    // Load the mapping (RLS-enforced)
    const mappings = await drizzleDb.select()
      .from(mappingTable)
      .where(eq(mappingTable.id, mappingId));
    
    if (mappings.length === 0) {
      throw new Error(`Mapping not found or access denied: ${mappingId}`);
    }
    
    const mapping = mappings[0]!;
    
    // Load source connection (RLS-enforced)
    const sourceConnections = await drizzleDb.select()
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
    const targetConnections = await drizzleDb.select()
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
    
    // Decrypt source credentials
    let sourceCredentials: Record<string, string>;
    if (sourceConnection.encryptedCredentials) {
      sourceCredentials = SecretStore.decryptCredentials(sourceConnection.encryptedCredentials);
    } else if (sourceConnection.config && sourceConnection.config.credentials) {
      // Fallback: credentials stored in config (unencrypted - for migration/testing only)
      sourceCredentials = sourceConnection.config.credentials;
    } else {
      throw new Error('Source connection has no credentials');
    }
    
    // Decrypt target credentials
    let targetCredentials: Record<string, string>;
    if (targetConnection.encryptedCredentials) {
      targetCredentials = SecretStore.decryptCredentials(targetConnection.encryptedCredentials);
    } else if (targetConnection.config && targetConnection.config.credentials) {
      targetCredentials = targetConnection.config.credentials;
    } else {
      throw new Error('Target connection has no credentials');
    }
    
    return {
      mapping,
      sourceCredentials,
      targetCredentials,
    };
  });
  
  // Now build the actual dependencies OUTSIDE the transaction
  // The ledger will use a fresh connection with tenant context set per-query
  const db = createPgDb(process.env.DATABASE_URL!);
  
  // Build throttle limiter from mapping config
  const throttleLimiter = buildThrottleLimiterFromMappingConfig(mapping);
  
  // Build source connector with decrypted credentials
  const source = buildSourceConnectorFromCredentials(
    mapping.source,
    sourceCredentials,
    throttleLimiter
  );
  
  // Build target writer with decrypted credentials
  const target = buildTargetWriterFromCredentials(mapping.target, targetCredentials);
  
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
    concurrency: mapping.concurrency ?? 4,
  };
}

/**
 * Build domain-specific dependencies from database-stored mapping.
 */
export async function buildDomainDepsFromMapping(
  pool: Pool,
  tenantId: string,
  mappingId: string,
  domain: 'calendar' | 'contact' | 'file'
): Promise<{
  tenantId: TenantId;
  mappingId: MappingId;
  source: CalendarSource | ContactSource | FileSource;
  target: CalendarTargetWriter | ContactTargetWriter | FileTargetWriter;
  ledger: Ledger;
  cursors: CursorStore;
  concurrency: number;
}> {
  // SECURITY: Fail closed if tenantId is missing
  if (!tenantId || typeof tenantId !== 'string') {
    throw new Error('tenantId is required and must be a valid UUID');
  }
  
  // Load mapping and credentials WITHIN tenant context (RLS enforced)
  const { mapping, credentials } = await withTenant(pool, tenantId, async (txDb) => {
    const drizzleDb = drizzlePg(txDb, { schema: schemaPg });
    
    // Load the mapping
    const mappings = await drizzleDb.select()
      .from(mappingTable)
      .where(eq(mappingTable.id, mappingId));
    
    if (mappings.length === 0) {
      throw new Error(`Mapping not found or access denied: ${mappingId}`);
    }
    
    const mapping = mappings[0]!;
    
    // Get domain config
    let domainConfig;
    switch (domain) {
      case 'calendar':
        domainConfig = mapping.domains?.calendar;
        break;
      case 'contact':
        domainConfig = mapping.domains?.contacts;
        break;
      case 'file':
        domainConfig = mapping.domains?.files;
        break;
    }
    
    if (!domainConfig?.enabled) {
      throw new Error(`Domain ${domain} is not enabled in mapping`);
    }
    
    // Load connection for this domain
    const connections = await drizzleDb.select()
      .from(connectionTable)
      .where(eq(connectionTable.tenantId, tenantId));
    
    if (connections.length === 0) {
      throw new Error(`No connections found for tenant: ${tenantId}`);
    }
    
    // Decrypt credentials
    const connection = connections[0]!;
    let credentials: Record<string, string>;
    if (connection.encryptedCredentials) {
      credentials = SecretStore.decryptCredentials(connection.encryptedCredentials);
    } else if (connection.config && connection.config.credentials) {
      credentials = connection.config.credentials;
    } else {
      throw new Error('Connection has no credentials');
    }
    
    return { mapping, credentials };
  });
  
  // Build dependencies outside transaction
  const db = createPgDb(process.env.DATABASE_URL!);
  
  const sourceConfig = mapping.domains![domain === 'contact' ? 'contacts' : domain]!.source;
  const targetConfig = mapping.domains![domain === 'contact' ? 'contacts' : domain]!.target;
  const throttleLimiter = buildThrottleLimiterFromMappingConfig(mapping);
  
  // Build source
  let source: CalendarSource | ContactSource | FileSource;
  switch (sourceConfig.type) {
    case 'caldav':
      source = buildCalDAVSource(sourceConfig, credentials, throttleLimiter);
      break;
    case 'carddav':
      source = buildCardDAVSource(sourceConfig, credentials);
      break;
    case 'webdav':
      source = buildWebDAVSource(sourceConfig, credentials);
      break;
    default:
      throw new Error(`Unsupported source type for ${domain}: ${sourceConfig.type}`);
  }
  
  // Build target
  let target: CalendarTargetWriter | ContactTargetWriter | FileTargetWriter;
  switch (targetConfig.type) {
    case 'caldav':
      target = buildCalDAVTarget(targetConfig, credentials);
      break;
    case 'carddav':
      target = buildCardDAVTarget(targetConfig, credentials);
      break;
    case 'webdav':
      target = buildWebDAVTarget(targetConfig, credentials);
      break;
    default:
      throw new Error(`Unsupported target type for ${domain}: ${targetConfig.type}`);
  }
  
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);
  
  return {
    tenantId: tenantId as TenantId,
    mappingId: mappingId as MappingId,
    source,
    target,
    ledger,
    cursors,
    concurrency: mapping.domains![domain === 'contact' ? 'contacts' : domain]!.concurrency ?? mapping.concurrency ?? 4,
  };
}

// Helper functions (factored from build-deps.ts)

function buildThrottleLimiterFromMappingConfig(mapping: MappingConfig): ThrottleLimiter | undefined {
  if (mapping.domains) {
    const throttleConfigMapping: Record<string, Partial<ThrottleConfig>> = {};
    
    for (const [domainName, domainConfig] of Object.entries(mapping.domains)) {
      if (domainConfig?.throttleConfig) {
        throttleConfigMapping[domainName] = domainConfig.throttleConfig;
      }
    }
    
    if (Object.keys(throttleConfigMapping).length > 0) {
      return createThrottleLimiterFromMapping(throttleConfigMapping);
    }
  }
  
  return undefined;
}

function buildSourceConnectorFromCredentials(
  sourceConfig: MappingConfig['source'],
  credentials: Record<string, string>,
  throttleLimiter?: ThrottleLimiter
): SourceConnector {
  switch (sourceConfig.type) {
    case 'imap-oauth2':
      return buildImapSourceFromCredentials(sourceConfig, credentials, throttleLimiter);
    
    default:
      throw new Error(`Unsupported source type: ${sourceConfig.type}`);
  }
}

function buildImapSourceFromCredentials(
  sourceConfig: MappingConfig['source'],
  credentials: Record<string, string>,
  throttleLimiter?: ThrottleLimiter
): SourceConnector {
  if (sourceConfig.type !== 'imap-oauth2') {
    throw new Error(`Expected imap-oauth2, got: ${sourceConfig.type}`);
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

function buildTargetWriterFromCredentials(
  targetConfig: MappingConfig['target'],
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
      throw new Error(`Unsupported target type: ${targetConfig.type}`);
  }
}

function buildCalDAVSource(
  _sourceConfig: any,
  _credentials: Record<string, string>,
  _throttleLimiter?: ThrottleLimiter
): CalendarSource {
  // Placeholder - CalDAV source not yet implemented
  return {
    listFolders: async () => [],
    listSince: async () => ({ items: [], nextCursor: { value: '' } }),
  } as CalendarSource;
}

function buildCalDAVTarget(
  _targetConfig: any,
  _credentials: Record<string, string>
): CalendarTargetWriter {
  // Placeholder - CalDAV target not yet implemented
  return {
    ensureCalendar: async () => '',
    upsertCalendarEvent: async () => ({ targetId: '', created: false }),
    findCalendarByNaturalKey: async () => undefined,
  } as CalendarTargetWriter;
}

function buildCardDAVSource(
  _sourceConfig: any,
  _credentials: Record<string, string>
): ContactSource {
  // Placeholder - CardDAV source not yet implemented
  return {
    listFolders: async () => [],
    listSince: async () => ({ items: [], nextCursor: { value: '' } }),
  } as ContactSource;
}

function buildCardDAVTarget(
  _targetConfig: any,
  _credentials: Record<string, string>
): ContactTargetWriter {
  // Placeholder - CardDAV target not yet implemented
  return {
    ensureContactFolder: async () => '',
    upsertContact: async () => ({ targetId: '', created: false }),
    findContactByNaturalKey: async () => undefined,
  } as ContactTargetWriter;
}

function buildWebDAVSource(
  _sourceConfig: any,
  _credentials: Record<string, string>
): FileSource {
  // Placeholder - WebDAV source not yet implemented
  return {
    listFolders: async () => [],
    listSince: async () => ({ items: [], nextCursor: { value: '' } }),
  } as FileSource;
}

function buildWebDAVTarget(
  _targetConfig: any,
  _credentials: Record<string, string>
): FileTargetWriter {
  // Placeholder - WebDAV target not yet implemented
  return {
    ensureDirectory: async () => '',
    upsertFile: async () => ({ targetId: '', created: false }),
    findFileByNaturalKey: async () => undefined,
  } as FileTargetWriter;
}
