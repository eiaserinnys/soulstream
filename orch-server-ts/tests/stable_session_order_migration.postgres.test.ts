import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPagePostgresHarness, type PagePostgresHarness } from "./page/page_postgres_harness.js";

// 카드 #1476: 기동 때 만들던 stable order 인덱스를 마이그레이션 정본으로 옮긴다.
const MIGRATION = new URL(
  "../../packages/db-schema/sql/migrations/162_sessions_partial_indexes.sql",
  import.meta.url,
);
const SCHEMA_SQL = new URL("../../packages/db-schema/sql/schema.sql", import.meta.url);

describe("sessions partial index migration", () => {
  let h: PagePostgresHarness;

  beforeAll(async () => {
    h = await createPagePostgresHarness();
    await h.sql`ALTER TABLE sessions ADD COLUMN metadata JSONB`;
  }, 60_000);

  afterAll(async () => { await h?.cleanup(); });

  it("applies on an empty schema and again when the indexes already exist", async () => {
    const migration = await readFile(MIGRATION, "utf8");
    await h.sql.unsafe(migration);
    await h.sql.unsafe(migration);

    const rows = await h.sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname IN ('idx_sessions_caller_session_id','idx_sessions_persistent_report','idx_sessions_updated_at_session_id')
      ORDER BY indexname`;
    expect(rows.map(row => row.indexname)).toEqual([
      "idx_sessions_caller_session_id",
      "idx_sessions_persistent_report",
      "idx_sessions_updated_at_session_id",
    ]);
    const definition = (name: string) => rows.find(row => row.indexname === name)!.indexdef;
    expect(definition("idx_sessions_caller_session_id"))
      .toContain("USING btree (caller_session_id) WHERE (caller_session_id IS NOT NULL)");
    expect(definition("idx_sessions_persistent_report"))
      .toContain(`USING btree (session_id) WHERE (metadata @> '[{"type": "persistent_report"}]'::jsonb)`);
    expect(definition("idx_sessions_updated_at_session_id"))
      .toContain("USING btree (updated_at DESC, session_id DESC)");
  });

  it("is mirrored in the canonical fresh-install schema", async () => {
    const schema = await readFile(SCHEMA_SQL, "utf8");
    for (const definition of [
      "CREATE INDEX IF NOT EXISTS idx_sessions_caller_session_id\n    ON sessions (caller_session_id) WHERE caller_session_id IS NOT NULL;",
      `CREATE INDEX IF NOT EXISTS idx_sessions_persistent_report
    ON sessions (session_id) WHERE metadata @> '[{"type":"persistent_report"}]'::jsonb;`,
      "CREATE INDEX IF NOT EXISTS idx_sessions_updated_at_session_id\n    ON sessions (updated_at DESC, session_id DESC);",
    ]) expect(schema).toContain(definition);
  });
});
