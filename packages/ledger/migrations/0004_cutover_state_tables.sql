-- Cutover state machine tables for persistent state management
-- Adds cutover_state and cutover_event tables for full lifecycle tracking

CREATE TABLE IF NOT EXISTS cutover_state (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id            uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  state                 text NOT NULL DEFAULT 'PREPARING'
                          CHECK (state IN ('PREPARING', 'READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS', 'GRACE_PERIOD', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  phase                 text NOT NULL DEFAULT 'verification'
                          CHECK (phase IN ('verification', 'approval', 'cutover', 'grace', 'completion', 'rollback')),
  verification_status   text NOT NULL DEFAULT 'pending'
                          CHECK (verification_status IN ('pending', 'pass', 'fail', 'warn', 'skipped')),
  verification_report   jsonb NOT NULL DEFAULT '{}',
  grace_period_hours    integer NOT NULL DEFAULT 72,
  grace_period_started_at timestamptz,
  grace_period_completed_at timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mapping_id)
);
CREATE INDEX IF NOT EXISTS ix_cutover_state_tenant ON cutover_state(tenant_id);
CREATE INDEX IF NOT EXISTS ix_cutover_state_mapping ON cutover_state(mapping_id);

CREATE TABLE IF NOT EXISTS cutover_event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  mapping_id      uuid NOT NULL REFERENCES mailbox_mapping(id) ON DELETE CASCADE,
  timestamp       timestamptz NOT NULL DEFAULT now(),
  from_state      text NOT NULL CHECK (from_state IN ('PREPARING', 'READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS', 'GRACE_PERIOD', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  to_state        text NOT NULL CHECK (to_state IN ('PREPARING', 'READY_FOR_CUTOVER', 'CUTOVER_IN_PROGRESS', 'GRACE_PERIOD', 'COMPLETED', 'FAILED', 'ROLLED_BACK')),
  triggered_by    text NOT NULL,
  reason          text,
  metadata        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_cutover_event_mapping ON cutover_event(mapping_id, timestamp);
CREATE INDEX IF NOT EXISTS ix_cutover_event_tenant ON cutover_event(tenant_id, timestamp);
