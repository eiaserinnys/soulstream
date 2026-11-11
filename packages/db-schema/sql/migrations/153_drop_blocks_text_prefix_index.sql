-- 본문 접두 검색 인덱스는 사용자가 없다. 긴 본문이 btree 한도를 넘으면
-- 블록 projection 저장 전체가 실패하므로 제거한다 (카드 #1234).
DROP INDEX IF EXISTS idx_blocks_text_prefix;
