// Drizzle schema for SQLite — matches the canonical DDL in migrations/0001_init.sql.
// SQLite-specific types and constraints (see ADR-0010, ADR-0016).

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ========================= Tenancy & connections =========================

export const tenant = sqliteTable('tenant', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'deleting'] })
    .notNull()
    .default('active'),
  settings: text('settings', { mode: 'json' }).notNull().default('{}'),
  createdAt: text('created_at').notNull().default(''),
});

export const connection = sqliteTable(
  'connection',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
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
    config: text('config', { mode: 'json' }).notNull().default('{}'),
    secretRef: text('secret_ref'),
    status: text('status', { enum: ['connected', 'error', 'revoked'] })
      .notNull()
      .default('connected'),
    createdAt: text('created_at').notNull().default(''),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (t) => [index('ix_connection_tenant').on(t.tenantId)],
);

// ========================= Mailboxes & mappings =========================

export const mailbox = sqliteTable(
  'mailbox',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id),
    externalId: text('external_id'),
    kind: text('kind', { enum: ['user', 'shared', 'archive', 'resource'] })
      .notNull()
      .default('user'),
    primaryAddress: text('primary_address'),
    displayName: text('display_name'),
    quotaBytes: integer('quota_bytes').$type<number>(),
    status: text('status', { enum: ['active', 'deleted_source', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: text('created_at').notNull().default(''),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (t) => [
    index('ix_mailbox_tenant').on(t.tenantId),
    uniqueIndex('uk_mailbox_connection_external').on(t.connectionId, t.externalId),
  ],
);

export const mailboxMapping = sqliteTable(
  'mailbox_mapping',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    sourceMailboxId: text('source_mailbox_id')
      .notNull()
      .references(() => mailbox.id),
    targetMailboxId: text('target_mailbox_id').references(() => mailbox.id),
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
    createdAt: text('created_at').notNull().default(''),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (t) => [
    index('ix_mapping_tenant').on(t.tenantId),
    uniqueIndex('uk_mapping_source_target').on(t.sourceMailboxId, t.targetMailboxId),
  ],
);

// ========================= Scope & collection mapping =========================

export const scopeSelection = sqliteTable(
  'scope_selection',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    included: integer('included', { mode: 'boolean' }).notNull().default(true),
    filters: text('filters', { mode: 'json' }).notNull().default('{}'),
    createdAt: text('created_at').notNull().default(''),
  },
  (t) => [uniqueIndex('uk_scope_mapping_domain').on(t.mappingId, t.domain)],
);

export const collectionMapping = sqliteTable(
  'collection_mapping',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
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
    createdAt: text('created_at').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uk_collection_mapping').on(t.mappingId, t.domain, t.sourceCollection),
  ],
);

// ========================= The idempotency ledger =========================

export const item = sqliteTable(
  'item',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection').notNull(),
    naturalKey: text('natural_key').notNull(),
    naturalKeyHash: text('natural_key_hash').notNull(),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes').$type<number>(),
    sourceRef: text('source_ref', { mode: 'json' }).notNull().default('{}'),
    targetRef: text('target_ref', { mode: 'json' }).notNull().default('{}'),
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
    firstSeenAt: text('first_seen_at').notNull().default(''),
    lastSyncedAt: text('last_synced_at'),
    updatedAt: text('updated_at').notNull().default(''),
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

export const syncCheckpoint = sqliteTable(
  'sync_checkpoint',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection').notNull(),
    sourceToken: text('source_token', { mode: 'json' }).notNull().default('{}'),
    lastFullScanAt: text('last_full_scan_at'),
    lastDeltaAt: text('last_delta_at'),
    updatedAt: text('updated_at').notNull().default(''),
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

export const run = sqliteTable(
  'run',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id').references(() => mailboxMapping.id),
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
    stats: text('stats', { mode: 'json' }).notNull().default('{}'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull().default(''),
  },
  (t) => [
    index('ix_run_tenant').on(t.tenantId, t.createdAt),
    index('ix_run_mapping').on(t.mappingId, t.createdAt),
  ],
);

export const runEvent = sqliteTable(
  'run_event',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    runId: text('run_id').notNull().references(() => run.id),
    level: text('level', { enum: ['debug', 'info', 'warn', 'error'] })
      .notNull()
      .default('info'),
    message: text('message').notNull(),
    detail: text('detail', { mode: 'json' }),
    at: text('at').notNull().default(''),
  },
  (t) => [index('ix_run_event_run').on(t.runId, t.at)],
);

// ========================= Discovery / decision queue =========================

export const decision = sqliteTable(
  'decision',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id').references(() => mailboxMapping.id),
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
    detail: text('detail', { mode: 'json' }).notNull().default('{}'),
    proposedDefault: text('proposed_default'),
    status: text('status', { enum: ['pending', 'resolved', 'auto_resolved', 'dismissed'] })
      .notNull()
      .default('pending'),
    resolution: text('resolution', { mode: 'json' }),
    createdAt: text('created_at').notNull().default(''),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
  },
  (t) => [index('ix_decision_pending').on(t.tenantId, t.status)],
);

