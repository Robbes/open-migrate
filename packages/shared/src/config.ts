/** Thrown when a mapping config fails validation; the message carries the offending path. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type SourceAuth =
  | { readonly kind: 'xoauth2'; readonly tokenFromEnv: string }
  | { readonly kind: 'login'; readonly passwordFromEnv: string };

/** O365 source over IMAP+OAuth2 (slice 0001). */
export interface ImapOAuth2Source {
  readonly type: 'imap-oauth2';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SourceAuth;
}

export type JmapAuth =
  | { readonly kind: 'basic'; readonly passwordFromEnv: string }
  | { readonly kind: 'bearer'; readonly tokenFromEnv: string };

/** JMAP target (primary family). */
export interface JmapTarget {
  readonly type: 'jmap';
  readonly baseUrl: string;
  readonly user: string;
  readonly auth: JmapAuth;
}

/** IMAP/DAV target (second family, slice 0002). */
export interface ImapDavTarget {
  readonly type: 'imap-dav';
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** CalDAV source for calendar data */
export interface CalDAVSource {
  readonly type: 'caldav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** CardDAV source for contact data */
export interface CardDAVSource {
  readonly type: 'carddav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** WebDAV source for file data */
export interface WebDAVSource {
  readonly type: 'webdav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** CalDAV target for calendar data */
export interface CalDAVTarget {
  readonly type: 'caldav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** CardDAV target for contact data */
export interface CardDAVTarget {
  readonly type: 'carddav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** WebDAV target for file data */
export interface WebDAVTarget {
  readonly type: 'webdav';
  readonly url: string;
  readonly user: string;
  readonly auth: SourceAuth;
}

/** Per-domain sync configuration for multi-domain sync */
export interface DomainConfig {
  /** Whether this domain is enabled */
  readonly enabled: boolean;
  /** Source connector for this domain */
  readonly source: SourceConfig;
  /** Target writer for this domain */
  readonly target: TargetConfig;
  /** Optional per-domain concurrency override */
  readonly concurrency?: number;
}

/** Per-domain configuration block for multi-domain sync */
export interface DomainsConfig {
  mail?: DomainConfig;
  calendar?: DomainConfig;
  contacts?: DomainConfig;
  files?: DomainConfig;
}

export type SourceConfig = ImapOAuth2Source | CalDAVSource | CardDAVSource | WebDAVSource;
export type TargetConfig = JmapTarget | ImapDavTarget | CalDAVTarget | CardDAVTarget | WebDAVTarget;

export interface ScheduleConfig {
  readonly cron: string;
}

export interface MappingConfig {
  readonly tenantId: string;
  readonly mappingId: string;
  readonly source: SourceConfig;
  readonly target: TargetConfig;
  readonly schedule?: ScheduleConfig;
  /** Max messages processed in parallel per folder (bounds throughput and peak memory). */
  readonly concurrency?: number;
  /** Optional per-domain configuration for multi-domain sync */
  readonly domains?: DomainsConfig;
}

function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ConfigError(`${path}: expected an object`);
  }
  return v as Record<string, unknown>;
}

function reqString(obj: Record<string, unknown>, key: string, path: string): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ConfigError(`${path}: expected a non-empty string`);
  }
  return v;
}

function reqInt(obj: Record<string, unknown>, key: string, path: string): number {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new ConfigError(`${path}: expected an integer`);
  }
  return v;
}

function parseSourceAuth(obj: Record<string, unknown>): SourceAuth {
  const kind = reqString(obj, 'kind', 'source.auth.kind');
  if (kind === 'xoauth2') return { kind: 'xoauth2', tokenFromEnv: reqString(obj, 'tokenFromEnv', 'source.auth.tokenFromEnv') };
  if (kind === 'login') return { kind: 'login', passwordFromEnv: reqString(obj, 'passwordFromEnv', 'source.auth.passwordFromEnv') };
  throw new ConfigError(`source.auth.kind: unsupported "${kind}" (expected "xoauth2" or "login")`);
}

function parseSource(obj: Record<string, unknown>): SourceConfig {
  const type = reqString(obj, 'type', 'source.type');
  if (type === 'imap-oauth2') {
    return {
      type: 'imap-oauth2',
      host: reqString(obj, 'host', 'source.host'),
      port: reqInt(obj, 'port', 'source.port'),
      user: reqString(obj, 'user', 'source.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'source.auth')),
    };
  }
  if (type === 'caldav') {
    return {
      type: 'caldav',
      url: reqString(obj, 'url', 'source.url'),
      user: reqString(obj, 'user', 'source.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'source.auth')),
    };
  }
  if (type === 'carddav') {
    return {
      type: 'carddav',
      url: reqString(obj, 'url', 'source.url'),
      user: reqString(obj, 'user', 'source.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'source.auth')),
    };
  }
  if (type === 'webdav') {
    return {
      type: 'webdav',
      url: reqString(obj, 'url', 'source.url'),
      user: reqString(obj, 'user', 'source.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'source.auth')),
    };
  }
  throw new ConfigError(`source.type: unsupported "${type}" (expected "imap-oauth2", "caldav", "carddav", or "webdav")`);
}

function parseJmapAuth(obj: Record<string, unknown>): JmapAuth {
  const kind = reqString(obj, 'kind', 'target.auth.kind');
  if (kind === 'basic') return { kind: 'basic', passwordFromEnv: reqString(obj, 'passwordFromEnv', 'target.auth.passwordFromEnv') };
  if (kind === 'bearer') return { kind: 'bearer', tokenFromEnv: reqString(obj, 'tokenFromEnv', 'target.auth.tokenFromEnv') };
  throw new ConfigError(`target.auth.kind: unsupported "${kind}" (expected "basic" or "bearer")`);
}

function parseTarget(obj: Record<string, unknown>): TargetConfig {
  const type = reqString(obj, 'type', 'target.type');
  if (type === 'jmap') {
    return {
      type: 'jmap',
      baseUrl: reqString(obj, 'baseUrl', 'target.baseUrl'),
      user: reqString(obj, 'user', 'target.user'),
      auth: parseJmapAuth(asRecord(obj.auth, 'target.auth')),
    };
  }
  if (type === 'imap-dav') {
    return {
      type: 'imap-dav',
      host: reqString(obj, 'host', 'target.host'),
      port: reqInt(obj, 'port', 'target.port'),
      user: reqString(obj, 'user', 'target.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'target.auth')),
    };
  }
  if (type === 'caldav') {
    return {
      type: 'caldav',
      url: reqString(obj, 'url', 'target.url'),
      user: reqString(obj, 'user', 'target.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'target.auth')),
    };
  }
  if (type === 'carddav') {
    return {
      type: 'carddav',
      url: reqString(obj, 'url', 'target.url'),
      user: reqString(obj, 'user', 'target.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'target.auth')),
    };
  }
  if (type === 'webdav') {
    return {
      type: 'webdav',
      url: reqString(obj, 'url', 'target.url'),
      user: reqString(obj, 'user', 'target.user'),
      auth: parseSourceAuth(asRecord(obj.auth, 'target.auth')),
    };
  }
  throw new ConfigError(`target.type: unsupported "${type}" (expected "jmap", "imap-dav", "caldav", "carddav", or "webdav")`);
}

/** Validate a parsed config object into a typed MappingConfig (throws ConfigError on the first issue). */
export function parseMappingConfig(input: unknown): MappingConfig {
  const root = asRecord(input, '(root)');
  const tenantId = reqString(root, 'tenantId', 'tenantId');
  const mappingId = reqString(root, 'mappingId', 'mappingId');
  const source = parseSource(asRecord(root.source, 'source'));
  const target = parseTarget(asRecord(root.target, 'target'));
  const schedule =
    root.schedule === undefined
      ? undefined
      : { cron: reqString(asRecord(root.schedule, 'schedule'), 'cron', 'schedule.cron') };
  const concurrency = root.concurrency === undefined ? undefined : reqInt(root, 'concurrency', 'concurrency');
  const domains = root.domains === undefined ? undefined : parseDomainsConfig(asRecord(root.domains, 'domains'));

  return {
    tenantId,
    mappingId,
    source,
    target,
    ...(schedule ? { schedule } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(domains !== undefined ? { domains } : {}),
  };
}

/** Parse and validate the domains configuration block */
function parseDomainsConfig(obj: Record<string, unknown>): DomainsConfig {
  const domains: DomainsConfig = {};

  // Parse mail domain
  if (obj.mail !== undefined) {
    const mail = asRecord(obj.mail, 'domains.mail');
    domains.mail = {
      enabled: reqBoolean(mail, 'enabled', 'domains.mail.enabled'),
      source: parseSource(asRecord(mail.source, 'domains.mail.source')),
      target: parseTarget(asRecord(mail.target, 'domains.mail.target')),
      ...(mail.concurrency !== undefined ? { concurrency: reqInt(mail, 'concurrency', 'domains.mail.concurrency') } : {}),
    };
  }

  // Parse calendar domain
  if (obj.calendar !== undefined) {
    const calendar = asRecord(obj.calendar, 'domains.calendar');
    domains.calendar = {
      enabled: reqBoolean(calendar, 'enabled', 'domains.calendar.enabled'),
      source: parseSource(asRecord(calendar.source, 'domains.calendar.source')),
      target: parseTarget(asRecord(calendar.target, 'domains.calendar.target')),
      ...(calendar.concurrency !== undefined ? { concurrency: reqInt(calendar, 'concurrency', 'domains.calendar.concurrency') } : {}),
    };
  }

  // Parse contacts domain
  if (obj.contacts !== undefined) {
    const contacts = asRecord(obj.contacts, 'domains.contacts');
    domains.contacts = {
      enabled: reqBoolean(contacts, 'enabled', 'domains.contacts.enabled'),
      source: parseSource(asRecord(contacts.source, 'domains.contacts.source')),
      target: parseTarget(asRecord(contacts.target, 'domains.contacts.target')),
      ...(contacts.concurrency !== undefined ? { concurrency: reqInt(contacts, 'concurrency', 'domains.contacts.concurrency') } : {}),
    };
  }

  // Parse files domain
  if (obj.files !== undefined) {
    const files = asRecord(obj.files, 'domains.files');
    domains.files = {
      enabled: reqBoolean(files, 'enabled', 'domains.files.enabled'),
      source: parseSource(asRecord(files.source, 'domains.files.source')),
      target: parseTarget(asRecord(files.target, 'domains.files.target')),
      ...(files.concurrency !== undefined ? { concurrency: reqInt(files, 'concurrency', 'domains.files.concurrency') } : {}),
    };
  }

  return domains;
}

function reqBoolean(obj: Record<string, unknown>, key: string, path: string): boolean {
  const v = obj[key];
  if (typeof v !== 'boolean') {
    throw new ConfigError(`${path}: expected a boolean`);
  }
  return v;
}

/** Parse + validate a mapping config from JSON text. Unknown extra keys (e.g. "_note") are ignored. */
export function parseMappingConfigJson(text: string): MappingConfig {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`invalid JSON: ${(e as Error).message}`);
  }
  return parseMappingConfig(data);
}
