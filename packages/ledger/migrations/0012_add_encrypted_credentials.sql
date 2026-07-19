-- Add encrypted_credentials column to connection table.
-- (The 'jmap' connection kind is now in 0001_init.sql directly, so no constraint swap is needed here.)
ALTER TABLE connection
ADD COLUMN IF NOT EXISTS encrypted_credentials jsonb;
