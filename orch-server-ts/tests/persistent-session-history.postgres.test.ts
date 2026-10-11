import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventReadRepository } from "../src/control_plane/repositories/event_read_repository.js";
import type { PersistentSessionHistoryQuery } from "../src/control_plane/repositories/persistent_session_history_query.js";
import { createFullSchemaPostgresHarness, type FullSchemaPostgresHarness } from "./board_yjs_postgres_harness.js";

const hasDocker = Boolean(process.env.TEST_DATABASE_URL?.trim()) ||
  spawnSync("docker", ["--version"], { stdio: "ignore" }).status === 0;
const describePostgres = hasDocker ? describe : describe.skip;

describePostgres("persistent session history event query", () => {
  let harness: FullSchemaPostgresHarness;
  let repository: EventReadRepository;

  beforeAll(async () => {
    harness = await createFullSchemaPostgresHarness();
    repository = new EventReadRepository(harness.sql as never);
  }, 60_000);

  afterAll(async () => {
    await harness?.cleanup();
  });

  async function seedSession(sessionId: string) {
    await harness.sql`INSERT INTO sessions (session_id, display_name) VALUES (${sessionId}, ${sessionId})`;
  }

  async function seedEvent(input: {
    sessionId: string;
    id: number;
    type: string;
    at: string;
    payload: Record<string, unknown>;
    parentEventId?: number | null;
  }) {
    await harness.sql`
      INSERT INTO events (session_id, id, event_type, payload, created_at, parent_event_id)
      VALUES (${input.sessionId}, ${input.id}, ${input.type}, ${harness.sql.json(input.payload as never)},
              ${input.at}::timestamptz, ${input.parentEventId ?? null})
    `;
  }

  const query = (sessionId: string, overrides: Partial<PersistentSessionHistoryQuery> = {}): PersistentSessionHistoryQuery => ({
    sessionId,
    since: new Date("2026-10-04T15:00:00.000Z"),
    until: new Date("2026-10-05T15:00:00.000Z"),
    cursor: 0,
    limit: 100,
    ...overrides,
  });

  it("returns the five event types in KST-bounded time order with canonical inputs and saved generations", async () => {
    const sessionId = `history-${randomUUID()}`;
    await seedSession(sessionId);
    await seedEvent({ sessionId, id: 1, type: "generation_started", at: "2026-10-04T14:59:59Z", payload: { generation: 2 } });
    await seedEvent({ sessionId, id: 2, type: "user_message", at: "2026-10-04T15:00:00Z", payload: {
      input_id: "human-1", text: "사람 🧭", attachments: ["private-path"], caller_info: { source: "browser" }, context: ["private"],
    } });
    await seedEvent({ sessionId, id: 3, type: "assistant_message", at: "2026-10-04T15:00:00Z", parentEventId: 2, payload: { content: "same final" } });
    await seedEvent({ sessionId, id: 4, type: "assistant_message", at: "2026-10-04T15:00:00Z", parentEventId: 2, payload: { content: "same final" } });
    await seedEvent({ sessionId, id: 5, type: "user_message", at: "2026-10-04T14:58:00Z", payload: {
      input_id: "canonical-before-period", text: "이전 입력", caller_info: { source: "soul-app" },
    } });
    await seedEvent({ sessionId, id: 6, type: "intervention_sent", at: "2026-10-04T15:02:00Z", payload: {
      input_id: "canonical-before-period", text: "중복 재표현", caller_info: { source: "agent" },
    } });
    await seedEvent({ sessionId, id: 7, type: "intervention_sent", at: "2026-10-04T15:03:00Z", payload: {
      input_id: "agent-only", text: "개입", caller_info: { source: "agent", agent_id: "seosoyoung" }, purpose: "cache_keepalive",
    } });
    await seedEvent({ sessionId, id: 8, type: "user_message", at: "2026-10-04T15:04:00Z", payload: {
      input_id: "human-2", text: "same final", caller_info: { source: "api" },
    } });
    await seedEvent({ sessionId, id: 9, type: "user_message", at: "2026-10-04T15:05:00Z", payload: {
      input_id: "attachment-only", attachments: ["private-path"], caller_info: {},
    } });
    await seedEvent({ sessionId, id: 10, type: "session_notification", at: "2026-10-04T15:06:00Z", payload: {
      source: "completion_notifier", delivery_id: "delivery-1", delivery_intent: "completion_notification", text: "완료",
    } });
    await seedEvent({ sessionId, id: 11, type: "generation_started", at: "2026-10-04T15:07:00Z", payload: {
      generation: 3, reason: "model_change", previous: { model_preset: "claude-opus", backend: "claude", model: "opus-4" },
      current: { model_preset: "codex-6.1-sol", backend: "codex", model: "gpt-6-sol" }, context_reset: true,
    } });
    await seedEvent({ sessionId, id: 12, type: "assistant_message", at: "2026-10-04T15:08:00Z", payload: { content: "새 세대 답변" } });
    await seedEvent({ sessionId, id: 13, type: "user_message", at: "2026-10-05T15:00:00Z", payload: { text: "끝 제외" } });
    await seedEvent({ sessionId, id: 14, type: "user_message", at: "2026-10-04T15:10:00Z", payload: { text: "event id later, time earlier" } });
    await seedEvent({ sessionId, id: 15, type: "user_message", at: "2026-10-04T15:09:00Z", payload: { text: "event id earlier, time later" } });
    await seedEvent({ sessionId, id: 16, type: "tool_start", at: "2026-10-04T15:11:00Z", payload: { text: "excluded" } });

    const result = await repository.readPersistentSessionHistory(query(sessionId));
    expect(result.rows.map((event) => event.id)).toEqual([2, 3, 4, 7, 8, 9, 10, 11, 12, 15, 14]);
    expect(result.rows.find((event) => event.id === 2)?.generation).toBe(2);
    expect(result.rows.find((event) => event.id === 12)?.generation).toBe(3);
    expect(result.rows.find((event) => event.id === 7)?.payload).toMatchObject({ input_id: "agent-only" });
    expect(result.rows.find((event) => event.id === 13)).toBeUndefined();
    expect(result.rows.find((event) => event.id === 16)).toBeUndefined();
    expect(result.nextCursor).toBeNull();
  });

  it("uses a time-and-id cursor, returns limit plus one as a continuation, and rejects invalid cursors", async () => {
    const sessionId = `cursor-${randomUUID()}`;
    const otherSessionId = `other-${randomUUID()}`;
    await seedSession(sessionId);
    await seedSession(otherSessionId);
    await seedEvent({ sessionId, id: 1, type: "assistant_message", at: "2026-10-04T15:03:00Z", payload: { content: "three" } });
    await seedEvent({ sessionId, id: 2, type: "assistant_message", at: "2026-10-04T15:01:00Z", payload: { content: "one" } });
    await seedEvent({ sessionId, id: 3, type: "assistant_message", at: "2026-10-04T15:02:00Z", payload: { content: "two" } });
    await seedEvent({ sessionId, id: 4, type: "assistant_message", at: "2026-10-04T15:04:00Z", payload: { content: "four" } });
    await seedEvent({ sessionId, id: 5, type: "assistant_message", at: "2026-10-04T15:05:00Z", payload: { content: "five" } });
    await seedEvent({ sessionId: otherSessionId, id: 99, type: "assistant_message", at: "2026-10-04T15:01:00Z", payload: { content: "other" } });

    const first = await repository.readPersistentSessionHistory(query(sessionId, { limit: 2 }));
    expect(first.rows.map((event) => event.id)).toEqual([2, 3]);
    expect(first.nextCursor).toBe(3);
    const second = await repository.readPersistentSessionHistory(query(sessionId, { limit: 2, cursor: first.nextCursor! }));
    expect(second.rows.map((event) => event.id)).toEqual([1, 4]);
    expect(second.nextCursor).toBe(4);
    const third = await repository.readPersistentSessionHistory(query(sessionId, { limit: 2, cursor: second.nextCursor! }));
    expect(third.rows.map((event) => event.id)).toEqual([5]);
    expect(third.nextCursor).toBeNull();
    await expect(repository.readPersistentSessionHistory(query(sessionId, { cursor: 999 }))).rejects.toThrow();
    await expect(repository.readPersistentSessionHistory(query(sessionId, { cursor: 99 }))).rejects.toThrow();
  });
});
