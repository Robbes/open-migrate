-- Add encrypted_credentials column to connection table
-- This enables storing encrypted credentials directly in the database
-- Also add 'jmap' to the allowed connection kinds

ALTER TABLE connection 
ADD COLUMN IF NOT EXISTS encrypted_credentials jsonb;

-- Add jmap to the allowed kinds
ALTER TABLE connection 
DROP CONSTRAINT IF EXISTS connection_kind_check;

ALTER TABLE connection 
ADD CONSTRAINT connection_kind_check CHECK (
  kind IN ('o365','soverin','nextcloud','proton','imap','caldav','carddav','webdav','selfhosted_mail','jmap')
);
