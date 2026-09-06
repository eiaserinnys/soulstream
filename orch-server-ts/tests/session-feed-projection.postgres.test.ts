import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

import { startPostgresTestContainer } from
  "../../packages/db-schema/scripts/postgres-test-container.mjs";

const hasDocker = spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

describePostgres("session feed PostgreSQL projection", () => {
  let sql: ReturnType<typeof postgres>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ sql, cleanup } = await createHarness());
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("uses timestamp/event-id CAS and orders the feed before pagination", async () => {
    await sql`
      INSERT INTO sessions (session_id, status, session_type, created_at, updated_at)
      VALUES
        ('feed-a', 'idle', 'claude', '2026-09-06T12:01:00Z', '2026-09-06T12:09:00Z'),
        ('feed-b', 'idle', 'claude', '2026-09-06T12:06:00Z', '2026-09-06T12:07:00Z'),
        ('feed-c', 'idle', 'claude', NULL, '2026-09-06T12:04:00Z')
    `;
    await sql`
      UPDATE sessions
      SET last_message = '{"type":"turn_summary","preview":"not chat","timestamp":"2026-09-06T13:00:00Z"}'::jsonb
      WHERE session_id = 'feed-c'
    `;
    const first = await sql`
      SELECT * FROM session_apply_last_chat_message(
        'feed-a', 10,
        ${sql.json({ type: "assistant_message", preview: " first " })}::jsonb,
        '2026-09-06T12:05:00Z'
      )
    `;
    const winner = await sql`
      SELECT * FROM session_apply_last_chat_message(
        'feed-a', 11,
        ${sql.json({ type: "user_message", preview: "second" })}::jsonb,
        '2026-09-06T12:05:00Z'
      )
    `;
    const loser = await sql`
      SELECT * FROM session_apply_last_chat_message(
        'feed-a', 12,
        ${sql.json({ type: "assistant_message", preview: "older" })}::jsonb,
        '2026-09-06T12:04:59Z'
      )
    `;
    const page = await sql`
      SELECT session_id FROM session_get_all(${sql.json({ feed_only: true })}::jsonb, 2, 0)
    `;

    expect(first[0]).toMatchObject({
      applied: true,
      last_message: { eventId: 10, preview: "first" },
    });
    expect(winner[0]).toMatchObject({ applied: true, last_message: { eventId: 11 } });
    expect(loser[0]).toMatchObject({ applied: false, last_message: { eventId: 11 } });
    expect(page.map((row) => row.session_id)).toEqual(["feed-b", "feed-a"]);
  });

  it("keeps the legacy signature but rejects non-chat values", async () => {
    await sql`
      INSERT INTO sessions (session_id, status)
      VALUES ('legacy-feed', 'idle')
    `;
    await sql`
      SELECT session_update_last_message(
        'legacy-feed',
        ${JSON.stringify({
          type: "turn_summary",
          preview: "must not win",
          timestamp: "2026-09-06T12:00:00.000Z",
        })},
        '2026-09-06T12:00:00Z'
      )
    `;

    const rows = await sql`SELECT last_message FROM sessions WHERE session_id = 'legacy-feed'`;
    expect(rows[0]?.last_message).toBeNull();
  });

  it("reapplies migration 090 and backfills only exact-final chat plus unresolved identities", async () => {
    await sql`
      INSERT INTO sessions (session_id, status)
      VALUES ('migration-feed', 'running')
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES
        ('migration-feed', 1, 'realtime_transcript',
          '{"type":"realtime_transcript","role":"assistant","text":"missing"}',
          '2026-09-06T12:00:01Z'),
        ('migration-feed', 2, 'input_request',
          '{"type":"input_request","request_id":"resolved"}',
          '2026-09-06T12:00:02Z'),
        ('migration-feed', 3, 'input_request_responded',
          '{"type":"input_request_responded","request_id":"resolved"}',
          '2026-09-06T12:00:03Z'),
        ('migration-feed', 4, 'input_request',
          '{"type":"input_request","request_id":"pending"}',
          '2026-09-06T12:00:04Z'),
        ('migration-feed', 5, 'realtime_transcript',
          '{"type":"realtime_transcript","role":"assistant","text":"false","final":false}',
          '2026-09-06T12:00:05Z'),
        ('migration-feed', 6, 'realtime_transcript',
          '{"type":"realtime_transcript","role":"assistant","text":"final","final":true}',
          '2026-09-06T12:00:06Z'),
        ('migration-feed', 7, 'claude_runtime_notification',
          '{"type":"claude_runtime_notification","notification_type":"permission","notification_id":"permission-pending","message":"allow?"}',
          NOW() - INTERVAL '1 minute'),
        ('migration-feed', 8, 'claude_runtime_mode_state',
          '{"type":"claude_runtime_mode_state","mode":"plan","active":false,"tool_name":"ExitPlanMode","tool_use_id":"exit-pending"}',
          NOW() - INTERVAL '30 seconds')
    `;
    await sql`
      INSERT INTO sessions (session_id, status)
      VALUES ('migration-ended-feed', 'completed')
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES
        ('migration-ended-feed', 1, 'input_request',
          '{"type":"input_request","request_id":"must-clear"}',
          '2026-09-06T12:00:01Z'),
        ('migration-ended-feed', 2, 'session_ended',
          '{"type":"session_ended","status":"completed"}',
          '2026-09-06T12:00:02Z')
    `;
    const oversizedToolName = "도".repeat(500);
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES
        ('migration-feed', 9, 'tool_approval_requested',
          ${sql.json({
            type: "tool_approval_requested",
            approval_id: "approval-pending",
            tool_name: oversizedToolName,
          })}::jsonb,
          '2026-09-06T12:00:09Z'),
        ('migration-feed', 10, 'input_request',
          ${sql.json({
            type: "input_request",
            request_id: "huge-timeout",
            timeout_sec: "9".repeat(10_000),
          })}::jsonb,
          '2026-09-06T12:00:10Z'),
        ('migration-feed', 11, 'claude_runtime_mode_state',
          '{"type":"claude_runtime_mode_state","mode":"plan","active":true,"tool_name":"ExitPlanMode","tool_use_id":"exit-pending"}',
          '2026-09-06T12:00:11Z'),
        ('migration-feed', 12, 'session_notification',
          '{"type":"session_notification","delivery_id":"delivery-42","delivery_intent":"completion_notification","source":"background-agent","disposition":"auto_resume","text":"Background work finished"}',
          '2026-09-06T12:00:12Z')
    `;
    await sql`
      INSERT INTO sessions (session_id, status)
      VALUES
        ('migration-rejected-terminal', 'running'),
        ('migration-error-terminal', 'error')
    `;
    await sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at)
      VALUES
        ('migration-rejected-terminal', 1, 'input_request',
          '{"type":"input_request","request_id":"must-remain"}',
          '2026-09-06T12:01:01Z'),
        ('migration-rejected-terminal', 2, 'session_ended',
          '{"type":"session_ended","status":"completed"}',
          '2026-09-06T12:01:02Z'),
        ('migration-error-terminal', 1, 'session_ended',
          '{"type":"session_ended","status":"error"}',
          '2026-09-06T12:02:01Z')
    `;
    await sql`
      INSERT INTO event_ingress_receipts (
        node_id, stream_id, source_seq, session_id, payload_hash,
        event_id, effect_application
      ) VALUES (
        'node-rejected', '00000000-0000-0000-0000-000000000001', 1,
        'migration-rejected-terminal', ${"a".repeat(64)}, 2,
        '{"applied":false}'::jsonb
      )
    `;
    const migration = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/migrations/090_session_feed_projection.sql",
      import.meta.url,
    )), "utf8");

    await sql.unsafe(migration);
    await sql.unsafe(migration);

    const session = await sql`
      SELECT last_message FROM sessions WHERE session_id = 'migration-feed'
    `;
    const attentions = await sql`
      SELECT attention_id FROM session_pending_attentions
      WHERE session_id = 'migration-feed' ORDER BY attention_id
    `;
    expect(session[0]?.last_message).toMatchObject({
      type: "assistant_message",
      eventId: 6,
      preview: "final",
    });
    expect(attentions.map((row) => row.attention_id)).toEqual([
      "input_request:huge-timeout",
      "input_request:pending",
      "permission:permission-pending",
      "tool_approval:approval-pending",
    ]);
    const endedAttentions = await sql`
      SELECT attention_id FROM session_pending_attentions
      WHERE session_id = 'migration-ended-feed'
    `;
    expect(endedAttentions).toEqual([]);
    const oversizedAttentions = await sql`
      SELECT attention_id, projection
      FROM session_pending_attentions
      WHERE session_id = 'migration-feed'
        AND attention_id IN (
          'input_request:huge-timeout', 'tool_approval:approval-pending'
        )
      ORDER BY attention_id
    `;
    expect(oversizedAttentions[0]?.projection).not.toHaveProperty("timeoutSec");
    expect(oversizedAttentions[0]?.projection).not.toHaveProperty("expiresAt");
    expect(oversizedAttentions[1]?.projection).toMatchObject({
      body: "도".repeat(200),
      toolName: "도".repeat(200),
    });
    const rejectedAttentions = await sql`
      SELECT attention_id FROM session_pending_attentions
      WHERE session_id = 'migration-rejected-terminal'
    `;
    expect(rejectedAttentions.map((row) => row.attention_id))
      .toEqual(["input_request:must-remain"]);
    const rejectedNotices = await sql`
      SELECT source_event_id FROM session_feed_notices
      WHERE session_id = 'migration-rejected-terminal'
      ORDER BY source_event_id
    `;
    expect(rejectedNotices.map((row) => row.source_event_id)).toEqual([1]);
    const errorNotice = await sql`
      SELECT projection FROM session_feed_notices
      WHERE session_id = 'migration-error-terminal'
    `;
    expect(errorNotice[0]?.projection).toMatchObject({
      kind: "terminal",
      title: "세션 오류",
      body: "세션 오류",
    });
    const notificationNotice = await sql`
      SELECT projection FROM session_feed_notices
      WHERE session_id = 'migration-feed' AND source_event_id = 12
    `;
    expect(notificationNotice).toHaveLength(1);
    expect(notificationNotice[0]?.projection).toEqual({
      id: "migration-feed:12",
      sourceEventId: 12,
      sessionId: "migration-feed",
      kind: "response_wait",
      title: "Soul Dashboard",
      body: "Background work finished",
      createdAt: "2026-09-06T12:00:12+00:00",
    });
    const noticeCounts = await sql`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM session_feed_notices
          WHERE session_id = 'migration-feed') AS stored_count,
        notification_count
      FROM session_feed_state
      WHERE session_id = 'migration-feed'
    `;
    expect(noticeCounts[0]).toEqual({ stored_count: 7, notification_count: "7" });
  });
});

async function createHarness(): Promise<{
  sql: ReturnType<typeof postgres>;
  cleanup: () => Promise<void>;
}> {
  const container = startPostgresTestContainer({
    user: "session_feed_test",
    password: "session_feed_test",
    database: "session_feed_test_db",
  });
  const url = `postgres://session_feed_test:session_feed_test@127.0.0.1:${container.port}/session_feed_test_db`;
  const bootstrap = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await waitForPostgres(bootstrap);
    const schema = readFileSync(fileURLToPath(new URL(
      "../../packages/db-schema/sql/schema.sql",
      import.meta.url,
    )), "utf8");
    await bootstrap.unsafe(schema);
  } catch (error) {
    await bootstrap.end({ timeout: 2 }).catch(() => undefined);
    container.stop();
    throw error;
  }
  return {
    sql: bootstrap,
    cleanup: async () => {
      await bootstrap.end({ timeout: 2 });
      container.stop();
    },
  };
}

async function waitForPostgres(sql: ReturnType<typeof postgres>): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
