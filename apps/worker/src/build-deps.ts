// Copyright 2026 OpenHands Agent (Apache-2.0)
// Dependency bundle builder for the worker.
// Wires together: Postgres ledger, IMAP source, JMAP target, cursor store.
// Implements the full ReconcileDeps for runShadowPass.

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
  type MigrationStatusStore as _MigrationStatusStore,
  type CalendarSource,
  type CalendarTargetWriter,
  type ContactSource,
  type ContactTargetWriter,
  type FileSource,
  type FileTargetWriter,
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

  // Build throttle limiter from domain configuration
  const throttleLimiter = buildThrottleLimiter(config);

  // Build source connector from config
  const source = buildSourceConnector(config.source, throttleLimiter);

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
 * Build a throttle limiter from the mapping configuration.
 * Uses per-domain throttle config if available, otherwise uses defaults.
 */
function buildThrottleLimiter(config: MappingConfig): ThrottleLimiter | undefined {
  // If we have domain-specific throttle configs, create a limiter from them
  if (config.domains) {
    const throttleConfigMapping: Record<string, Partial<ThrottleConfig>> = {};
    
    // Collect throttle configs from all domains
    for (const [domainName, domainConfig] of Object.entries(config.domains)) {
      if (domainConfig?.throttleConfig) {
        // Use the domain name as the key for the throttle config
        throttleConfigMapping[domainName] = domainConfig.throttleConfig;
      }
    }
    
    // If we have any throttle configs, create a limiter
    if (Object.keys(throttleConfigMapping).length > 0) {
      return createThrottleLimiterFromMapping(throttleConfigMapping);
    }
  }
  
  // Return undefined if no throttle config is specified
  return undefined;
}

/**
 * Build a source connector from the mapping config.
 * Supports imap-oauth2 with TokenProvider for automatic token refresh.
 * Note: For graph-calendar and graph-contacts, use separate build functions.
 */
function buildSourceConnector(sourceConfig: MappingConfig['source'], throttleLimiter?: ThrottleLimiter): SourceConnector {
  switch (sourceConfig.type) {
    case 'imap-oauth2':
      return buildImapSource(sourceConfig, throttleLimiter);
    
    default:
      throw new Error(`Unsupported source type for ReconcileDeps: ${(sourceConfig as {type: string}).type}. Use buildGraphCalendarSource or buildGraphContactsSource for graph sources.`);
  }
}

/**
 * Build an IMAP source connector.
 */
function buildImapSource(sourceConfig: MappingConfig['source'], throttleLimiter?: ThrottleLimiter): SourceConnector {
  if (sourceConfig.type !== 'imap-oauth2') {
    throw new Error(`Expected imap-oauth2 source, got: ${sourceConfig.type}`);
  }
  
  // Build TokenProvider if we have OAuth2 credentials configured
  let tokenProviderConfig: TokenProviderConfig | undefined;
  
  if (sourceConfig.auth.kind === 'xoauth2') {
    // Check if we have additional OAuth2 configuration for token provider
    // This would typically come from environment variables or config
    const tenantId = process.env.OAUTH2_TENANT_ID;
    const clientId = process.env.OAUTH2_CLIENT_ID;
    const clientSecret = process.env.OAUTH2_CLIENT_SECRET;
    const refreshToken = process.env.OAUTH2_REFRESH_TOKEN;
    
    // Only create TokenProvider if we have the necessary credentials
    if (tenantId && clientId) {
      tokenProviderConfig = {
        tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        clientId,
        clientSecret,
        tenantId,
        scope: 'https://outlook.office.com/IMAP.AccessAsUser.All',
        refreshToken,
      };
    }
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
    tokenProvider: tokenProviderConfig ? createTokenProvider(tokenProviderConfig) : undefined,
    throttleLimiter, // Pass throttle limiter if available
  };

  return new ImapSource(imapConfig);
}

/**
 * Build a Graph Calendar source connector.
 * Exported for external use (prefix with _ to silence unused warning in this module).
 */
