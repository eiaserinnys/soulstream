export async function insertMissingMappings(tx, sessionIds, eventIds) {
  await tx`
    INSERT INTO event_search_session_keys (session_id)
    SELECT candidates.session_id
    FROM (
      SELECT DISTINCT legacy.session_id
      FROM event_search_terms legacy
      JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
        AS selected(session_id, event_id)
        ON selected.session_id = legacy.session_id
       AND selected.event_id = legacy.event_id
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM event_search_session_keys existing
      WHERE existing.session_id = candidates.session_id
    )
    ORDER BY candidates.session_id COLLATE "C"
    ON CONFLICT (session_id) DO NOTHING
  `;
  await tx`
    INSERT INTO event_search_dictionary (term)
    SELECT candidates.term
    FROM (
      SELECT DISTINCT legacy.term
      FROM event_search_terms legacy
      JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
        AS selected(session_id, event_id)
        ON selected.session_id = legacy.session_id
       AND selected.event_id = legacy.event_id
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM event_search_dictionary existing
      WHERE existing.term = candidates.term
    )
    ORDER BY candidates.term COLLATE "C"
    ON CONFLICT (term) DO NOTHING
  `;
  await tx`
    INSERT INTO event_search_event_types (event_type)
    SELECT candidates.event_type
    FROM (
      SELECT DISTINCT ev.event_type
      FROM event_search_terms legacy
      JOIN unnest(${sessionIds}::text[], ${eventIds}::int[])
        AS selected(session_id, event_id)
        ON selected.session_id = legacy.session_id
       AND selected.event_id = legacy.event_id
      JOIN events ev
        ON ev.session_id = legacy.session_id
       AND ev.id = legacy.event_id
    ) candidates
    WHERE NOT EXISTS (
      SELECT 1 FROM event_search_event_types existing
      WHERE existing.event_type = candidates.event_type
    )
    ORDER BY candidates.event_type COLLATE "C"
    ON CONFLICT (event_type) DO NOTHING
  `;
}

export async function countDifferences(tx, sessionIds, eventIds) {
  const [row] = await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    ), legacy_postings AS (
      SELECT terms.session_id, terms.event_id, terms.term, terms.term_freq, terms.doc_len
      FROM event_search_terms terms JOIN selected USING (session_id, event_id)
    ), compact_postings AS (
      SELECT keys.session_id, posting.event_id, dictionary.term, posting.term_freq,
             document.doc_len, document.session_key IS NOT NULL AS has_document
      FROM event_search_postings posting
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_dictionary dictionary USING (term_id)
      LEFT JOIN event_search_documents document
        ON document.session_key = posting.session_key
       AND document.event_id = posting.event_id
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = posting.event_id
    ), posting_compared AS (
      SELECT legacy.session_id AS legacy_session_id,
             compact.session_id AS compact_session_id,
             legacy.term_freq AS legacy_tf, compact.term_freq AS compact_tf,
             legacy.doc_len AS legacy_doc_len, compact.doc_len AS compact_doc_len,
             compact.has_document
      FROM legacy_postings legacy
      FULL JOIN compact_postings compact USING (session_id, event_id, term)
    ), expected_documents AS (
      SELECT selected.session_id, selected.event_id,
             MAX(terms.doc_len)::int AS doc_len,
             ev.event_type, ev.created_at
      FROM selected
      JOIN event_search_terms terms USING (session_id, event_id)
      JOIN events ev ON ev.session_id = selected.session_id AND ev.id = selected.event_id
      GROUP BY selected.session_id, selected.event_id, ev.event_type, ev.created_at
    ), actual_documents AS (
      SELECT keys.session_id, document.event_id, document.doc_len,
             event_type.event_type, document.created_at
      FROM event_search_documents document
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_event_types event_type USING (event_type_id)
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = document.event_id
    ), document_compared AS (
      SELECT expected.session_id AS expected_session_id,
             actual.session_id AS actual_session_id,
             expected.doc_len AS expected_doc_len, actual.doc_len AS actual_doc_len,
             expected.event_type AS expected_event_type, actual.event_type AS actual_event_type,
             expected.created_at AS expected_created_at, actual.created_at AS actual_created_at
      FROM expected_documents expected
      FULL JOIN actual_documents actual USING (session_id, event_id)
    )
    SELECT (SELECT COUNT(*)::int FROM posting_compared) AS "comparedPostings",
           (SELECT COUNT(*)::int FROM document_compared) AS "comparedDocuments",
           (SELECT COUNT(*)::int FROM posting_compared
            WHERE legacy_session_id IS NOT NULL AND compact_session_id IS NULL) AS missing,
           (SELECT COUNT(*)::int FROM posting_compared
            WHERE legacy_session_id IS NULL AND compact_session_id IS NOT NULL) AS extra,
           (SELECT COUNT(*)::int FROM posting_compared
            WHERE legacy_session_id IS NOT NULL AND compact_session_id IS NOT NULL
              AND (legacy_tf IS DISTINCT FROM compact_tf
                   OR (has_document AND legacy_doc_len IS DISTINCT FROM compact_doc_len))) AS changed,
           (SELECT COUNT(*)::int FROM document_compared
            WHERE expected_session_id IS NOT NULL AND actual_session_id IS NULL)
              AS "missingDocuments",
           (SELECT COUNT(*)::int FROM document_compared
            WHERE expected_session_id IS NULL AND actual_session_id IS NOT NULL)
              AS "extraDocuments",
           (SELECT COUNT(*)::int FROM document_compared
            WHERE expected_session_id IS NOT NULL AND actual_session_id IS NOT NULL
              AND (expected_doc_len, expected_event_type, expected_created_at)
                  IS DISTINCT FROM (actual_doc_len, actual_event_type, actual_created_at))
              AS "changedDocuments",
           (SELECT COUNT(*)::int
            FROM event_search_postings posting
            JOIN event_search_session_keys keys USING (session_key)
            JOIN selected ON selected.session_id = keys.session_id
                         AND selected.event_id = posting.event_id
            LEFT JOIN event_search_documents document
              ON document.session_key = posting.session_key
             AND document.event_id = posting.event_id
            WHERE document.session_key IS NULL) AS "orphanPostings"
  `;
  return row;
}

export async function readDifferenceSamples(tx, sessionIds, eventIds, limit) {
  return await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    ), legacy AS (
      SELECT terms.session_id, terms.event_id, terms.term, terms.term_freq, terms.doc_len
      FROM event_search_terms terms JOIN selected USING (session_id, event_id)
    ), compact AS (
      SELECT keys.session_id, posting.event_id, dictionary.term, posting.term_freq,
             document.doc_len, document.session_key IS NOT NULL AS has_document
      FROM event_search_postings posting
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_dictionary dictionary USING (term_id)
      LEFT JOIN event_search_documents document
        ON document.session_key = posting.session_key
       AND document.event_id = posting.event_id
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = posting.event_id
    ), compared AS (
      SELECT COALESCE(legacy.session_id, compact.session_id) AS session_id,
             COALESCE(legacy.event_id, compact.event_id) AS event_id,
             COALESCE(legacy.term, compact.term) AS term,
             legacy.term_freq AS legacy_tf, legacy.doc_len AS legacy_doc_len,
             compact.term_freq AS compact_tf, compact.doc_len AS compact_doc_len,
             compact.has_document
      FROM legacy FULL JOIN compact USING (session_id, event_id, term)
    )
    SELECT CASE
             WHEN legacy_tf IS NULL THEN 'extra'
             WHEN compact_tf IS NULL THEN 'missing'
             ELSE 'changed'
           END AS kind,
           session_id AS "sessionId", event_id AS "eventId", term,
           legacy_tf AS "legacyTermFreq", legacy_doc_len AS "legacyDocLen",
           compact_tf AS "compactTermFreq", compact_doc_len AS "compactDocLen"
    FROM compared
    WHERE legacy_tf IS NULL OR compact_tf IS NULL
       OR legacy_tf IS DISTINCT FROM compact_tf
       OR (has_document AND legacy_doc_len IS DISTINCT FROM compact_doc_len)
    ORDER BY session_id, event_id, term
    LIMIT ${limit}
  `;
}

