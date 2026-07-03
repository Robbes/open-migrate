-- Sovereign Migration Stack — ledger schema (canonical: PostgreSQL)
-- SQLite (self-host) substitutions are documented in packages/ledger/README.md.
-- Design rationale: ADR-0005 (idempotency/ledger), ADR-0010 (persistence), ADR-0016 (this schema).

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ========================= Tenancy & connections =========================
CREATE TABLE IF NOT EXISTS tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleting')),
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A source or target system. Secrets are NEVER stored here; secret_ref points to the vault.
CREATE TABLE IF NOT EXISTS connection (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('source','target')),
  kind         text NOT NULL CHECK (kind IN
                 ('o365','soverin','nextcloud','proton','imap','caldav','carddav','webdav','selfhosted_mail')),
  display_name text NOT NULL,
  config       jsonb NOT NULL DEFAULT '{}',   -- non-secret: hosts, base URLs, drive ids, MS tenant id
  secret_ref   text,                          -- pointer to vault; NEVER the secret itself
  status       text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','revoked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_connection_tenant ON connection(tenant_id);

-- ========================= Mailboxes & mappings =========================
-- Mailboxes exist on both source and target connections.
CREATE TABLE IF NOT EXISTS mailbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  external_id     text,            -- IMMUTABLE id: Graph GUID (source) / provider id (target). Renames => UPDATE, not delete+create.
  kind            text NOT NULL DEFAULT 'user' CHECK (kind IN ('user','shared','archive','resource')),
  primary_address text,
  display_name    text,
  quota_bytes     bigint,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted_source','disabled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, external_id)
);
CREATE INDEX IF NOT EXISTS ix_mailbox_tenant ON mailbox(tenant_id);

-- Links a source mailbox to its target mailbox; carries mode and the shared-address pattern.
CREATE TABLE IF NOT EXISTS mailbox_mapping (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_mailbox_id uuid NOT NULL REFERENCES mailbox(id) ON DELETE CASCADE,
  target_mailbox_id uuid REFERENCES mailbox(id) ON DELETE SET NULL,
  pattern           text CHECK (pattern IN ('shared_s','distribution_d')),  -- NULL = ordinary mailbox
  mode              text NOT NULL DEFAULT 'mirror'
                      CHECK (mode IN ('mirror','bidirectional','one_time','asymmetric')),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','paused','cutover','done')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_mailbox_id, target_mailbox_id)
);
CREATE INDEX IF NOT EXISTS ix_mapping_tenant ON mailbox_mapping(tenant_id);

-- Distribution list (Pattern D): definition + members; no message store to copy.
CREATE TABLE IF NOT EXISTS group_def (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_connection_id uuid NOT NULL REFERENCES connection(id) ON DELETE CASCADE,
  address              text NOT NULL,
  members              jsonb NOT NULL DEFAULT '[]',   -- array of addresses (may include external)
  target_group_ref     text,
  status               text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','created','error')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_group_tenant ON group_def(tenant_id);

-- ========================= Scope & collection mapping =========================
CREATE TABLE IF NOT EXISTS scope_selection (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain     text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  included   boolean NOT NULL DEFAULT true,
  filters    jsonb NOT NULL DEFAULT '{}',     -- folders, date_range, drives
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mapping_id, domain)
);

-- Special-use folder mapping (RFC 6154), e.g. "Sent Items" -> "Sent" (\Sent).
CREATE TABLE IF NOT EXISTS collection_mapping (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id        uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain            text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  source_collection text NOT NULL,
  target_collection text NOT NULL,
  special_use       text CHECK (special_use IN ('\Inbox','\Sent','\Drafts','\Junk','\Trash','\Archive')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mapping_id, domain, source_collection)
);

-- ========================= The idempotency ledger =========================
-- One row per source item. The UNIQUE (tenant, mapping, natural_key_hash) is the idempotency anchor.
CREATE TABLE IF NOT EXISTS item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id       uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain           text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  collection       text NOT NULL,               -- folder path / calendar id / addressbook id / drive root
  natural_key      text NOT NULL,               -- Message-ID / iCal UID(+RECURRENCE-ID) / vCard UID / file path
  natural_key_hash text NOT NULL,               -- sha-256 hex of (domain | collection | natural_key)
  content_hash     text,                        -- change detection
  size_bytes       bigint,
  source_ref       jsonb NOT NULL DEFAULT '{}', -- {graphId, imapUid, uidValidity, etag, driveItemId, ...}
  target_ref       jsonb NOT NULL DEFAULT '{}', -- {uid, href, etag, path, ...}
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','copied','updated','skipped','failed','deleted_source','tombstoned')),
  attempt_count    int NOT NULL DEFAULT 0,
  last_error       text,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_synced_at   timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mapping_id, natural_key_hash)
);
CREATE INDEX IF NOT EXISTS ix_item_status      ON item(tenant_id, mapping_id, status);
CREATE INDEX IF NOT EXISTS ix_item_collection  ON item(tenant_id, mapping_id, domain, collection);
CREATE INDEX IF NOT EXISTS ix_item_content     ON item(content_hash);
-- For very large mailboxes, consider partitioning `item` by mapping_id (future).