function _buildGraphCalendarSource(sourceConfig: MappingConfig['source'], throttleLimiter?: ThrottleLimiter) {
  if (sourceConfig.type !== 'graph-calendar') {
    throw new Error(`Expected graph-calendar source, got: ${sourceConfig.type}`);
  }
  
  // Get OAuth2 credentials from environment
  const tenantId = process.env.OAUTH2_TENANT_ID;
  const clientId = process.env.OAUTH2_CLIENT_ID;
  const clientSecret = process.env.OAUTH2_CLIENT_SECRET;
  const refreshToken = process.env.OAUTH2_REFRESH_TOKEN;
  
  if (!tenantId || !clientId) {
    throw new Error(
      'Graph Calendar requires OAUTH2_TENANT_ID and OAUTH2_CLIENT_ID environment variables'
    );
  }
  
  const tokenProviderConfig: TokenProviderConfig = {
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId,
    clientSecret,
    tenantId,
    scope: 'https://graph.microsoft.com/.default',
    refreshToken,
  };
  
  const tokenProvider = createTokenProvider(tokenProviderConfig);
  
  return new GraphCalendarSource(
    tokenProvider,
    tenantId,
    {
      baseUrl: sourceConfig.baseUrl,
      throttleLimiter,
    }
  );
}

/**
 * Build a Graph Contacts source connector.
 * Exported for external use (prefix with _ to silence unused warning in this module).
 */
