-- 검증 대기(awaiting_verification) 상태와 재확인 시각/기다리는 것.
-- 이 상태에서만 두 열이 필수이며 다른 상태에서는 둘 다 NULL이어야 한다.
ALTER TABLE cards ADD COLUMN wake_at timestamptz NULL;
ALTER TABLE cards ADD COLUMN waiting_for text NULL;
ALTER TABLE cards DROP CONSTRAINT cards_status_check;
ALTER TABLE cards ADD CONSTRAINT cards_status_check CHECK (
  status IN ('todo','queued','blocked','running','awaiting_verification',
             'review','on_hold','done','cancelled')
);
ALTER TABLE cards ADD CONSTRAINT cards_verification_wait_check CHECK (
  (status = 'awaiting_verification'
    AND wake_at IS NOT NULL AND waiting_for IS NOT NULL
    AND char_length(btrim(waiting_for)) BETWEEN 1 AND 36)
  OR
  (status <> 'awaiting_verification'
    AND wake_at IS NULL AND waiting_for IS NULL)
);
