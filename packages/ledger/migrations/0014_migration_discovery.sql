-- Pre-sync discovery counts per domain (workplan 0013 T2).
-- One row per (tenant, mapping, domain); re-discovery overwrites. Read-only, body-free counts
-- shown to the owner before they green-light the migration (SAD §11.2 "scope manifest, shown
-- before start"). Mirrors migration_status (tenant-scoped, RLS-isolated).

-- ========================= Migration Discovery Table =========================
CREATE TABLE IF NOT EXISTS migration_discovery (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id     uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  domain         text NOT NULL CHECK (domain IN ('email','calendar','contact','file')),
  collections    integer NOT NULL DEFAULT 0,
  items          integer NOT NULL DEFAULT 0,
  bytes          bigint,
  per_collection jsonb,
  last_error     text,
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mapping_id, domain)
);

CREATE INDEX IF NOT EXISTS ix_migration_discovery_tenant_mapping
  ON migration_discovery(tenant_id, mapping_id);

-- ========================= Row-Level Security =========================
-- Tenant isolation, matching migration_status.
ALTER TABLE migration_discovery ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_select ON migration_discovery;
CREATE POLICY tenant_isolation_select ON migration_discovery
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_insert ON migration_discovery;
CREATE POLICY tenant_isolation_insert ON migration_discovery
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_update ON migration_discovery;
CREATE POLICY tenant_isolation_update ON migration_discovery
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation_delete ON migration_discovery;
CREATE POLICY tenant_isolation_delete ON migration_discovery
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ========================= Grants =========================
-- Default privileges (migration 0009) already cover future tables for app_user; grant explicitly
-- too (belt-and-suspenders, matching 0009's per-table grants).
GRANT SELECT, INSERT, UPDATE, DELETE ON migration_discovery TO app_user;