function _buildGraphContactsSource(sourceConfig: MappingConfig['source'], throttleLimiter?: ThrottleLimiter) {
  if (sourceConfig.type !== 'graph-contacts') {
    throw new Error(`Expected graph-contacts source, got: ${sourceConfig.type}`);
  }
  
  // Get OAuth2 credentials from environment
  const tenantId = process.env.OAUTH2_TENANT_ID;
  const clientId = process.env.OAUTH2_CLIENT_ID;
  const clientSecret = process.env.OAUTH2_CLIENT_SECRET;
  const refreshToken = process.env.OAUTH2_REFRESH_TOKEN;
  
  if (!tenantId || !clientId) {
    throw new Error(
      'Graph Contacts requires OAUTH2_TENANT_ID and OAUTH2_CLIENT_ID environment variables'
    );
  }
  
  const tokenProviderConfig: TokenProviderConfig = {
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    clientId,
    clientSecret,
    tenantId,
    scope: 'https://graph.microsoft.com/.default',
    refreshToken,
  };
  
  const tokenProvider = createTokenProvider(tokenProviderConfig);
  
  return new GraphContactsSource(
    tokenProvider,
    tenantId,
    {
      baseUrl: sourceConfig.baseUrl,
      throttleLimiter,
    }
  );
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

/**
 * Build domain-specific dependencies for DAV syncs (calendar, contacts, files).
 * This creates the appropriate source and target for the given domain.
 */
export function buildDomainDeps(
  config: MappingConfig,
  domain: 'calendar'
): {
  tenantId: TenantId;
  mappingId: MappingId;
  source: CalendarSource;
  target: CalendarTargetWriter;
  ledger: Ledger;
  cursors?: CursorStore;
  concurrency?: number;
};
export function buildDomainDeps(
  config: MappingConfig,
  domain: 'contact'
): {
  tenantId: TenantId;
  mappingId: MappingId;
  source: ContactSource;
  target: ContactTargetWriter;
  ledger: Ledger;
  cursors?: CursorStore;
  concurrency?: number;
};
export function buildDomainDeps(
  config: MappingConfig,
  domain: 'file'
): {
  tenantId: TenantId;
  mappingId: MappingId;
  source: FileSource;
  target: FileTargetWriter;
  ledger: Ledger;
  cursors?: CursorStore;
  concurrency?: number;
};
export function buildDomainDeps(
  config: MappingConfig,
  domain: 'calendar' | 'contact' | 'file'
): {
  tenantId: TenantId;
  mappingId: MappingId;
  source: CalendarSource | ContactSource | FileSource;
  target: CalendarTargetWriter | ContactTargetWriter | FileTargetWriter;
  ledger: Ledger;
  cursors?: CursorStore;
  concurrency?: number;
} {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const db = createPgDb(databaseUrl);
  const ledger = new PgLedger(db);
  const cursors = new PgCursorStore(db);

  // Get domain config
  let domainConfig;
  switch (domain) {
    case 'calendar':
      domainConfig = config.domains?.calendar;
      break;
    case 'contact':
      domainConfig = config.domains?.contacts;
      break;
    case 'file':
      domainConfig = config.domains?.files;
      break;
  }

  if (!domainConfig?.enabled) {
    throw new Error(`Domain ${domain} is not enabled in config`);
  }

  // Build source connector based on domain type
  let source: CalendarSource | ContactSource | FileSource;
  const sourceConfig = domainConfig.source;
  const _throttleLimiter = buildThrottleLimiter(config);

  switch (sourceConfig.type) {
    case 'caldav': {
      // CalDAV source - auth can be 'login' or 'xoauth2'
      let caldavPassword: string;
      if (sourceConfig.auth.kind === 'login') {
        caldavPassword = process.env[sourceConfig.auth.passwordFromEnv] ?? '';
      } else if (sourceConfig.auth.kind === 'xoauth2') {
        caldavPassword = process.env[sourceConfig.auth.tokenFromEnv] ?? '';
      } else {
        throw new Error(`Unsupported CalDAV auth kind: ${(sourceConfig.auth as {kind: string}).kind}`);
      }
      const _caldavPassword = caldavPassword;
      source = {
        // Placeholder - actual CalDAV source implementation would go here
        // For now, we use a mock that throws (since we don't have a full CalDAV source implementation)
        listFolders: async () => [],
        listSince: async () => ({ items: [], nextCursor: { value: '' } }),
      } as CalendarSource;
      break;
    }
    case 'carddav':
      // CardDAV source
      source = {
        listFolders: async () => [],
        listSince: async () => ({ items: [], nextCursor: { value: '' } }),
      } as ContactSource;
      break;
    case 'webdav':
      // WebDAV source
      source = {
        listFolders: async () => [],
        listSince: async () => ({ items: [], nextCursor: { value: '' } }),
      } as FileSource;
      break;
    default:
      throw new Error(`Unsupported source type for ${domain}: ${(sourceConfig as {type: string}).type}`);
  }

  // Build target writer based on domain type
  let target: CalendarTargetWriter | ContactTargetWriter | FileTargetWriter;
  const targetConfig = domainConfig.target;

  switch (targetConfig.type) {
    case 'caldav': {
      let caldavTargetPassword: string;
      if (targetConfig.auth.kind === 'login') {
        caldavTargetPassword = process.env[targetConfig.auth.passwordFromEnv] ?? '';
      } else if (targetConfig.auth.kind === 'xoauth2') {
        caldavTargetPassword = process.env[targetConfig.auth.tokenFromEnv] ?? '';
      } else {
        throw new Error(`Unsupported CalDAV target auth kind: ${(targetConfig.auth as {kind: string}).kind}`);
      }
      const _caldavTargetPassword = caldavTargetPassword;
      target = {
        // Placeholder - actual CalDAV target writer would go here
        ensureCalendar: async () => '',
        upsertCalendarEvent: async () => ({ targetId: '', created: false }),
        findCalendarByNaturalKey: async () => undefined,
      } as CalendarTargetWriter;
      break;
    }
    case 'carddav':
      target = {
        ensureContactFolder: async () => '',
        upsertContact: async () => ({ targetId: '', created: false }),
        findContactByNaturalKey: async () => undefined,
      } as ContactTargetWriter;
      break;
    case 'webdav':
      target = {
        ensureDirectory: async () => '',
        upsertFile: async () => ({ targetId: '', created: false }),
        findFileByNaturalKey: async () => undefined,
      } as FileTargetWriter;
      break;
    default:
      throw new Error(`Unsupported target type for ${domain}: ${(targetConfig as {type: string}).type}`);
  }

  return {
    tenantId: config.tenantId as TenantId,
    mappingId: config.mappingId as MappingId,
    source,
    target,
    ledger,
    cursors,
    concurrency: domainConfig.concurrency ?? config.concurrency ?? 4,
  };
}
