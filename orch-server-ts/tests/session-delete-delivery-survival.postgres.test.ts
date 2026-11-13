/**
 * card #1261 — 세션 행을 지워도 부른 세션으로 가는 완료 전달 행은 살아남는다.
 *
 * session_deliveries.source_session_id는 schema.sql의
 * `REFERENCES sessions(session_id) ON DELETE SET NULL`이므로, 자식 세션 행 삭제 뒤에도
 * 전달 행은 target_session_id를 그대로 유지한 채 남아야 한다. 이 성질이 깨지면
 * "멈춘 뒤 지운다" 경로가 부른 세션에 멈춤 알림을 등록한 직후 그 등록을 잃는다.
 */
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPagePostgresHarness, type PagePostgresHarness } from
  "./page/page_postgres_harness.js";

let harness: PagePostgresHarness;

function extractBlock(sql: string, start: string, end: string): string {
  const from = sql.indexOf(start);
  if (from < 0) throw new Error(`missing SQL block start: ${start}`);
  const to = sql.indexOf(end, from);
  if (to < 0) throw new Error(`missing SQL block end: ${end}`);
  return sql.slice(from, to + end.length);
}

beforeAll(async () => {
  harness = await createPagePostgresHarness();
  const schemaSql = await readFile(
    new URL("../../packages/db-schema/sql/schema.sql", import.meta.url),
    "utf8",
  );
  await harness.sql.unsafe(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS claude_session_id TEXT;
    CREATE TABLE claude_transcript_entries (
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    );
  `);
  await harness.sql.unsafe(extractBlock(
    schemaSql,
    "CREATE TABLE IF NOT EXISTS session_deliveries (",
    "\n);",
  ));
  await harness.sql.unsafe(extractBlock(
    schemaSql,
    "CREATE OR REPLACE FUNCTION session_delete(",
    "\n$$;",
  ));
}, 120_000);

afterAll(async () => {
  await harness?.cleanup();
});

describe("session_delete와 완료 전달 행 (card #1261)", () => {
  it("자식 세션 행 삭제 뒤에도 전달 행은 target을 유지하고 source만 NULL이 된다", async () => {
    const sql = harness.sql;
    await sql`INSERT INTO sessions (session_id, status) VALUES ('child-1', 'interrupted')`;
    await sql`INSERT INTO sessions (session_id, status) VALUES ('caller-1', 'running')`;
    await sql`
      INSERT INTO session_deliveries (
        delivery_id, target_session_id, source_session_id, relation_key,
        intent, source, payload_hash, payload, state
      ) VALUES (
        'delivery-1', 'caller-1', 'child-1', 'child_session:child-1:8',
        'completion_notification', 'completion_notifier', 'hash-1',
        '{"text":"⏹️ 에이전트 세션을 사람이 멈춤"}'::jsonb, 'pending'
      )
    `;

    await sql`SELECT session_delete('child-1')`;

    const [child] = await sql<[{ count: number }]>`
      SELECT COUNT(*)::int AS count FROM sessions WHERE session_id = 'child-1'
    `;
    expect(child?.count).toBe(0);

    const rows = await sql<Array<{
      delivery_id: string;
      target_session_id: string | null;
      source_session_id: string | null;
      state: string;
      intent: string;
    }>>`SELECT delivery_id, target_session_id, source_session_id, state, intent
         FROM session_deliveries WHERE delivery_id = 'delivery-1'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      delivery_id: "delivery-1",
      target_session_id: "caller-1",
      source_session_id: null,
      state: "pending",
      intent: "completion_notification",
    });
    // 부른 세션 행은 그대로 남아 전달이 계속 소비될 수 있다.
    const [caller] = await sql<[{ node_id: string | null }]>`
      SELECT node_id FROM sessions WHERE session_id = 'caller-1'
    `;
    expect(caller).toBeDefined();
  });
});
