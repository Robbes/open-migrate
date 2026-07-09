-- Workplan 0007 T1: Ledger item-type support (schema v3)
-- Adds explicit item_type discriminator to the item table
-- Reference: Workplan 0007, ADR-0020 (idempotency)

-- Add item_type column with default 'mail' for backward compatibility
ALTER TABLE item 
ADD COLUMN item_type TEXT NOT NULL DEFAULT 'mail' 
CHECK (item_type IN ('mail', 'calendar', 'contact', 'file'));

-- Update the unique constraint to include item_type
-- Drop existing unique constraint
ALTER TABLE item DROP CONSTRAINT item_tenant_id_mapping_id_natural_key_hash_key;

-- Add new unique constraint including item_type
ALTER TABLE item 
ADD CONSTRAINT item_tenant_mapping_type_natural_key_unique 
UNIQUE (tenant_id, mapping_id, item_type, natural_key_hash);

-- Update existing items to have item_type = 'mail' (default already set, but explicit for clarity)
UPDATE item SET item_type = 'mail' WHERE item_type IS NULL;

-- Create index for item_type queries
CREATE INDEX IF NOT EXISTS ix_item_type ON item(tenant_id, mapping_id, item_type);
