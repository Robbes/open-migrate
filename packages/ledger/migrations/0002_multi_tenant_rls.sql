-- Workplan 0005: Managed Edition — Multi-tenant enhancements
-- Adds tenant_members, usage_metrics, and RLS policies
-- Reference: ADR-0010, ADR-0014, Workplan 0005 Phase 1

-- ========================= Tenant Members =========================
-- User accounts and roles within a tenant
CREATE TABLE IF NOT EXISTS tenant_member (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  user_id    text NOT NULL,              -- Auth provider user ID (e.g., from auth service)
  email      text NOT NULL,
  role       text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'removed')),
  invited_at timestamptz,
  joined_at  timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_tenant_member_tenant ON tenant_member(tenant_id);
CREATE INDEX IF NOT EXISTS ix_tenant_member_user ON tenant_member(user_id);

-- ========================= Usage Metrics (for billing) =========================
-- Tracks resource consumption per tenant for cost-recovery billing
CREATE TABLE IF NOT EXISTS usage_metric (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_start date NOT NULL,              -- Billing period start (e.g., first of month)
  period_end   date NOT NULL,              -- Billing period end
  metric_type  text NOT NULL CHECK (metric_type IN ('storage', 'egress', 'compute', 'api_calls')),
  resource     text,                       -- Optional: specific resource (e.g., 'mailbox', 'calendar')
  quantity     numeric NOT NULL DEFAULT 0, -- Quantity consumed
  unit         text NOT NULL,              -- Unit of measurement (e.g., 'GB', 'GB-egress', 'hours', 'requests')
  unit_price   numeric NOT NULL DEFAULT 0, -- Price per unit (cost-recovery)
  total_cost   numeric NOT NULL DEFAULT 0, -- quantity * unit_price
  metadata     jsonb NOT NULL DEFAULT '{}', -- Additional context (e.g., breakdown by mapping)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start, metric_type, resource)
);
CREATE INDEX IF NOT EXISTS ix_usage_tenant_period ON usage_metric(tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ix_usage_period_type ON usage_metric(period_start, metric_type);

-- ========================= Billing Invoices =========================
-- Generated invoices for each tenant's usage
CREATE TABLE IF NOT EXISTS invoice (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  subtotal        numeric NOT NULL DEFAULT 0,      -- Sum of all usage costs
  tax_rate        numeric NOT NULL DEFAULT 0,      -- Tax percentage
  tax_amount      numeric NOT NULL DEFAULT 0,
  total           numeric NOT NULL DEFAULT 0,      -- subtotal + tax
  currency        text NOT NULL DEFAULT 'EUR',
  payment_method  text,                            -- Mollie payment method ID
  payment_id      text,                            -- Mollie payment ID
  paid_at         timestamptz,
  due_date        date,
  sent_at         timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}',     -- Line items breakdown
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period_start)
);
CREATE INDEX IF NOT EXISTS ix_invoice_tenant ON invoice(tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS ix_invoice_status ON invoice(status, period_start);

-- ========================= Payment Methods =========================
-- Stored payment methods for tenants (via Mollie)
CREATE TABLE IF NOT EXISTS payment_method (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mollie_id     text NOT NULL UNIQUE,         -- Mollie payment method ID
  type          text NOT NULL,                -- 'creditcard', 'ideal', 'bancontact', etc.
  brand         text,                         -- 'visa', 'mastercard', etc.
  last_four     text,                         -- Last 4 digits for cards
  expiry_month  integer,
  expiry_year   integer,
  is_default    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_method_tenant ON payment_method(tenant_id);

-- ========================= Row-Level Security (RLS) =========================
-- Enable RLS on all tenant-scoped tables
-- Note: RLS is only enforced in managed (Postgres) deployments.
-- Self-host (SQLite) skips RLS but always filters by tenant_id in application code.

ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE mailbox_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_def ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_selection ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE item ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_checkpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE run ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_preset ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification ENABLE ROW LEVEL SECURITY;
ALTER TABLE cutover ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_method ENABLE ROW LEVEL SECURITY;

-- ========================= RLS Policies =========================
-- Policy function: checks if current_tenant setting is set and matches
-- Application must SET app.current_tenant = 'uuid' before queries

-- Generic policy for SELECT (allow if tenant_id matches current setting)
-- Note: No policy on 'tenant' table itself - it's the root entity

CREATE POLICY tenant_isolation_select ON connection
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON mailbox
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON mailbox_mapping
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON group_def
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON scope_selection
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON collection_mapping
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON item
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON sync_checkpoint
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON run
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON run_event
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON decision
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON policy_preset
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON verification
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON cutover
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON backup_target
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON audit_log
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON cursor
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON tenant_member
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON usage_metric
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON invoice
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_select ON payment_method
  FOR SELECT
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- INSERT policies (allow if tenant_id matches current setting)
-- Note: No INSERT policy on 'tenant' - tenants are provisioned via admin/API

CREATE POLICY tenant_isolation_insert ON connection
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON mailbox
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON mailbox_mapping
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON group_def
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON scope_selection
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON collection_mapping
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON item
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON sync_checkpoint
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON run
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON run_event
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON decision
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON policy_preset
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON verification
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON cutover
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON backup_target
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON audit_log
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON cursor
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON tenant_member
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON usage_metric
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON invoice
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON payment_method
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- UPDATE policies (allow if tenant_id matches current setting)
-- Note: No UPDATE policy on 'tenant' - managed via admin/API

CREATE POLICY tenant_isolation_update ON connection
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON mailbox
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON mailbox_mapping
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON group_def
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON scope_selection
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON collection_mapping
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON item
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON sync_checkpoint
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON run
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON run_event
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON decision
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON policy_preset
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON verification
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON cutover
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON backup_target
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON audit_log
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON cursor
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON tenant_member
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON usage_metric
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON invoice
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON payment_method
  FOR UPDATE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- DELETE policies (allow if tenant_id matches current setting)
-- Note: No DELETE policy on 'tenant' - cascade deletes from child tables

CREATE POLICY tenant_isolation_delete ON connection
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON mailbox
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON mailbox_mapping
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON group_def
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON scope_selection
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON collection_mapping
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON item
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON sync_checkpoint
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON run
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON run_event
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON decision
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON policy_preset
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON verification
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON cutover
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON backup_target
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON audit_log
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON cursor
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON tenant_member
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON usage_metric
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON invoice
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON payment_method
  FOR DELETE
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Note: Application MUST set current_tenant before each query:
-- SET app.current_tenant = 'uuid-here';
-- This is typically done in middleware after JWT authentication.
