-- Force Row Level Security Enforcement
-- 
-- CRITICAL: Fixes RLS bypass when connecting as superuser/owner.
-- PostgreSQL exempts superusers and table owners from RLS by default.
-- FORCE ROW LEVEL SECURITY ensures policies are enforced regardless of user role.
--
-- This is a security-critical fix for multi-tenant isolation.
-- Reference: https://www.postgresql.org/docs/current/ddl-rowsecurity.html

-- Force RLS on all tenant-scoped tables
-- This ensures policies are enforced even when connecting as superuser

ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE connection FORCE ROW LEVEL SECURITY;
ALTER TABLE mailbox FORCE ROW LEVEL SECURITY;
ALTER TABLE mailbox_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE group_def FORCE ROW LEVEL SECURITY;
ALTER TABLE scope_selection FORCE ROW LEVEL SECURITY;
ALTER TABLE collection_mapping FORCE ROW LEVEL SECURITY;
ALTER TABLE item FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_checkpoint FORCE ROW LEVEL SECURITY;
ALTER TABLE run FORCE ROW LEVEL SECURITY;
ALTER TABLE run_event FORCE ROW LEVEL SECURITY;
ALTER TABLE decision FORCE ROW LEVEL SECURITY;
ALTER TABLE policy_preset FORCE ROW LEVEL SECURITY;
ALTER TABLE verification FORCE ROW LEVEL SECURITY;
ALTER TABLE cutover FORCE ROW LEVEL SECURITY;
ALTER TABLE backup_target FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE cursor FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_member FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_metric FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_method FORCE ROW LEVEL SECURITY;
