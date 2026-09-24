import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";

import {
  hasTestDatabaseResource,
  provisionTestDatabase,
  type TestDatabaseLease,
} from "../scripts/database_test_harness.js";

import { migrationSha256 } from "../../../packages/db-schema/scripts/migration-contract.mjs";

const COVERING_MIGRATION_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/101_event_search_terms_covering_index.sql",
  import.meta.url,
));
const INSERT_VACUUM_MIGRATION_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/migrations/102_event_search_terms_insert_vacuum_scale.sql",
  import.meta.url,
));
const MANIFEST_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/migration-manifest.json",
  import.meta.url,
));
const CANONICAL_SCHEMA_PATH = fileURLToPath(new URL(
  "../../../packages/db-schema/sql/schema.sql",
  import.meta.url,
));
const MIGRATIONS = [
  readFileSync(COVERING_MIGRATION_PATH, "utf8"),
  readFileSync(INSERT_VACUUM_MIGRATION_PATH, "utf8"),
];
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
  migrations: Array<{ id: string; sha256: string }>;
};
const SCHEMA = readFileSync(CANONICAL_SCHEMA_PATH, "utf8");
const databaseLeases: TestDatabaseLease[] = [];
const itWithDatabase = hasTestDatabaseResource() ? it : it.skip;

afterEach(async () => {
  for (const lease of databaseLeases.splice(0)) await lease.cleanup();
});