export async function readDocumentDifferenceSamples(tx, sessionIds, eventIds, limit) {
  const documents = await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    ), expected AS (
      SELECT selected.session_id, selected.event_id, MAX(terms.doc_len)::int AS doc_len,
             ev.event_type, ev.created_at
      FROM selected
      JOIN event_search_terms terms USING (session_id, event_id)
      JOIN events ev ON ev.session_id = selected.session_id AND ev.id = selected.event_id
      GROUP BY selected.session_id, selected.event_id, ev.event_type, ev.created_at
    ), actual AS (
      SELECT keys.session_id, document.event_id, document.doc_len,
             event_type.event_type, document.created_at
      FROM event_search_documents document
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_event_types event_type USING (event_type_id)
      JOIN selected ON selected.session_id = keys.session_id
                   AND selected.event_id = document.event_id
    ), compared AS (
      SELECT expected.session_id AS expected_session_id,
             actual.session_id AS actual_session_id,
             COALESCE(expected.session_id, actual.session_id) AS session_id,
             COALESCE(expected.event_id, actual.event_id) AS event_id,
             expected.doc_len AS expected_doc_len, actual.doc_len AS actual_doc_len,
             expected.event_type AS expected_event_type, actual.event_type AS actual_event_type,
             expected.created_at AS expected_created_at, actual.created_at AS actual_created_at
      FROM expected FULL JOIN actual USING (session_id, event_id)
    )
    SELECT CASE
             WHEN expected_session_id IS NULL THEN 'extra_document'
             WHEN actual_session_id IS NULL THEN 'missing_document'
             ELSE 'changed_document'
           END AS kind,
           session_id AS "sessionId", event_id AS "eventId",
           expected_doc_len AS "expectedDocLen", actual_doc_len AS "actualDocLen",
           expected_event_type AS "expectedEventType", actual_event_type AS "actualEventType",
           expected_created_at AS "expectedCreatedAt", actual_created_at AS "actualCreatedAt"
    FROM compared
    WHERE expected_session_id IS NULL OR actual_session_id IS NULL
       OR (expected_doc_len, expected_event_type, expected_created_at)
          IS DISTINCT FROM (actual_doc_len, actual_event_type, actual_created_at)
    ORDER BY session_id, event_id
    LIMIT ${limit}
  `;
  if (documents.length >= limit) return documents;
  const orphans = await tx`
    WITH selected AS (
      SELECT session_id, event_id
      FROM unnest(${sessionIds}::text[], ${eventIds}::int[]) AS item(session_id, event_id)
    )
    SELECT 'posting_without_document' AS kind,
           keys.session_id AS "sessionId", posting.event_id AS "eventId",
           dictionary.term
    FROM event_search_postings posting
    JOIN event_search_session_keys keys USING (session_key)
    JOIN event_search_dictionary dictionary USING (term_id)
    JOIN selected ON selected.session_id = keys.session_id
                 AND selected.event_id = posting.event_id
    LEFT JOIN event_search_documents document
      ON document.session_key = posting.session_key
     AND document.event_id = posting.event_id
    WHERE document.session_key IS NULL
    ORDER BY keys.session_id, posting.event_id, dictionary.term
    LIMIT ${limit - documents.length}
  `;
  return [...documents, ...orphans];
}