-- ========================= Sync checkpoints (delta state) =========================
CREATE TABLE IF NOT EXISTS sync_checkpoint (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id        uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain            text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  collection        text NOT NULL,
  source_token      jsonb NOT NULL DEFAULT '{}', -- {deltaLink}|{syncToken}|{uidValidity,uidNext,highestModSeq}|{ctag}
  last_full_scan_at timestamptz,
  last_delta_at     timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mapping_id, domain, collection)
);

-- ========================= Runs / orchestration =========================
CREATE TABLE IF NOT EXISTS run (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id       uuid REFERENCES mailbox_mapping(id) ON DELETE SET NULL,  -- NULL = tenant-wide
  kind             text NOT NULL CHECK (kind IN ('initial_copy','incremental','cutover','verify','discovery','backup')),
  trigger          text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','event')),
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  orchestrator_ref text,                        -- Trigger.dev run id
  stats            jsonb NOT NULL DEFAULT '{}', -- {seen,created,updated,skipped,failed,bytes}
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_run_tenant  ON run(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_run_mapping ON run(mapping_id, created_at DESC);

CREATE TABLE IF NOT EXISTS run_event (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  run_id    uuid NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  level     text NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warn','error')),
  message   text NOT NULL,
  detail    jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_run_event_run ON run_event(run_id, at);

-- ========================= Discovery / decision queue (§11.1/§11.2) =========================
CREATE TABLE IF NOT EXISTS decision (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id       uuid REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  category         text NOT NULL CHECK (category IN
                     ('new_mailbox','deleted_mailbox','quota','shared_address_pattern','offboarding',
                      'alias_removed','new_domain','rules_detected','target_drift','other')),
  summary          text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}',
  proposed_default text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','auto_resolved','dismissed')),
  resolution       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  resolved_by      text
);
CREATE INDEX IF NOT EXISTS ix_decision_pending ON decision(tenant_id, status) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS policy_preset (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  category   text NOT NULL,
  action     text NOT NULL DEFAULT 'ask' CHECK (action IN ('auto','ask')),
  params     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, category)
);

-- ========================= Verification & cutover =========================
CREATE TABLE IF NOT EXISTS verification (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id          uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  run_id              uuid REFERENCES run(id) ON DELETE SET NULL,
  domain              text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  collection          text,
  source_count        bigint,
  target_count        bigint,
  source_bytes        bigint,
  target_bytes        bigint,
  checksum_sampled    int DEFAULT 0,
  checksum_mismatches int DEFAULT 0,
  status              text NOT NULL CHECK (status IN ('pass','warn','fail')),
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_verif_mapping ON verification(mapping_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cutover (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id     uuid REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  state          text NOT NULL DEFAULT 'not_started'
                   CHECK (state IN ('not_started','verifying','gated','switched','grace','done','rolled_back')),
  gate_passed    boolean NOT NULL DEFAULT false,
  mx_switched_at timestamptz,
  completed_at   timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ========================= Optional user-controlled extra backup (ADR-0015) =========================
CREATE TABLE IF NOT EXISTS backup_target (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id  uuid REFERENCES mailbox_mapping(id) ON DELETE CASCADE,   -- NULL = tenant-wide
  kind        text NOT NULL CHECK (kind IN ('s3','webdav','local')),
  config      jsonb NOT NULL DEFAULT '{}',    -- non-secret
  secret_ref  text,
  enabled     boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ========================= Audit =========================
CREATE TABLE IF NOT EXISTS audit_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  actor     text,            -- user id / 'system'
  action    text NOT NULL,   -- 'scope.changed','decision.resolved','cutover.started', ...
  entity    text,
  entity_id uuid,
  detail    jsonb,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_tenant ON audit_log(tenant_id, at DESC);

-- ========================= IMAP/DAV cursors (incremental sync state) =========================
-- IMAP: {uidValidity, uidNext, highestModSeq} | CalDAV/CardDAV: {syncToken} | WebDAV: {ctag}
CREATE TABLE IF NOT EXISTS cursor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id   uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  folder_path  text NOT NULL,
  cursor_value jsonb NOT NULL DEFAULT '{}',  -- domain-specific cursor structure
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mapping_id, folder_path)
);
CREATE INDEX IF NOT EXISTS ix_cursor_tenant_mapping ON cursor(tenant_id, mapping_id);

-- Note: Row-Level Security (RLS) is enabled in managed deployments only.
-- Self-host/SQLite: skip RLS (single tenant; still always filter by tenant_id in queries).
