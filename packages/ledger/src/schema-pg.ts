// Drizzle schema for PostgreSQL — matches the canonical DDL in migrations/0001_init.sql.
// See ADR-0016 (ledger schema v1).

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  bigint,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ========================= Tenancy & connections =========================

export const tenant = pgTable('tenant', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'deleting'] })
    .notNull()
    .default('active'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const connection = pgTable(
  'connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['source', 'target'] }).notNull(),
    kind: text('kind', {
      enum: [
        'o365',
        'soverin',
        'nextcloud',
        'proton',
        'imap',
        'caldav',
        'carddav',
        'webdav',
        'selfhosted_mail',
      ],
    }).notNull(),
    displayName: text('display_name').notNull(),
    config: jsonb('config').notNull().default({}),
    secretRef: text('secret_ref'),
    status: text('status', { enum: ['connected', 'error', 'revoked'] })
      .notNull()
      .default('connected'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_connection_tenant').on(t.tenantId)],
);

// ========================= Mailboxes & mappings =========================

export const mailbox = pgTable(
  'mailbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    externalId: text('external_id'),
    kind: text('kind', { enum: ['user', 'shared', 'archive', 'resource'] })
      .notNull()
      .default('user'),
    primaryAddress: text('primary_address'),
    displayName: text('display_name'),
    quotaBytes: bigint('quota_bytes', { mode: 'bigint' }),
    status: text('status', { enum: ['active', 'deleted_source', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_mailbox_tenant').on(t.tenantId),
    uniqueIndex('uk_mailbox_connection_external').on(t.connectionId, t.externalId),
  ],
);

export const mailboxMapping = pgTable(
  'mailbox_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    sourceMailboxId: uuid('source_mailbox_id')
      .notNull()
      .references(() => mailbox.id, { onDelete: 'cascade' }),
    targetMailboxId: uuid('target_mailbox_id').references(() => mailbox.id, {
      onDelete: 'set null',
    }),
    pattern: text('pattern', { enum: ['shared_s', 'distribution_d'] }),
    mode: text('mode', {
      enum: ['mirror', 'bidirectional', 'one_time', 'asymmetric'],
    })
      .notNull()
      .default('mirror'),
    status: text('status', {
      enum: ['active', 'paused', 'cutover', 'done'],
    })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_mapping_tenant').on(t.tenantId),
    uniqueIndex('uk_mapping_source_target').on(t.sourceMailboxId, t.targetMailboxId),
  ],
);

// ========================= Scope & collection mapping =========================

export const scopeSelection = pgTable(
  'scope_selection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    included: boolean('included').notNull().default(true),
    filters: jsonb('filters').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uk_scope_mapping_domain').on(t.mappingId, t.domain)],
);

export const collectionMapping = pgTable(
  'collection_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    sourceCollection: text('source_collection').notNull(),
    targetCollection: text('target_collection').notNull(),
    specialUse: text('special_use', {
      enum: [
        '\\Inbox',
        '\\Sent',
        '\\Drafts',
        '\\Junk',
        '\\Trash',
        '\\Archive',
      ],
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_collection_mapping').on(t.mappingId, t.domain, t.sourceCollection),
  ],
);

// ========================= The idempotency ledger =========================

export const item = pgTable(
  'item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection').notNull(),
    naturalKey: text('natural_key').notNull(),
    naturalKeyHash: text('natural_key_hash').notNull(), // Using text for hex hash
    contentHash: text('content_hash'),
    sizeBytes: bigint('size_bytes', { mode: 'bigint' }),
    sourceRef: jsonb('source_ref').notNull().default({}),
    targetRef: jsonb('target_ref').notNull().default({}),
    status: text('status', {
      enum: [
        'pending',
        'copied',
        'updated',
        'skipped',
        'failed',
        'deleted_source',
        'tombstoned',
      ],
    })
      .notNull()
      .default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastError: text('last_error'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_item_tenant_mapping_natural_key_hash').on(
      t.tenantId,
      t.mappingId,
      t.naturalKeyHash,
    ),
    index('ix_item_status').on(t.tenantId, t.mappingId, t.status),
    index('ix_item_collection').on(t.tenantId, t.mappingId, t.domain, t.collection),
    index('ix_item_content').on(t.contentHash),
  ],
);

// ========================= Sync checkpoints =========================

export const syncCheckpoint = pgTable(
  'sync_checkpoint',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection').notNull(),
    sourceToken: jsonb('source_token').notNull().default({}),
    lastFullScanAt: timestamp('last_full_scan_at', { withTimezone: true }),
    lastDeltaAt: timestamp('last_delta_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_checkpoint_mapping_domain_collection').on(
      t.mappingId,
      t.domain,
      t.collection,
    ),
  ],
);

// ========================= Runs / orchestration =========================

export const run = pgTable(
  'run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').references(() => mailboxMapping.id, {
      onDelete: 'set null',
    }),
    kind: text('kind', {
      enum: ['initial_copy', 'incremental', 'cutover', 'verify', 'discovery', 'backup'],
    }).notNull(),
    trigger: text('trigger', { enum: ['schedule', 'manual', 'event'] })
      .notNull()
      .default('schedule'),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('queued'),
    orchestratorRef: text('orchestrator_ref'),
    stats: jsonb('stats').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ix_run_tenant').on(t.tenantId, t.createdAt),
    index('ix_run_mapping').on(t.mappingId, t.createdAt),
  ],
);

