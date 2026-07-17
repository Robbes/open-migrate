-- Migration 0011: Add RLS policies for tenant table
-- 
-- The tenant table was missing RLS policies because it's the root entity
-- (no tenant_id column). This migration adds policies that use the row's
-- id column to match against app.current_tenant setting.
--
-- This ensures tenant isolation even when querying the tenant table itself.

-- Drop existing policies if they exist (for idempotent re-runs)
DROP POLICY IF EXISTS tenant_isolation_select ON tenant;
DROP POLICY IF EXISTS tenant_isolation_insert ON tenant;
DROP POLICY IF EXISTS tenant_isolation_update ON tenant;
DROP POLICY IF EXISTS tenant_isolation_delete ON tenant;

-- SELECT: Only allow reading the tenant if its id matches current_tenant
CREATE POLICY tenant_isolation_select ON tenant
  FOR SELECT
  USING (id = current_setting('app.current_tenant', true)::uuid);

-- INSERT: Only allow creating a tenant with id matching current_tenant
CREATE POLICY tenant_isolation_insert ON tenant
  FOR INSERT
  WITH CHECK (id = current_setting('app.current_tenant', true)::uuid);

-- UPDATE: Only allow updating a tenant if its id matches current_tenant
CREATE POLICY tenant_isolation_update ON tenant
  FOR UPDATE
  USING (id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (id = current_setting('app.current_tenant', true)::uuid);

-- DELETE: Only allow deleting a tenant if its id matches current_tenant
CREATE POLICY tenant_isolation_delete ON tenant
  FOR DELETE
  USING (id = current_setting('app.current_tenant', true)::uuid);
