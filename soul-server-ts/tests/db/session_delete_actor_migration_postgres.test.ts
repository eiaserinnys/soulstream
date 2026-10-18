import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFullSchemaPostgresHarness,
  hasFullSchemaPostgresBackend,
  type FullSchemaPostgresHarness,
} from "./full_schema_postgres_harness.js";

const describePostgres = hasFullSchemaPostgresBackend ? describe : describe.skip;

describePostgres("session delete actor migration PostgreSQL", () => {
  let harness: FullSchemaPostgresHarness;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
  }, 120_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  it("preserves agent operation history when deleting its actor session", async () => {
    await harness.sql.unsafe(`
      ALTER TABLE block_operations
      ADD CONSTRAINT block_operations_agent_actor_check
      CHECK (actor_kind <> 'agent' OR actor_session_id IS NOT NULL)
    `);
    await harness.sql`
      INSERT INTO sessions (session_id, session_type, status)
      VALUES ('delete-actor-session', 'codex', 'completed')
    `;
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload)
      VALUES ('delete-actor-session', 7, 'assistant_message', '{"text":"event"}'::jsonb)
    `;
    await harness.sql`
      INSERT INTO pages (id, title, version)
      VALUES ('delete-actor-page', 'Delete actor page', 2)
    `;
    await harness.sql`
      INSERT INTO blocks (id, page_id, position_key, text_plain)
      VALUES ('delete-actor-block', 'delete-actor-page', 'V', 'Preserve this block')
    `;
    await harness.sql`
      INSERT INTO block_operations (
        id, page_id, target_block_id, operation_type, actor_kind,
        actor_session_id, actor_event_id, idempotency_key,
        expected_version, result_version, payload_json, reason, created_at
      ) VALUES (
        'delete-actor-operation', 'delete-actor-page', 'delete-actor-block',
        'set_block_text', 'agent', 'delete-actor-session', 7,
        'delete-actor-operation-key', 1, 2, '{"text":"after"}'::jsonb,
        'test provenance preservation', '2026-10-19T00:00:00Z'
      )
    `;

    const [before] = await harness.sql<Array<{
      id: string;
      page_id: string;
      target_block_id: string | null;
      operation_type: string;
      actor_kind: string;
      actor_session_id: string | null;
      actor_event_id: number | null;
      actor_user_id: string | null;
      idempotency_key: string;
      expected_version: number;
      result_version: number;
      payload_json: Record<string, unknown>;
      reason: string | null;
      created_at: Date;
    }>>`
      SELECT
        id, page_id, target_block_id, operation_type, actor_kind,
        actor_session_id, actor_event_id, actor_user_id, idempotency_key,
        expected_version, result_version, payload_json, reason, created_at
      FROM block_operations
      WHERE id = 'delete-actor-operation'
    `;
    expect(before).toBeDefined();

    const deleteError = await harness.sql`
      SELECT session_delete('delete-actor-session')
    `.then(() => null, (error: unknown) => error);
    expect(deleteError).toMatchObject({
      code: "23514",
      constraint_name: "block_operations_agent_actor_check",
    });

    const [rollbackCounts] = await harness.sql<Array<{
      sessions: number;
      events: number;
      operations: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM sessions
          WHERE session_id = 'delete-actor-session') AS sessions,
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = 'delete-actor-session') AS events,
        (SELECT COUNT(*)::int FROM block_operations
          WHERE id = 'delete-actor-operation') AS operations
    `;
    expect(rollbackCounts).toEqual({ sessions: 1, events: 1, operations: 1 });

    const migration = readFileSync(
      new URL(
        "../../../packages/db-schema/sql/migrations/124_block_operations_actor_session_nullable.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await harness.sql.unsafe(migration);
    await harness.sql`SELECT session_delete('delete-actor-session')`;

    const [deletedCounts] = await harness.sql<Array<{
      sessions: number;
      events: number;
    }>>`
      SELECT
        (SELECT COUNT(*)::int FROM sessions
          WHERE session_id = 'delete-actor-session') AS sessions,
        (SELECT COUNT(*)::int FROM events
          WHERE session_id = 'delete-actor-session') AS events
    `;
    expect(deletedCounts).toEqual({ sessions: 0, events: 0 });

    const [after] = await harness.sql<Array<{
      id: string;
      page_id: string;
      target_block_id: string | null;
      operation_type: string;
      actor_kind: string;
      actor_session_id: string | null;
      actor_event_id: number | null;
      actor_user_id: string | null;
      idempotency_key: string;
      expected_version: number;
      result_version: number;
      payload_json: Record<string, unknown>;
      reason: string | null;
      created_at: Date;
    }>>`
      SELECT
        id, page_id, target_block_id, operation_type, actor_kind,
        actor_session_id, actor_event_id, actor_user_id, idempotency_key,
        expected_version, result_version, payload_json, reason, created_at
      FROM block_operations
      WHERE id = 'delete-actor-operation'
    `;
    expect([
      { ...before, actor_session_id: null, actor_event_id: null },
      { ...before, actor_session_id: null },
    ]).toContainEqual(after);

    const [page] = await harness.sql<Array<{
      id: string;
      title: string;
      version: number;
    }>>`
      SELECT id, title, version FROM pages WHERE id = 'delete-actor-page'
    `;
    expect(page).toEqual({ id: "delete-actor-page", title: "Delete actor page", version: 2 });

    const [block] = await harness.sql<Array<{
      id: string;
      page_id: string;
      position_key: string;
      text_plain: string;
    }>>`
      SELECT id, page_id, position_key, text_plain
      FROM blocks
      WHERE id = 'delete-actor-block'
    `;
    expect(block).toEqual({
      id: "delete-actor-block",
      page_id: "delete-actor-page",
      position_key: "V",
      text_plain: "Preserve this block",
    });

    const remainingActorCheck = await harness.sql<Array<{ constraint_name: string }>>`
      SELECT conname AS constraint_name
      FROM pg_constraint
      WHERE conrelid = 'block_operations'::regclass
        AND conname = 'block_operations_agent_actor_check'
    `;
    expect(remainingActorCheck).toEqual([]);

    const actorForeignKeys = await harness.sql<Array<{
      constraint_name: string;
      delete_action: string;
    }>>`
      SELECT conname AS constraint_name, confdeltype AS delete_action
      FROM pg_constraint
      WHERE conrelid = 'block_operations'::regclass
        AND contype = 'f'
        AND conname IN (
          'block_operations_actor_session_id_fkey',
          'block_operations_actor_event_fkey'
        )
      ORDER BY conname
    `;
    expect(actorForeignKeys).toEqual([
      { constraint_name: "block_operations_actor_event_fkey", delete_action: "n" },
      { constraint_name: "block_operations_actor_session_id_fkey", delete_action: "n" },
    ]);
  });
});
