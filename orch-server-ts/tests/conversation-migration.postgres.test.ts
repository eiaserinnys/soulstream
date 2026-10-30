import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

describe("conversation 138 to 139 migration", () => {
  let db: FullSchemaPostgresHarness;
  beforeAll(async () => { db = await createFullSchemaPostgresHarness(); }, 60_000);
  afterAll(async () => { await db?.cleanup(); });
  it("preserves notices from existing bindings with stable ids and times", async () => {
    await db.sql.begin(async tx => {
      await tx.unsafe("CREATE TEMP TABLE conversation_bindings (session_id TEXT NOT NULL, notices JSONB NOT NULL) ON COMMIT DROP");
      await tx.unsafe("CREATE TEMP TABLE sessions (session_id TEXT NOT NULL, created_at TIMESTAMPTZ) ON COMMIT DROP");
      await tx`INSERT INTO sessions VALUES ('old','2026-10-30T00:00:00Z')`;
      await tx`INSERT INTO conversation_bindings VALUES ('old',${tx.json(["first","second"])})`;
      const migration = readFileSync(new URL("../../packages/db-schema/sql/migrations/139_conversation_initial_and_notices.sql", import.meta.url), "utf8");
      await tx.unsafe(migration);
      const [row] = await tx`SELECT notices, first_input_is_initial_instruction FROM conversation_bindings WHERE session_id='old'`;
      expect(row?.first_input_is_initial_instruction).toBe(false);
      expect(row?.notices).toEqual([
        { id:"notice:0", text:"first", at:"2026-10-30T00:00:00.000Z" },
        { id:"notice:1", text:"second", at:"2026-10-30T00:00:00.000Z" },
      ]);
    });
  });
});
