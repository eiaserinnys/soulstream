import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MIGRATION_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/132_event_search_integer_postings.sql",
  import.meta.url,
));
const BACKFILL_SCRIPT = fileURLToPath(new URL(
  "../../../packages/db-schema/scripts/event-search-postings-backfill.mjs",
  import.meta.url,
));
const describePostgres = hasFullSchemaPostgresBackend ? describe.sequential : describe.skip;

describePostgres("integer event-search postings migration and backfill", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("replays the migration and mirrors event refresh, event delete, and session cascade", async () => {
    const freshShape = await readPostingShape(harness.sql);
    const migration = readFileSync(MIGRATION_PATH, "utf8");

    await harness.sql.unsafe(`
      DROP TRIGGER IF EXISTS trg_event_search_postings_insert ON event_search_terms;
      DROP TRIGGER IF EXISTS trg_event_search_postings_update ON event_search_terms;
      DROP TRIGGER IF EXISTS trg_event_search_postings_delete ON event_search_terms;
      DROP FUNCTION IF EXISTS mirror_event_search_postings();
      DROP TABLE IF EXISTS event_search_postings;
      DROP TABLE IF EXISTS event_search_dictionary;
      DROP TABLE IF EXISTS event_search_session_keys;
    `);
    await harness.sql.unsafe(migration);
    await harness.sql.unsafe(migration);
    expect(await readPostingShape(harness.sql)).toEqual(freshShape);

    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status)
      VALUES ('postings-mirror-a', 'codex', 'running'),
             ('postings-mirror-b', 'codex', 'running')
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, searchable_text)
      VALUES ('postings-mirror-a', 1, 'user_message', '{}', 'alpha alpha beta'),
             ('postings-mirror-a', 2, 'user_message', '{}', 'beta gamma'),
             ('postings-mirror-b', 1, 'user_message', '{}', 'gamma delta')
    `;
    await harness.sql`
      UPDATE events SET searchable_text = 'beta delta delta'
      WHERE session_id = 'postings-mirror-a' AND id = 1
    `;
    await harness.sql`
      DELETE FROM events WHERE session_id = 'postings-mirror-a' AND id = 2
    `;
    await harness.sql`DELETE FROM sessions WHERE session_id = 'postings-mirror-b'`;

    expect(await readPostingDifferences(harness.sql)).toEqual({
      missing: 0,
      extra: 0,
      changed: 0,
    });
    expect(await readSearchStatistics(harness.sql)).toEqual({
      dfMismatch: 0,
      corpusDocs: 1,
      expectedDocs: 1,
      corpusDocLength: 3,
      expectedDocLength: 3,
    });
    const retainedKeys = await harness.sql<Array<{ session_id: string }>>`
      SELECT session_id FROM event_search_session_keys ORDER BY session_id
    `;
    expect(retainedKeys).toEqual([
      { session_id: "postings-mirror-a" },
      { session_id: "postings-mirror-b" },
    ]);
  });

  it("backfills legacy rows and resumes after changes on both sides of its checkpoint", async () => {
    const checkpointDirectory = mkdtempSync(join(tmpdir(), "event-search-postings-"));
    const backfillCheckpoint = join(checkpointDirectory, "backfill.json");
    const verifyCheckpoint = join(checkpointDirectory, "verify.json");
    try {
      await harness.sql`
        INSERT INTO sessions (session_id, session_type, status)
        VALUES ('postings-backfill', 'codex', 'running')
      `;
      await harness.sql.unsafe(`
        DROP TRIGGER trg_event_search_postings_insert ON event_search_terms;
        DROP TRIGGER trg_event_search_postings_update ON event_search_terms;
        DROP TRIGGER trg_event_search_postings_delete ON event_search_terms;
      `);
      await harness.sql`
        INSERT INTO events (session_id, id, event_type, payload, searchable_text)
        VALUES ('postings-backfill', 1, 'user_message', '{}', 'old alpha'),
               ('postings-backfill', 2, 'user_message', '{}', 'old beta'),
               ('postings-backfill', 3, 'user_message', '{}', 'old gamma'),
               ('postings-backfill', 4, 'user_message', '{}', 'old delta')
      `;
      await harness.sql.unsafe(readFileSync(MIGRATION_PATH, "utf8"));

      const firstRun = runBackfill(
        "backfill", backfillCheckpoint, harness.databaseUrl,
        "--batch-events", "2", "--max-seconds", "0",
      );
      expect(firstRun.status, firstRun.stderr || firstRun.stdout).toBe(0);
      expect(firstRun.stdout).toContain("processedEvents");
      expectNoDatabaseUrl(firstRun, harness.databaseUrl);
      const saved = JSON.parse(readFileSync(backfillCheckpoint, "utf8")) as {
        lastSessionId: string;
        lastEventId: number;
      };
      expect(saved).toMatchObject({
        version: 1,
        command: "backfill",
        lastSessionId: "postings-backfill",
        lastEventId: 2,
      });

      await harness.sql`
        UPDATE events SET searchable_text = 'changed alpha'
        WHERE session_id = 'postings-backfill' AND id = 1
      `;
      await harness.sql`
        DELETE FROM events WHERE session_id = 'postings-backfill' AND id = 2
      `;
      await harness.sql`
        UPDATE events SET searchable_text = 'changed gamma gamma'
        WHERE session_id = 'postings-backfill' AND id = 3
      `;
      await harness.sql`
        DELETE FROM events WHERE session_id = 'postings-backfill' AND id = 4
      `;

      const resumed = runBackfill("backfill", backfillCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(resumed.status, resumed.stderr || resumed.stdout).toBe(0);
      expectNoDatabaseUrl(resumed, harness.databaseUrl);
      const verified = runBackfill("verify", verifyCheckpoint, harness.databaseUrl,
        "--batch-events", "1");
      expect(verified.status, verified.stderr || verified.stdout).toBe(0);
      expect(verified.stdout).toContain('"missing":0');
      expect(verified.stdout).toContain('"extra":0');
      expect(verified.stdout).toContain('"changed":0');
      expectNoDatabaseUrl(verified, harness.databaseUrl);

      const status = runBackfill("status", backfillCheckpoint, harness.databaseUrl);
      expect(status.status, status.stderr || status.stdout).toBe(0);
      expect(status.stdout).toContain("event_search_terms");
      expect(status.stdout).toContain("event_search_postings");
      expectNoDatabaseUrl(status, harness.databaseUrl);
    } finally {
      rmSync(checkpointDirectory, { recursive: true, force: true });
    }
  }, 60_000);
});

async function readPostingShape(sql: FullSchemaPostgresHarness["sql"]): Promise<unknown> {
  const columns = await sql<Array<Record<string, unknown>>>
    `SELECT table_name, column_name, data_type, is_nullable, is_identity, identity_generation
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name IN ('event_search_session_keys', 'event_search_dictionary', 'event_search_postings')
     ORDER BY table_name, ordinal_position`;
  const constraints = await sql<Array<Record<string, unknown>>>
    `SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
            pg_get_constraintdef(con.oid) AS definition
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
     WHERE con.connamespace = current_schema()::regnamespace
       AND c.relname IN ('event_search_session_keys', 'event_search_dictionary', 'event_search_postings')
     ORDER BY c.relname, con.conname`;
  const indexes = await sql<Array<Record<string, unknown>>>
    `SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename IN ('event_search_session_keys', 'event_search_dictionary', 'event_search_postings')
     ORDER BY tablename, indexname`;
  const triggers = await sql<Array<Record<string, unknown>>>
    `SELECT tgname, pg_get_triggerdef(oid) AS definition
     FROM pg_trigger
     WHERE tgrelid = 'event_search_terms'::regclass AND NOT tgisinternal
       AND tgname LIKE 'trg_event_search_postings_%'
     ORDER BY tgname`;
  const reloptions = await sql<Array<Record<string, unknown>>>
    `SELECT c.relname AS table_name, c.reloptions
     FROM pg_class c
     WHERE c.relnamespace = current_schema()::regnamespace
       AND c.relname = 'event_search_postings'`;
  return { columns, constraints, indexes, triggers, reloptions };
}

async function readPostingDifferences(sql: FullSchemaPostgresHarness["sql"]) {
  const [row] = await sql<Array<{ missing: number; extra: number; changed: number }>>`
    WITH legacy AS (
      SELECT session_id, event_id, term, term_freq, doc_len FROM event_search_terms
    ), compact AS (
      SELECT k.session_id, p.event_id, d.term, p.term_freq, p.doc_len
      FROM event_search_postings p
      JOIN event_search_session_keys k USING (session_key)
      JOIN event_search_dictionary d USING (term_id)
    ), keyed AS (
      SELECT legacy.term_freq AS legacy_tf, legacy.doc_len AS legacy_len,
             compact.term_freq AS compact_tf, compact.doc_len AS compact_len
      FROM legacy FULL JOIN compact USING (session_id, event_id, term)
    )
    SELECT COUNT(*) FILTER (WHERE legacy_tf IS NOT NULL AND compact_tf IS NULL)::int AS missing,
           COUNT(*) FILTER (WHERE legacy_tf IS NULL AND compact_tf IS NOT NULL)::int AS extra,
           COUNT(*) FILTER (WHERE (legacy_tf, legacy_len) IS DISTINCT FROM (compact_tf, compact_len)
                             AND legacy_tf IS NOT NULL AND compact_tf IS NOT NULL)::int AS changed
    FROM keyed
  `;
  return row;
}

async function readSearchStatistics(sql: FullSchemaPostgresHarness["sql"]) {
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

function runBackfill(command: string, checkpoint: string, databaseUrl: string, ...args: string[]) {
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

function expectNoDatabaseUrl(result: { stdout: string; stderr: string }, databaseUrl: string) {
  expect(result.stdout).not.toContain(databaseUrl);
  expect(result.stderr).not.toContain(databaseUrl);
}
