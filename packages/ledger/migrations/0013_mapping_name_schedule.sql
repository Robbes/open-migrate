-- Migration 0013: give mailbox_mapping a display name and schedule.
--
-- The managed API's create-mapping flow (workplan 0011) persists a user-named
-- mapping with an optional cron schedule. The normalized mailbox_mapping row had
-- neither column (the list endpoint faked the name from `mode`), and per-domain
-- scope already lives in scope_selection. Add the two missing columns.
--
-- Idempotent: guarded with IF NOT EXISTS.

ALTER TABLE mailbox_mapping
  ADD COLUMN IF NOT EXISTS name text;

ALTER TABLE mailbox_mapping
  ADD COLUMN IF NOT EXISTS schedule text;
