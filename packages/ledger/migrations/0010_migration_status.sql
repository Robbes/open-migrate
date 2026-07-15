-- Migration status tracking for per-domain sync progress
-- Hybrid design: state is maintained, counts are DERIVED from item records
-- Reference: Issue #37, docs/design/migration-status.md

-- ========================= Migration Status Table =========================
CREATE TABLE IF NOT EXISTS migration_status (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id    uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain        text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  state         text NOT NULL CHECK (state IN ('pending','in_progress','completed','failed','skipped')),
  started_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  last_error    text,
  UNIQUE (tenant_id, mapping_id, domain)
);

CREATE INDEX IF NOT EXISTS ix_migration_status_tenant_mapping
  ON migration_status(tenant_id, mapping_id);

CREATE INDEX IF NOT EXISTS ix_migration_status_state
  ON migration_status(state);

-- ========================= Row-Level Security =========================
-- Enable RLS and add tenant isolation policies (matching other tenant-scoped tables)

ALTER TABLE migration_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_select ON migration_status
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON migration_status
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON migration_status
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON migration_status
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
