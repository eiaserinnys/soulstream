ALTER TABLE cards ADD COLUMN attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
