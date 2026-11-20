export const LINKED_CARD_LATERAL_SQL = `    LEFT JOIN LATERAL (
      SELECT card.id, card.number, card.title, card.status
      FROM cards card
      WHERE card.id = session.card_id
        OR (card.assignee_session_id = session.session_id AND card.archived = FALSE)
        OR (card.completed_session_id = session.session_id AND card.archived = FALSE)
      ORDER BY
        CASE
          WHEN card.id = session.card_id THEN 0
          WHEN card.assignee_session_id = session.session_id THEN 1
          ELSE 2
        END,
        card.updated_at DESC,
        card.id ASC
      LIMIT 1
    ) linked_card ON TRUE
`;

export const SESSION_LINK_JOINS_SQL = `    LEFT JOIN LATERAL (
      SELECT
        linked_folder.id,
        linked_folder.name,
        CASE
          WHEN linked_folder.completed_session_id = session.session_id THEN 'folder_completed'
          WHEN completed_item.id IS NOT NULL THEN 'card_completed'
          WHEN source_item.id IS NOT NULL THEN 'source_card'
          WHEN assigned_item.id IS NOT NULL THEN 'card_assigned'
          ELSE NULL
        END AS folder_evidence_kind,
        CASE
          WHEN linked_folder.completed_session_id = session.session_id THEN linked_folder.name
          WHEN completed_item.id IS NOT NULL THEN completed_item.title
          WHEN source_item.id IS NOT NULL THEN source_item.title
          WHEN assigned_item.id IS NOT NULL THEN assigned_item.title
          ELSE NULL
        END AS folder_evidence_title
      FROM board_items primary_session_item
      JOIN folders linked_folder ON linked_folder.id = primary_session_item.folder_id
      LEFT JOIN cards source_item
        ON source_item.id = session.card_id AND source_item.folder_id = linked_folder.id
      LEFT JOIN LATERAL (
        SELECT card.id, card.title
        FROM cards card
        WHERE card.folder_id = linked_folder.id
          AND card.archived = FALSE
          AND card.completed_session_id = session.session_id
        ORDER BY card.completed_at DESC NULLS LAST, card.id
        LIMIT 1
      ) completed_item ON TRUE
      LEFT JOIN LATERAL (
        SELECT card.id, card.title
        FROM cards card
        WHERE card.folder_id = linked_folder.id
          AND card.archived = FALSE
          AND card.assignee_session_id = session.session_id
        ORDER BY card.updated_at DESC, card.id
        LIMIT 1
      ) assigned_item ON TRUE
      WHERE primary_session_item.folder_id = linked_folder.id
        AND primary_session_item.folder_id = session.folder_id
        AND primary_session_item.item_type = 'session'
        AND primary_session_item.item_id = session.session_id
        AND primary_session_item.membership_kind = 'primary'
        AND linked_folder.archived = FALSE
        AND session.folder_id IS NOT NULL
      ORDER BY
        ((linked_folder.completed_session_id = session.session_id) IS TRUE) DESC,
        (completed_item.id IS NOT NULL) DESC,
        (source_item.id IS NOT NULL) DESC,
        (assigned_item.id IS NOT NULL) DESC,
        linked_folder.id ASC
      LIMIT 1
    ) folder_evidence ON TRUE
${LINKED_CARD_LATERAL_SQL}`;
