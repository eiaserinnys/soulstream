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
  it("backfills each existing binding and receipt when executions are introduced", async () => {
    await db.sql.begin(async tx => {
      await tx.unsafe("DROP TABLE conversation_executions");
      await tx.unsafe("ALTER TABLE conversation_bindings DROP COLUMN active_session_id");
      await tx.unsafe("ALTER TABLE conversation_message_receipts DROP COLUMN target_session_id");
      await tx`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,selected_model,phase,first_input_is_initial_instruction)
        VALUES ('person','n','k','old-execution','sol','complete',true)`;
      await tx`INSERT INTO conversation_message_receipts(session_id,request_id,request_hash,delivery_id,caller_info,status)
        VALUES ('old-execution','req','hash','delivery','{}'::jsonb,'accepted')`;
      const migration = readFileSync(new URL("../../packages/db-schema/sql/migrations/141_conversation_executions.sql", import.meta.url), "utf8");
      await tx.unsafe(migration);
      const [binding] = await tx`SELECT active_session_id FROM conversation_bindings WHERE session_id='old-execution'`;
      const [execution] = await tx`SELECT session_id,ordinal,first_input_is_initial_instruction FROM conversation_executions WHERE thread_id='old-execution'`;
      const [receipt] = await tx`SELECT target_session_id FROM conversation_message_receipts WHERE session_id='old-execution'`;
      expect(binding?.active_session_id).toBe("old-execution");
      expect(execution).toMatchObject({session_id:"old-execution",ordinal:0,first_input_is_initial_instruction:true});
      expect(receipt?.target_session_id).toBe("old-execution");
    });
  });
  it("reapplying the schema preserves an active replacement and receipt targets", async () => {
    await db.sql`INSERT INTO conversation_bindings(account_id,namespace,external_key,session_id,active_session_id,selected_model,phase)
      VALUES ('person','n','reapply','schema-old','schema-new','sol','complete')`;
    await db.sql`INSERT INTO conversation_executions(thread_id,session_id,predecessor_session_id,ordinal) VALUES
      ('schema-old','schema-old',NULL,0),('schema-old','schema-new','schema-old',1)`;
    await db.sql`INSERT INTO conversation_message_receipts(session_id,request_id,request_hash,delivery_id,caller_info,status,target_session_id)
      VALUES ('schema-old','req','hash','schema-delivery','{}'::jsonb,'accepted','schema-new')`;
    const schema = readFileSync(new URL("../../packages/db-schema/sql/schema.sql", import.meta.url), "utf8");
    await db.sql.unsafe(schema);
    const [binding] = await db.sql`SELECT active_session_id FROM conversation_bindings WHERE session_id='schema-old'`;
    const executions = await db.sql`SELECT session_id FROM conversation_executions WHERE thread_id='schema-old' ORDER BY ordinal`;
    const [receipt] = await db.sql`SELECT target_session_id FROM conversation_message_receipts WHERE session_id='schema-old'`;
    expect(binding?.active_session_id).toBe("schema-new");
    expect(executions.map(row => row.session_id)).toEqual(["schema-old","schema-new"]);
    expect(receipt?.target_session_id).toBe("schema-new");
  }, 60_000);
});