describe.sequential("event search covering index migrations", () => {
  it("keeps the fresh schema and ordered migration manifest on the same definition", () => {
    const entries = MANIFEST.migrations;
    const covering = entries.at(-2);
    const vacuum = entries.at(-1);
    expect(covering?.id).toBe("101_event_search_terms_covering_index.sql");
    expect(vacuum?.id).toBe("102_event_search_terms_insert_vacuum_scale.sql");
    expect(covering?.sha256).toBe(migrationSha256(MIGRATIONS[0]));
    expect(vacuum?.sha256).toBe(migrationSha256(MIGRATIONS[1]));

    const tableStart = SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS event_search_terms (");
    expect(tableStart).toBeGreaterThanOrEqual(0);
    const tableDefinition = SCHEMA.slice(tableStart, tableStart + 700);
    expect(tableDefinition).toContain("autovacuum_vacuum_insert_scale_factor = 0.05");
    expect(SCHEMA).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_event_search_terms_term\s+ON event_search_terms \(term\)\s+INCLUDE \(session_id, event_id, term_freq, doc_len\);/u,
    );
    expect(MIGRATIONS[0]).not.toMatch(/CREATE\s+INDEX\s+CONCURRENTLY/iu);
    expect(MIGRATIONS[0]).toContain("i.indrelid = v_table");
    expect(MIGRATIONS[0]).toContain("i.indkey[0] = v_term_att");
    expect(MIGRATIONS[0]).toContain("i.indcollation[0] = v_term_collation");
    expect(MIGRATIONS[0]).toContain("i.indpred IS NULL");
    expect(MIGRATIONS[0].indexOf("IF v_staging_index IS NOT NULL")).toBeLessThan(
      MIGRATIONS[0].indexOf("IF v_term_index IS NOT NULL"),
    );
    expect(MIGRATIONS[0].indexOf("indisvalid")).toBeLessThan(
      MIGRATIONS[0].indexOf("DROP INDEX public.idx_event_search_terms_term"),
    );
  });

  itWithDatabase("preserves every posting and BM25 rank while covering long terms and updates", async () => {
    const url = await startPostgres();
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await createLegacyShape(sql);
      await seedPostings(sql);

      const beforeRows = await readPostings(sql);
      const beforeRank = rankBm25(beforeRows, ["검색", "업무"]);
      const beforeDf = await readDocumentFrequencies(sql);
      const beforeAcl = await readRelationAcl(sql);

      await sql.begin(async (tx) => {
        for (const migration of MIGRATIONS) await tx.unsafe(migration);
      });
      await sql.begin(async (tx) => {
        for (const migration of MIGRATIONS) await tx.unsafe(migration);
      });

      const afterRows = await readPostings(sql);
      expect(afterRows).toEqual(beforeRows);
      expect(rankBm25(afterRows, ["검색", "업무"])).toEqual(beforeRank);
      expect(await readDocumentFrequencies(sql)).toEqual(beforeDf);
      expect(await readRelationAcl(sql)).toEqual(beforeAcl);

      const indexes = await sql`
        SELECT indexrelid::regclass::text AS name
        FROM pg_index
        WHERE indrelid = 'public.event_search_terms'::regclass
        ORDER BY name
      `;
      expect(indexes.map((row) => row.name)).toEqual([
        "event_search_terms_pkey",
        "idx_event_search_terms_term",
      ]);

      const catalog = await sql`
        SELECT i.indisvalid, i.indisready, i.indislive, i.indnkeyatts, i.indnatts,
               pg_get_indexdef(i.indexrelid) AS definition,
               c.reloptions
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        WHERE i.indexrelid = 'public.idx_event_search_terms_term'::regclass
      `;
      expect(catalog[0]).toMatchObject({
        indisvalid: true,
        indisready: true,
        indislive: true,
        indnkeyatts: 1,
        indnatts: 5,
      });
      expect(catalog[0].definition).toContain(
        "INCLUDE (session_id, event_id, term_freq, doc_len)",
      );
      expect(catalog[0].reloptions).toContain("autovacuum_vacuum_insert_scale_factor=0.05");

      const longMultibyteTerm = makeHighEntropyTerm(2400);
      const longInsert = await sql`
        INSERT INTO event_search_terms (session_id, event_id, term, term_freq, doc_len)
        VALUES ('session-long-insert', 5, ${longMultibyteTerm}, 2, 19)
        RETURNING octet_length(term)::int AS term_bytes
      `;
      expect(longInsert[0].term_bytes).toBe(2400);
      await sql`
        UPDATE event_search_terms
        SET term_freq = 4, doc_len = 21
        WHERE session_id = 'session-a' AND event_id = 1 AND term = '검색'
      `;
      const updated = await sql`
        SELECT session_id, event_id, term_freq, doc_len
        FROM event_search_terms
        WHERE term = '검색' AND session_id = 'session-a' AND event_id = 1
      `;
      expect(updated[0]).toMatchObject({
        session_id: "session-a",
        event_id: 1,
        term_freq: 4,
        doc_len: 21,
      });

      await sql`VACUUM (ANALYZE) public.event_search_terms`;
      await sql`SET enable_seqscan = off`;
      const explain = await sql`
        EXPLAIN (FORMAT JSON)
        SELECT session_id, event_id, term_freq, doc_len
        FROM public.event_search_terms
        WHERE term = '검색'
      `;
      const rawPlan = explain[0]["QUERY PLAN"];
      const plan = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
      expect(findIndexOnlyScan(plan)).toBe("idx_event_search_terms_term");
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  itWithDatabase("rolls back a too-wide included tuple without losing the term index", async () => {
    const url = await startPostgres();
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    let rollbackVerified = false;
    try {
      let firstAttempt = true;
      for (let termBytes = 2600; termBytes <= 2700; termBytes += 1) {
        if (!firstAttempt) {
          await sql`DROP TABLE public.event_search_terms CASCADE`;
          await sql`DROP TABLE public.event_search_term_document_frequency`;
        }
        firstAttempt = false;
        await createLegacyShape(sql);
        const term = makeHighEntropyTerm(termBytes);
        try {
          await sql`
            INSERT INTO public.event_search_terms (
              session_id, event_id, term, term_freq, doc_len
            ) VALUES ('s', 1, ${term}, 1, 1)
          `;
        } catch (error) {
          if (String(error).includes("index row requires")) break;
          throw error;
        }

        let migrationError: unknown = null;
        try {
          await sql.begin((tx) => tx.unsafe(MIGRATIONS[0]));
        } catch (error) {
          migrationError = error;
        }
        if (migrationError === null) continue;
        expect(String(migrationError)).toMatch(
          /index row (?:requires .* maximum size|size \d+ exceeds btree version \d+ maximum \d+)/iu,
        );

        const afterFailure = await sql`
          SELECT
            (SELECT indisvalid AND indisready
             FROM pg_index
             WHERE indexrelid = to_regclass('public.idx_event_search_terms_term'))
              AS legacy_index_ready,
            to_regclass('public.idx_event_search_terms_term_covering_101')::text
              AS staging_index,
            (SELECT count(*)::int FROM public.event_search_terms) AS posting_count
        `;
        expect(afterFailure[0]).toEqual({
          legacy_index_ready: true,
          staging_index: null,
          posting_count: 1,
        });
        rollbackVerified = true;
        break;
      }
      expect(rollbackVerified).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  itWithDatabase("leaves the old index intact when an invalid staging index is present", async () => {
    const url = await startPostgres();
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await createLegacyShape(sql);
      await seedPostings(sql);
      await expect(sql.unsafe(`
        CREATE UNIQUE INDEX CONCURRENTLY idx_event_search_terms_term_covering_101
        ON public.event_search_terms (term)
      `)).rejects.toThrow();

      const invalid = await sql`
        SELECT i.indisvalid, i.indisready, i.indislive
        FROM pg_index i
        WHERE i.indexrelid =
          to_regclass('public.idx_event_search_terms_term_covering_101')
      `;
      expect(invalid[0]).toMatchObject({ indisvalid: false, indisready: false, indislive: true });

      await expect(sql.begin(async (tx) => {
        for (const migration of MIGRATIONS) await tx.unsafe(migration);
      })).rejects.toThrow(/staging index/i);

      const oldIndex = await sql`
        SELECT i.indisvalid, i.indisready
        FROM pg_index i
        WHERE i.indexrelid = to_regclass('public.idx_event_search_terms_term')
      `;
      expect(oldIndex[0]).toMatchObject({ indisvalid: true, indisready: true });
    } finally {
      try {
        await sql.unsafe(
          "DROP INDEX CONCURRENTLY IF EXISTS public.idx_event_search_terms_term_covering_101",
        );
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  });

  itWithDatabase("rejects a leftover staging index even when the canonical covering index exists", async () => {
    const url = await startPostgres();
    const sql = postgres(url, { max: 1, idle_timeout: 1 });
    try {
      await createLegacyShape(sql);
      await seedPostings(sql);
      await sql`DROP INDEX public.idx_event_search_terms_term`;
      await sql`
        CREATE INDEX idx_event_search_terms_term
        ON public.event_search_terms USING btree (term)
        INCLUDE (session_id, event_id, term_freq, doc_len)
      `;
      await expect(sql.unsafe(`
        CREATE UNIQUE INDEX CONCURRENTLY idx_event_search_terms_term_covering_101
        ON public.event_search_terms (term)
      `)).rejects.toThrow();

      await expect(sql.begin((tx) => tx.unsafe(MIGRATIONS[0])))
        .rejects.toThrow(/staging index/i);
      const preserved = await sql`
        SELECT
          (SELECT indisvalid AND indisready AND indislive AND indnatts = 5
           FROM pg_index
           WHERE indexrelid = to_regclass('public.idx_event_search_terms_term'))
            AS canonical_covering_index_ready,
          (SELECT indisvalid
           FROM pg_index
           WHERE indexrelid = to_regclass('public.idx_event_search_terms_term_covering_101'))
            AS staging_index_valid
      `;
      expect(preserved[0]).toEqual({
        canonical_covering_index_ready: true,
        staging_index_valid: false,
      });
    } finally {
      try {
        await sql.unsafe(
          "DROP INDEX CONCURRENTLY IF EXISTS public.idx_event_search_terms_term_covering_101",
        );
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  });
});

async function createLegacyShape(sql: ReturnType<typeof postgres>) {
  await sql`
    CREATE TABLE public.event_search_terms (
      session_id TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      term TEXT NOT NULL,
      term_freq INTEGER NOT NULL,
      doc_len INTEGER NOT NULL,
      PRIMARY KEY (session_id, event_id, term)
    )
  `;
  await sql`CREATE INDEX idx_event_search_terms_term ON public.event_search_terms (term)`;
  await sql`
    CREATE TABLE public.event_search_term_document_frequency (
      term TEXT PRIMARY KEY,
      document_count BIGINT NOT NULL CHECK (document_count >= 0)
    )
  `;
  await sql`
    INSERT INTO public.event_search_term_document_frequency (term, document_count)
    VALUES ('검색', 3), ('업무', 3)
  `;
}

async function seedPostings(sql: ReturnType<typeof postgres>) {
  await sql`
    INSERT INTO public.event_search_terms (session_id, event_id, term, term_freq, doc_len)
    VALUES
      ('session-a', 1, '검색', 2, 10),
      ('session-a', 1, '업무', 2, 10),
      ('session-b', 2, '검색', 1, 5),
      ('session-b', 2, '업무', 1, 5),
      ('session-c', 3, '검색', 1, 7),
      ('session-d', 4, '업무', 2, 10)
  `;
  await sql`
    INSERT INTO public.event_search_terms (session_id, event_id, term, term_freq, doc_len)
    VALUES ('session-long-existing', 1, ${makeHighEntropyTerm(2400)}, 3, 12)
  `;
}

function makeHighEntropyTerm(targetBytes: number) {
  let state = 0x6d2b79f5;
  let remaining = targetBytes;
  let value = "";
  while (remaining > 0) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    if (remaining >= 3 && state % 3 !== 0) {
      value += String.fromCodePoint(0xac00 + (state % 11172));
      remaining -= 3;
    } else {
      value += String.fromCharCode(48 + (state % 10));
      remaining -= 1;
    }
  }
  return value;
}

async function readPostings(sql: ReturnType<typeof postgres>) {
  return await sql`
    SELECT session_id, event_id, term, term_freq, doc_len
    FROM public.event_search_terms
    ORDER BY session_id, event_id, term
  `;
}

async function readRelationAcl(sql: ReturnType<typeof postgres>) {
  return await sql`
    SELECT relacl
    FROM pg_class
    WHERE oid = 'public.event_search_terms'::regclass
  `;
}

async function readDocumentFrequencies(sql: ReturnType<typeof postgres>) {
  return await sql`
    SELECT term, document_count
    FROM public.event_search_term_document_frequency
    ORDER BY term
  `;
}

function rankBm25(
  rows: Array<{
    session_id: string;
    event_id: number;
    term: string;
    term_freq: number;
    doc_len: number;
  }>,
  queryTerms: string[],
) {
  const documents = new Map<string, number>();
  const documentFrequency = new Map<string, Set<string>>();
  for (const row of rows) {
    const documentKey = `${row.session_id}:${row.event_id}`;
    documents.set(documentKey, row.doc_len);
    if (queryTerms.includes(row.term)) {
      const matching = documentFrequency.get(row.term) ?? new Set<string>();
      matching.add(documentKey);
      documentFrequency.set(row.term, matching);
    }
  }
  const totalDocs = documents.size;
  const averageDocLen = [...documents.values()].reduce((sum, value) => sum + value, 0)
    / Math.max(totalDocs, 1);
  const scores = new Map<string, number>();
  for (const row of rows) {
    if (!queryTerms.includes(row.term)) continue;
    const documentKey = `${row.session_id}:${row.event_id}`;
    const docCount = documentFrequency.get(row.term)?.size ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + ((totalDocs - docCount + 0.5) / (docCount + 0.5)),
    );
    const termWeight = (row.term_freq * 2.2) / (
      row.term_freq + 1.2 * (
        0.25 + 0.75 * (row.doc_len / Math.max(averageDocLen, 1))
      )
    );
    scores.set(documentKey, (scores.get(documentKey) ?? 0) + inverseDocumentFrequency * termWeight);
  }
  return [...scores]
    .map(([key, score]) => ({ key, score: Number(score.toFixed(12)) }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key));
}

function findIndexOnlyScan(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findIndexOnlyScan(item);
      if (match) return match;
    }
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  if (node["Node Type"] === "Index Only Scan") return String(node["Index Name"]);
  for (const child of Object.values(node)) {
    const match = findIndexOnlyScan(child);
    if (match) return match;
  }
  return null;
}

async function startPostgres() {
  const lease = await provisionTestDatabase({
    prefix: "event_search_covering",
    dockerUser: "event_search_covering_test",
    dockerPassword: "event_search_covering_test_secret",
    dockerDatabase: "event_search_covering_test_db",
  });
  databaseLeases.push(lease);
  return lease.url;
}
