-- Add document_ids array to agents table for exclusive knowledge base
ALTER TABLE agents ADD COLUMN IF NOT EXISTS document_ids uuid[] DEFAULT ARRAY[]::uuid[];

-- Create index for better query performance
CREATE INDEX IF NOT EXISTS idx_agents_document_ids ON agents USING GIN(document_ids);