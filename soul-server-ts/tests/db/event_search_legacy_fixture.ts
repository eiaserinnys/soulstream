import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";

export const eventSearchMigration = (name: string) => readFileSync(fileURLToPath(new URL(
  `../../../packages/db-schema/sql/migrations/${name}.sql`, import.meta.url,
)), "utf8");

// Build the 135 legacy writer from its historical migrations in an empty test schema.
export async function installLegacyEventSearch(harness: FullSchemaPostgresHarness) {
  const sql = harness.sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS event_search_terms (
    session_id TEXT NOT NULL, event_id INTEGER NOT NULL, term TEXT NOT NULL,
    term_freq INTEGER NOT NULL, doc_len INTEGER NOT NULL,
    PRIMARY KEY (session_id, event_id, term),
    FOREIGN KEY (session_id, event_id) REFERENCES events(session_id, id) ON DELETE CASCADE
  )`);
  await sql.begin(async (tx) => {
    await tx.unsafe(eventSearchMigration("099_event_search_term_document_frequency"));
    await tx.unsafe(eventSearchMigration("133_event_search_documents"));
    await tx.unsafe(eventSearchMigration("134_event_search_read_v2"));
    await tx.unsafe(eventSearchMigration("135_event_search_token_length_limit"));
    await tx.unsafe(`CREATE OR REPLACE FUNCTION decrement_event_search_corpus_stats() RETURNS TRIGGER AS $$
      DECLARE v_old_doc_len INTEGER; BEGIN
        SELECT MAX(doc_len) INTO v_old_doc_len FROM event_search_terms
        WHERE session_id = OLD.session_id AND event_id = OLD.id;
        IF v_old_doc_len IS NOT NULL THEN
          PERFORM event_search_adjust_corpus_stats(-1, -v_old_doc_len);
        END IF;
        RETURN OLD;
      END; $$ LANGUAGE plpgsql`);
    // The fresh schema carries the deferred constraint triggers of migration 160. The 135
    // writer needs the immediate triggers: its BEFORE DELETE decrement must read
    // event_search_terms before the ON DELETE CASCADE removes those rows.
    await tx.unsafe(`
      DROP TRIGGER IF EXISTS trg_event_search_terms ON events;
      CREATE TRIGGER trg_event_search_terms
        AFTER INSERT OR UPDATE OF searchable_text ON events
        FOR EACH ROW EXECUTE FUNCTION refresh_event_search_terms();
      DROP TRIGGER IF EXISTS trg_event_search_corpus_stats_delete ON events;
      CREATE TRIGGER trg_event_search_corpus_stats_delete
        BEFORE DELETE ON events
        FOR EACH ROW EXECUTE FUNCTION decrement_event_search_corpus_stats();
    `);
  });
}
