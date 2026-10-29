import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BACKFILL_SCRIPT = fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/event-search-postings-backfill.mjs",
  import.meta.url,
));

export async function readPostingShape(sql: FullSchemaPostgresHarness["sql"]): Promise<unknown> {
  const columns = await sql<Array<Record<string, unknown>>>`
    SELECT table_name, column_name, data_type, is_nullable, is_identity, identity_generation
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('event_search_session_keys', 'event_search_dictionary',
                         'event_search_event_types', 'event_search_documents',
                         'event_search_postings')
    ORDER BY table_name, ordinal_position
  `;
  const constraints = await sql<Array<Record<string, unknown>>>`
    SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
           pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
    WHERE con.connamespace = current_schema()::regnamespace
      AND c.relname IN ('event_search_session_keys', 'event_search_dictionary',
                        'event_search_event_types', 'event_search_documents',
                        'event_search_postings')
    ORDER BY c.relname, con.conname
  `;
  const indexes = await sql<Array<Record<string, unknown>>>`
    SELECT tablename, indexname, indexdef FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN ('event_search_session_keys', 'event_search_dictionary',
                        'event_search_event_types', 'event_search_documents',
                        'event_search_postings')
    ORDER BY tablename, indexname
  `;
  const triggers = await sql<Array<Record<string, unknown>>>`
    SELECT tgname, pg_get_triggerdef(oid) AS definition
    FROM pg_trigger
    WHERE tgrelid = 'event_search_terms'::regclass AND NOT tgisinternal
      AND tgname LIKE 'trg_event_search_postings_%'
    ORDER BY tgname
  `;
  const reloptions = await sql<Array<Record<string, unknown>>>`
    SELECT c.relname AS table_name, c.reloptions FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace
      AND c.relname IN ('event_search_postings', 'event_search_documents')
    ORDER BY c.relname
  `;
  const metadataTriggers = await sql<Array<Record<string, unknown>>>`
    SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger
    WHERE tgrelid = 'events'::regclass AND NOT tgisinternal
      AND tgname = 'trg_event_search_document_metadata'
    ORDER BY tgname
  `;
  return { columns, constraints, indexes, triggers, reloptions, metadataTriggers };
}

export async function readPostingDifferences(sql: FullSchemaPostgresHarness["sql"]) {
  const [row] = await sql<Array<{ missing: number; extra: number; changed: number }>>`
    WITH legacy AS (
      SELECT session_id, event_id, term, term_freq, doc_len FROM event_search_terms
    ), compact AS (
      SELECT keys.session_id, posting.event_id, dictionary.term, posting.term_freq,
             document.doc_len
      FROM event_search_postings posting
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_dictionary dictionary USING (term_id)
      LEFT JOIN event_search_documents document
        ON document.session_key = posting.session_key AND document.event_id = posting.event_id
    ), compared AS (
      SELECT legacy.term_freq AS legacy_tf, compact.term_freq AS compact_tf
      FROM legacy FULL JOIN compact USING (session_id, event_id, term)
    )
    SELECT COUNT(*) FILTER (WHERE legacy_tf IS NOT NULL AND compact_tf IS NULL)::int AS missing,
           COUNT(*) FILTER (WHERE legacy_tf IS NULL AND compact_tf IS NOT NULL)::int AS extra,
           COUNT(*) FILTER (WHERE legacy_tf IS DISTINCT FROM compact_tf
                             AND legacy_tf IS NOT NULL AND compact_tf IS NOT NULL)::int AS changed
    FROM compared
  `;
  return row;
}

export async function readDocumentDifferences(sql: FullSchemaPostgresHarness["sql"]) {
  const [row] = await sql<Array<{
    missing: number;
    extra: number;
    changed: number;
    orphanPostings: number;
  }>>`
    WITH expected AS (
      SELECT terms.session_id, terms.event_id, MAX(terms.doc_len)::int AS doc_len,
             events.event_type, events.created_at
      FROM event_search_terms terms
      JOIN events ON events.session_id = terms.session_id AND events.id = terms.event_id
      GROUP BY terms.session_id, terms.event_id, events.event_type, events.created_at
    ), actual AS (
      SELECT keys.session_id, documents.event_id, documents.doc_len,
             event_types.event_type, documents.created_at
      FROM event_search_documents documents
      JOIN event_search_session_keys keys USING (session_key)
      JOIN event_search_event_types event_types USING (event_type_id)
    ), compared AS (
      SELECT expected.session_id AS expected_session_id,
             actual.session_id AS actual_session_id,
             expected.doc_len AS expected_doc_len, actual.doc_len AS actual_doc_len,
             expected.event_type AS expected_event_type, actual.event_type AS actual_event_type,
             expected.created_at AS expected_created_at, actual.created_at AS actual_created_at
      FROM expected FULL JOIN actual USING (session_id, event_id)
    )
    SELECT COUNT(*) FILTER (WHERE expected_session_id IS NOT NULL AND actual_session_id IS NULL)::int
             AS missing,
           COUNT(*) FILTER (WHERE expected_session_id IS NULL AND actual_session_id IS NOT NULL)::int
             AS extra,
           COUNT(*) FILTER (
             WHERE expected_session_id IS NOT NULL AND actual_session_id IS NOT NULL
               AND (expected_doc_len, expected_event_type, expected_created_at)
                   IS DISTINCT FROM (actual_doc_len, actual_event_type, actual_created_at)
           )::int AS changed,
           (SELECT COUNT(*)::int
            FROM event_search_postings postings
            LEFT JOIN event_search_documents documents
              ON documents.session_key = postings.session_key
             AND documents.event_id = postings.event_id
            WHERE documents.session_key IS NULL) AS "orphanPostings"
    FROM compared
  `;
  return row;
}

export async function readSearchStatistics(sql: FullSchemaPostgresHarness["sql"]) {
  const [row] = await sql<Array<{
    dfMismatch: number;
    corpusDocs: number;
    expectedDocs: number;
    corpusDocLength: number;
    expectedDocLength: number;
  }>>`
    WITH expected_df AS (
      SELECT term, COUNT(*)::bigint AS document_count
      FROM event_search_terms GROUP BY term
    ), df_diff AS (
      SELECT COALESCE(expected_df.term, actual.term) AS term
      FROM expected_df FULL JOIN event_search_term_document_frequency actual USING (term)
      WHERE COALESCE(expected_df.document_count, 0)
        IS DISTINCT FROM COALESCE(actual.document_count, 0)
    ), expected_corpus AS (
      SELECT COUNT(*)::int AS docs, COALESCE(SUM(doc_len), 0)::int AS doc_len
      FROM (SELECT DISTINCT session_id, event_id, doc_len FROM event_search_terms) docs
    )
    SELECT (SELECT COUNT(*)::int FROM df_diff) AS "dfMismatch",
           stats.total_docs::int AS "corpusDocs",
           expected.docs AS "expectedDocs",
           stats.total_doc_len::int AS "corpusDocLength",
           expected.doc_len AS "expectedDocLength"
    FROM event_search_corpus_stats stats CROSS JOIN expected_corpus expected
    WHERE stats.id = TRUE
  `;
  return row;
}

export function runBackfill(
  command: string,
  checkpoint: string,
  databaseUrl: string,
  ...args: string[]
) {
  return spawnSync(process.execPath, [
    BACKFILL_SCRIPT, command, "--checkpoint", checkpoint, ...args,
  ], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      MIGRATION_DATABASE_URL: "",
      HANIEL_SERVICE_CWD: join(dirname(checkpoint), "empty-service-config"),
    },
    timeout: 30_000,
  });
}
