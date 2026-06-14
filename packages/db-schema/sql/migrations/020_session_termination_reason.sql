-- 020: Supervisor termination reason 컬럼 추가

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_reason TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS termination_detail TEXT;
