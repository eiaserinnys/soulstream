ALTER TABLE card_questions
  ADD COLUMN title TEXT,
  ADD COLUMN kind TEXT CHECK (kind IN ('choice','request')),
  ADD COLUMN attachments JSONB CHECK (
    attachments IS NULL OR jsonb_typeof(attachments) = 'array'),
  ADD COLUMN selected_option TEXT,
  ADD COLUMN revision INTEGER CHECK (revision >= 1),
  ADD COLUMN revised_at TIMESTAMPTZ;
ALTER TABLE card_comments
  ADD COLUMN question_id TEXT REFERENCES card_questions(id) ON DELETE SET NULL;
CREATE INDEX idx_card_comments_question
  ON card_comments(question_id,created_at,id)
  WHERE question_id IS NOT NULL;
