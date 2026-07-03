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

export type SourceConfig = ImapOAuth2Source;
export type TargetConfig = JmapTarget | ImapDavTarget;

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
  if (type !== 'imap-oauth2') {
    throw new ConfigError(`source.type: unsupported "${type}" (expected "imap-oauth2")`);
  }
  return {
    type: 'imap-oauth2',
    host: reqString(obj, 'host', 'source.host'),
    port: reqInt(obj, 'port', 'source.port'),
    user: reqString(obj, 'user', 'source.user'),
    auth: parseSourceAuth(asRecord(obj.auth, 'source.auth')),
  };
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
  throw new ConfigError(`target.type: unsupported "${type}" (expected "jmap" or "imap-dav")`);
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

  return {
    tenantId,
    mappingId,
    source,
    target,
    ...(schedule ? { schedule } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
  };
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
