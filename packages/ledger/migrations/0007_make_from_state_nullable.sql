-- Make from_state nullable to support initialization events with null fromState
ALTER TABLE cutover_event ALTER COLUMN from_state DROP NOT NULL;
