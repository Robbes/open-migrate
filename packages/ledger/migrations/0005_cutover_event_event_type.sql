-- Add eventType column to cutover_event table
-- Allows distinguishing initialization events from state transitions

ALTER TABLE cutover_event ADD COLUMN IF NOT EXISTS event_type text NOT NULL DEFAULT 'STATE_TRANSITION'
  CHECK (event_type IN ('CUTOVER_INITIALIZED', 'STATE_TRANSITION'));

-- Backfill existing events as STATE_TRANSITION
UPDATE cutover_event SET event_type = 'STATE_TRANSITION' WHERE event_type IS NULL;
