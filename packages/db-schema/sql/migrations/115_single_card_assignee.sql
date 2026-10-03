BEGIN;

-- Only the first application initializes existing cards' status clocks.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'cards'
          AND column_name = 'status_changed_at'
    ) THEN
        ALTER TABLE cards ADD COLUMN status_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        UPDATE cards SET status_changed_at = updated_at;
    END IF;
END $$;

WITH user_overrides(session_id, kept_card_id) AS (
    VALUES ('41ecc1b4-7476-4866-a220-ab582a8244c5', 'dcf30b19-f05b-4054-88fa-cc99f05bd03d')
), ranked AS (
    SELECT c.*,
        ROW_NUMBER() OVER ownership AS rank,
        FIRST_VALUE(c.id) OVER ownership AS kept_card_id,
        FIRST_VALUE(o.kept_card_id IS NOT NULL) OVER ownership AS user_override
    FROM cards c
    LEFT JOIN user_overrides o ON o.session_id = c.assignee_session_id AND o.kept_card_id = c.id
    WHERE c.assignee_session_id IS NOT NULL AND NOT c.archived
    WINDOW ownership AS (
        PARTITION BY c.assignee_session_id
        ORDER BY (o.kept_card_id IS NOT NULL) DESC, c.created_at DESC, c.id COLLATE "C" DESC
    )
), audited AS (
    INSERT INTO folder_operations (
        id, folder_id, target_kind, target_id, operation_type, actor_kind, idempotency_key, payload_json, reason
    )
    SELECT md5('migration-115:release:' || id)::uuid::text, folder_id, 'card', id,
        'release_card_assignee', 'system', 'migration-115:release:' || id,
        jsonb_build_object(
            'previous_assignee_kind', assignee_kind,
            'previous_assignee_session_id', assignee_session_id,
            'kept_card_id', kept_card_id,
            'rule', CASE WHEN user_override THEN 'user_override_keep_card' ELSE 'latest_created_card' END
        ),
        CASE WHEN user_override THEN '사용자가 지정한 카드만 담당으로 남깁니다.'
             ELSE '마지막 생성 카드만 담당으로 남깁니다.' END
    FROM ranked WHERE rank > 1
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
    RETURNING target_id
)
UPDATE cards c SET assignee_kind = NULL, assignee_session_id = NULL, version = c.version + 1
FROM audited a WHERE c.id = a.target_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cards_assignee_session ON cards(assignee_session_id)
    WHERE assignee_session_id IS NOT NULL AND NOT archived;

COMMIT;
