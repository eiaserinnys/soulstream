-- Add optimistic-concurrency version token to markdown documents.
ALTER TABLE markdown_documents
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
