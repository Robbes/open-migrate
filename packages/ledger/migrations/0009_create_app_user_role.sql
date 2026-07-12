-- Create application role for RLS enforcement
--
-- Creates a non-superuser role 'app_user' that will be used by the application.
-- This ensures RLS is always enforced, as superusers bypass RLS even with FORCE.
--
-- The test suite should connect as this role to verify RLS works correctly.
-- Reference: https://www.postgresql.org/docs/current/ddl-rowsecurity.html

-- Create the app_user role (if not exists)
-- Note: We use DO to avoid error if role already exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

-- Grant schema access
GRANT USAGE ON SCHEMA public TO app_user;

-- Grant all table access to app_user (for existing tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

-- Explicitly grant permissions on all tenant-scoped tables
-- (DEFAULT PRIVILEGES only apply to future tables)
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON connection TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailbox TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON mailbox_mapping TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON group_def TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON scope_selection TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON collection_mapping TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON item TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_checkpoint TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON run TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON run_event TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON decision TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON policy_preset TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON verification TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cutover TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON backup_target TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON cursor TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_member TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_metric TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_method TO app_user;

-- Set up default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Note: The application should connect as 'app_user' instead of 'postgres'
-- to ensure RLS is always enforced.
