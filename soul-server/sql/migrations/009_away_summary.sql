-- 009: away_summary 컬럼 추가
-- 세션 복귀 시 Claude Code CLI가 발행하는 요약 텍스트를 저장한다.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS away_summary TEXT;
