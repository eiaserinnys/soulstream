import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, hasFullSchemaPostgresBackend, type FullSchemaPostgresHarness } from "./full_schema_postgres_harness.js";

import { runBackfill } from "./event_search_postings_mirror_postgres_helpers.js";
import { eventSearchMigration as migration, installLegacyEventSearch } from "./event_search_legacy_fixture.js";
const describePostgres = hasFullSchemaPostgresBackend ? describe.sequential : describe.skip;

describePostgres("event search direct writer migration", () => {
  let harness: FullSchemaPostgresHarness;
  beforeAll(async () => { harness = await createFullSchemaPostgresHarness(); }, 120_000);
  afterAll(async () => { await harness?.cleanup(); });

  it("preserves legacy lifecycle results, rejects dependent objects, and replays", async () => {
    const sql = harness.sql;
    const freshWriters = await sql`SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
        AND p.proname IN ('refresh_event_search_terms', 'decrement_event_search_corpus_stats')
      ORDER BY p.proname`;
    expect(freshWriters).toHaveLength(2);
    expect((await sql`SELECT to_regclass('event_search_terms') AS relation`)[0]?.relation).toBeNull();
    const legacyFunctions = await sql`SELECT proname FROM pg_proc
      WHERE pronamespace = current_schema()::regnamespace
        AND proname IN ('mirror_event_search_postings', 'update_event_search_term_document_frequency')`;
    expect(legacyFunctions).toEqual([]);
    await installLegacyEventSearch(harness);
    const legacy = await runLifecycle(harness);
    await sql`INSERT INTO sessions (session_id, status) VALUES ('rollback-guard', 'idle')`;
    await sql`INSERT INTO events (session_id, id, event_type, searchable_text)
      VALUES ('rollback-guard', 1, 'user_message', 'rollback alpha')`;
    const savedTerms = await sql`SELECT term, term_freq FROM event_search_terms
      WHERE session_id = 'rollback-guard' ORDER BY term`;
    expect(savedTerms).toHaveLength(2);
    await sql.unsafe(`CREATE VIEW unexpected_legacy_dependency AS SELECT * FROM event_search_terms`);
    const before = await sql`SELECT pg_get_functiondef('refresh_event_search_terms()'::regprocedure) AS definition`;
    const upgrade = migration("136_event_search_write_v2_drop_legacy");
    await expect(sql.begin((tx) => tx.unsafe(upgrade))).rejects.toMatchObject({ code: "2BP01" });
    expect(await sql`SELECT pg_get_functiondef('refresh_event_search_terms()'::regprocedure) AS definition`).toEqual(before);
    expect((await sql`SELECT count(*)::int AS n FROM pg_trigger
      WHERE tgrelid = 'event_search_terms'::regclass AND NOT tgisinternal`)[0]?.n).toBe(6);
    expect(await sql`SELECT term, term_freq FROM event_search_terms
      WHERE session_id = 'rollback-guard' ORDER BY term`).toEqual(savedTerms);
    await sql`DROP VIEW unexpected_legacy_dependency`;
    await sql`DELETE FROM sessions WHERE session_id = 'rollback-guard'`;
    await resetFixture(harness);
    await sql.begin((tx) => tx.unsafe(upgrade));
    await sql.begin((tx) => tx.unsafe(upgrade));
    expect((await sql`SELECT to_regclass('event_search_terms') AS relation`)[0]?.relation).toBeNull();
    expect(await sql`SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
        AND p.proname IN ('refresh_event_search_terms', 'decrement_event_search_corpus_stats')
      ORDER BY p.proname`).toEqual(freshWriters);
    const direct = await runLifecycle(harness);
    expect(direct).toEqual(legacy);
    const directory = mkdtempSync(join(tmpdir(), "event-search-retired-"));
    try {
      for (const command of ["backfill", "verify"]) {
        const result = runBackfill(command, join(directory, `${command}.json`), harness.databaseUrl);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("retired after the v2 write switch");
      }
      const status = runBackfill("status", join(directory, "status.json"), harness.databaseUrl);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("event_search_postings");
      expect(status.stdout).not.toContain("event_search_terms");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

async function resetFixture(harness: FullSchemaPostgresHarness) {
  const sql = harness.sql;
  await sql`DELETE FROM sessions WHERE session_id IN ('write-a', 'write-b')`;
  await sql`TRUNCATE event_search_postings, event_search_documents, event_search_dictionary,
    event_search_session_keys, event_search_event_types, event_search_term_document_frequency`;
  await sql`UPDATE event_search_corpus_stats SET total_docs = 0, total_doc_len = 0 WHERE id = TRUE`;
}

async function runLifecycle(harness: FullSchemaPostgresHarness) {
  const sql = harness.sql;
  const results: unknown[] = [];
  const record = async () => { results.push(await snapshot(harness)); };
  const longRandom = Array.from({ length: 30 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("");
  await sql`INSERT INTO sessions (session_id, status) VALUES ('write-a', 'idle'), ('write-b', 'idle')`;
  await sql`INSERT INTO events (session_id, id, event_type, searchable_text, created_at) VALUES
    ('write-a', 1, 'user_message', 'alpha 디스크 디스크', '2026-10-28T00:00:00Z'),
    ('write-a', 2, 'assistant_message', '', NULL),
    ('write-b', 1, 'user_message', ${`beta ${longRandom} ${"가".repeat(1000)}`}, '2026-10-29T00:00:00Z')`;
  await record();
  await sql`UPDATE events SET searchable_text = 'alpha gamma gamma' WHERE session_id = 'write-a' AND id = 1`;
  await record();
  await sql`UPDATE events SET searchable_text = '' WHERE session_id = 'write-a' AND id = 1`;
  await record();
  await sql`INSERT INTO events (session_id, id, event_type, searchable_text, created_at)
    VALUES ('write-a', 3, 'user_message', 'alpha 디스크위생', '2026-10-30T00:00:00Z')`;
  await record();
  await sql`DELETE FROM events WHERE session_id = 'write-a' AND id = 3`;
  await record();
  await sql`DELETE FROM sessions WHERE session_id = 'write-a'`;
  await record();
  await sql`DELETE FROM sessions WHERE session_id = 'write-b'`;
  await record();
  return results;
}

async function snapshot(harness: FullSchemaPostgresHarness) {
  const sql = harness.sql;
  const postings = await sql`SELECT k.session_id, p.event_id, d.term, p.term_freq, m.doc_len,
      y.event_type, m.created_at::text AS created_at
    FROM event_search_postings p JOIN event_search_session_keys k USING (session_key)
    JOIN event_search_dictionary d USING (term_id)
    LEFT JOIN event_search_documents m USING (session_key, event_id)
    LEFT JOIN event_search_event_types y USING (event_type_id)
    ORDER BY k.session_id, p.event_id, d.term`;
  const documents = await sql`SELECT k.session_id, m.event_id, m.doc_len, y.event_type,
      m.created_at::text AS created_at FROM event_search_documents m
    JOIN event_search_session_keys k USING (session_key) JOIN event_search_event_types y USING (event_type_id)
    ORDER BY k.session_id, m.event_id`;
  const df = await sql`SELECT term, document_count FROM event_search_term_document_frequency ORDER BY term`;
  const corpus = await sql`SELECT total_docs, total_doc_len FROM event_search_corpus_stats`;
  const search = await sql`SELECT id, session_id, score FROM event_search('alpha 디스크', NULL, 50,
      NULL, NULL, 2, 3) ORDER BY score DESC, session_id, id`;
  const orphans = await sql`SELECT count(*)::int AS n FROM event_search_postings p
    LEFT JOIN event_search_documents m USING (session_key, event_id) WHERE m.event_id IS NULL`;
  expect(orphans[0]?.n).toBe(0);
  return { postings, documents, df, corpus, search };
}