export const policyPreset = sqliteTable(
  'policy_preset',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    category: text('category').notNull(),
    action: text('action', { enum: ['auto', 'ask'] }).notNull().default('ask'),
    params: text('params', { mode: 'json' }).notNull().default('{}'),
    createdAt: text('created_at').notNull().default(''),
  },
  (t) => [uniqueIndex('uk_policy_preset_tenant_category').on(t.tenantId, t.category)],
);

// ========================= Verification & cutover =========================

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    runId: text('run_id').references(() => run.id),
    domain: text('domain', { enum: ['email', 'calendar', 'contact', 'file'] }).notNull(),
    collection: text('collection'),
    sourceCount: integer('source_count').$type<number>(),
    targetCount: integer('target_count').$type<number>(),
    sourceBytes: integer('source_bytes').$type<number>(),
    targetBytes: integer('target_bytes').$type<number>(),
    checksumSampled: integer('checksum_sampled').default(0),
    checksumMismatches: integer('checksum_mismatches').default(0),
    status: text('status', { enum: ['pass', 'warn', 'fail'] }).notNull(),
    createdAt: text('created_at').notNull().default(''),
  },
  (t) => [index('ix_verif_mapping').on(t.mappingId, t.createdAt)],
);

export const cutover = sqliteTable(
  'cutover',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id').references(() => mailboxMapping.id),
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
    gatePassed: integer('gate_passed', { mode: 'boolean' }).notNull().default(false),
    mxSwitchedAt: text('mx_switched_at'),
    completedAt: text('completed_at'),
    notes: text('notes'),
    createdAt: text('created_at').notNull().default(''),
  },
);

// ========================= Cutover State Machine (persistent) =========================

export const cutoverState = sqliteTable(
  'cutover_state',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    state: text('state', {
      enum: [
        'PREPARING',
        'READY_FOR_CUTOVER',
        'CUTOVER_IN_PROGRESS',
        'GRACE_PERIOD',
        'COMPLETED',
        'FAILED',
        'ROLLED_BACK',
      ],
    })
      .notNull()
      .default('PREPARING'),
    phase: text('phase', {
      enum: ['verification', 'approval', 'cutover', 'grace', 'completion', 'rollback'],
    })
      .notNull()
      .default('verification'),
    verificationStatus: text('verification_status', {
      enum: ['pending', 'pass', 'fail', 'warn', 'skipped'],
    })
      .notNull()
      .default('pending'),
    verificationReport: text('verification_report', { mode: 'json' }).notNull().default('{}'),
    gracePeriodHours: integer('grace_period_hours').notNull().default(72),
    gracePeriodStartedAt: text('grace_period_started_at'),
    gracePeriodCompletedAt: text('grace_period_completed_at'),
    metadata: text('metadata', { mode: 'json' }).notNull().default('{}'),
    createdAt: text('created_at').notNull().default(''),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uk_cutover_state_mapping').on(t.tenantId, t.mappingId),
    index('ix_cutover_state_tenant').on(t.tenantId),
    index('ix_cutover_state_mapping').on(t.mappingId),
  ],
);

export const cutoverEvent = sqliteTable(
  'cutover_event',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    timestamp: text('timestamp').notNull().default(''),
    fromState: text('from_state', {
      enum: [
        'PREPARING',
        'READY_FOR_CUTOVER',
        'CUTOVER_IN_PROGRESS',
        'GRACE_PERIOD',
        'COMPLETED',
        'FAILED',
        'ROLLED_BACK',
      ],
    }).notNull(),
    toState: text('to_state', {
      enum: [
        'PREPARING',
        'READY_FOR_CUTOVER',
        'CUTOVER_IN_PROGRESS',
        'GRACE_PERIOD',
        'COMPLETED',
        'FAILED',
        'ROLLED_BACK',
      ],
    }).notNull(),
    triggeredBy: text('triggered_by').notNull(),
    reason: text('reason'),
    metadata: text('metadata', { mode: 'json' }).notNull().default('{}'),
  },
  (t) => [
    index('ix_cutover_event_mapping').on(t.mappingId, t.timestamp),
    index('ix_cutover_event_tenant').on(t.tenantId, t.timestamp),
  ],
);

// ========================= Optional backup target =========================

export const backupTarget = sqliteTable(
  'backup_target',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id').references(() => mailboxMapping.id),
    kind: text('kind', { enum: ['s3', 'webdav', 'local'] }).notNull(),
    config: text('config', { mode: 'json' }).notNull().default('{}'),
    secretRef: text('secret_ref'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
    lastRunAt: text('last_run_at'),
    createdAt: text('created_at').notNull().default(''),
  },
);

// ========================= Audit =========================

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    actor: text('actor'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    detail: text('detail', { mode: 'json' }),
    at: text('at').notNull().default(''),
  },
  (t) => [index('ix_audit_tenant').on(t.tenantId, t.at)],
);

// ========================= Cursors table (for CursorStore) =========================

export const cursor = sqliteTable(
  'cursor',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenant.id),
    mappingId: text('mapping_id')
      .notNull()
      .references(() => mailboxMapping.id),
    folderPath: text('folder_path').notNull(),
    cursorValue: text('cursor_value').notNull(),
    updatedAt: text('updated_at').notNull().default(''),
  },
  (t) => [
    uniqueIndex('uk_cursor_tenant_mapping_folder').on(
      t.tenantId,
      t.mappingId,
      t.folderPath,
    ),
  ],
);