export const runEvent = pgTable(
  'run_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').notNull().references(() => run.id, { onDelete: 'cascade' }),
    level: text('level', { enum: ['debug', 'info', 'warn', 'error'] })
      .notNull()
      .default('info'),
    message: text('message').notNull(),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_run_event_run').on(t.runId, t.at)],
);

// ========================= Discovery / decision queue =========================

export const decision = pgTable(
  'decision',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').references(() => mailboxMapping.id, {
      onDelete: 'cascade',
    }),
    category: text('category', {
      enum: [
        'new_mailbox',
        'deleted_mailbox',
        'quota',
        'shared_address_pattern',
        'offboarding',
        'alias_removed',
        'new_domain',
        'rules_detected',
        'target_drift',
        'other',
      ],
    }).notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').notNull().default({}),
    proposedDefault: text('proposed_default'),
    status: text('status', { enum: ['pending', 'resolved', 'auto_resolved', 'dismissed'] })
      .notNull()
      .default('pending'),
    resolution: jsonb('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
  },
  (t) => [
    index('ix_decision_pending').on(t.tenantId, t.status).where(sql`status = 'pending'`),
  ],
);

export const policyPreset = pgTable(
  'policy_preset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    action: text('action', { enum: ['auto', 'ask'] }).notNull().default('ask'),
    params: jsonb('params').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('uk_policy_preset_tenant_category').on(t.tenantId, t.category)],
);

// ========================= Verification & cutover =========================

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => run.id, { onDelete: 'set null' }),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection'),
    sourceCount: bigint('source_count', { mode: 'bigint' }),
    targetCount: bigint('target_count', { mode: 'bigint' }),
    sourceBytes: bigint('source_bytes', { mode: 'bigint' }),
    targetBytes: bigint('target_bytes', { mode: 'bigint' }),
    checksumSampled: integer('checksum_sampled').default(0),
    checksumMismatches: integer('checksum_mismatches').default(0),
    status: text('status', { enum: ['pass', 'warn', 'fail'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_verif_mapping').on(t.mappingId, t.createdAt)],
);

export const cutover = pgTable(
  'cutover',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').references(() => mailboxMapping.id, {
      onDelete: 'cascade',
    }),
    state: text('state', {
      enum: [
        'not_started',
        'verifying',
        'gated',
        'switched',
        'grace',
        'done',
        'rolled_back',
      ],
    })
      .notNull()
      .default('not_started'),
    gatePassed: boolean('gate_passed').notNull().default(false),
    mxSwitchedAt: timestamp('mx_switched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ========================= Optional backup target =========================

export const backupTarget = pgTable(
  'backup_target',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id').references(() => mailboxMapping.id, {
      onDelete: 'cascade',
    }),
    kind: text('kind', { enum: ['s3', 'webdav', 'local'] }).notNull(),
    config: jsonb('config').notNull().default({}),
    secretRef: text('secret_ref'),
    enabled: boolean('enabled').notNull().default(false),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ========================= Audit =========================

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    actor: text('actor'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: uuid('entity_id'),
    detail: jsonb('detail'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ix_audit_tenant').on(t.tenantId, t.at)],
);

// ========================= Cursors table (for CursorStore) =========================

export const cursor = pgTable(
  'cursor',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenant.id, { onDelete: 'cascade' }),
    mappingId: uuid('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id, { onDelete: 'cascade' }),
    folderPath: text('folder_path').notNull(),
    cursorValue: text('cursor_value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uk_cursor_tenant_mapping_folder').on(
      t.tenantId,
      t.mappingId,
      t.folderPath,
    ),
  ],
);
