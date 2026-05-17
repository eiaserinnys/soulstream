/**
 * Phase B-3 통합 테스트 — mock orch ws + fake EnginePort + mock postgres → end-to-end create_session.
 *
 * 흐름: dispatcher.dispatch(create_session) → task_manager.createTask → task_executor.startExecution
 *  → engine.execute drain → 매 event마다 persistEvent + emitEventEnvelope + handleSideEffects
 *  → 완료 시 session_updated broadcast
 *
 * 검증:
 *   - session_register stored proc 호출 (DB)
 *   - session_created wire 발행 (orch)
 *   - SSE event envelope 시퀀스 발행 (text_start → text_delta → text_end)
 *   - session_updated wire 발행 (완료 시)
 *   - lastAssistantText 누적
 */

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB, SqlClient } from "../../src/db/session_db.js";
import { SessionDB as SessionDBClass } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import { CommandDispatcher } from "../../src/upstream/dispatcher.js";
import { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

const codexAgent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

interface MockCall {
  fragments: string[];
  values: unknown[];
}

function createMockSql(resultFor?: (call: MockCall) => unknown[]) {
  const calls: MockCall[] = [];
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: MockCall = { fragments: Array.from(strings), values };
    calls.push(call);
    return Promise.resolve(resultFor ? resultFor(call) : []);
  }) as unknown as SqlClient & { array: (a: unknown[]) => unknown[]; end: () => Promise<void> };
  fn.array = (a) => a;
  fn.end = vi.fn().mockResolvedValue(undefined);
  return { sql: fn as unknown as SqlClient, calls };
}

/** event_append 호출은 점진적 event_id 반환, 나머지는 빈 결과. */
function makeStoredProcMock() {
  let counter = 0;
  return createMockSql((call) => {
    const fragText = call.fragments.join("?");
    if (fragText.includes("event_append")) {
      counter++;
      return [{ event_append: counter }];
    }
    return [];
  });
}

function makeFakeEngine(events: SSEEventPayload[]): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {
      for (const e of events) yield e;
    },
    async interrupt() { return true; },
    async close() {},
  };
}

describe("Phase B-3 E2E: create_session → engine drain → broadcast", () => {
  it("정상 흐름 — session_created + event envelopes + session_updated 시퀀스", async () => {
    // mock orch — broadcast 메시지 캡처
    const orchReceived: Record<string, unknown>[] = [];
    const send = vi.fn(async (data: unknown) => {
      orchReceived.push(data as Record<string, unknown>);
    });

    // mock postgres — 모든 stored proc 호출 캡처
    const { sql, calls: dbCalls } = makeStoredProcMock();
    const db = new SessionDBClass(sql);

    const registry = new AgentRegistry([codexAgent]);

    // fake Codex events: thread.started → text_start → text_delta(누적) → text_end → complete
    const codexEvents: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_start", timestamp: 1 } as SSEEventPayload,
      { type: "text_delta", text: "Hello", timestamp: 2 } as SSEEventPayload,
      { type: "text_delta", text: "Hello world", timestamp: 3 } as SSEEventPayload,
      { type: "text_end", timestamp: 4 } as SSEEventPayload,
      {
        type: "complete",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 0,
        },
        timestamp: 5,
      } as SSEEventPayload,
    ];

    const broadcaster = new SessionBroadcaster(send, registry, "eias-shopping-ts");
    const persistence = new EventPersistence(db, broadcaster, silentLogger);
    const taskManager = new TaskManager("eias-shopping-ts", db, broadcaster, silentLogger);

    const factory = vi.fn(() => makeFakeEngine(codexEvents));
    const taskExecutor = new TaskExecutor(
      factory,
      db,
      persistence,
      broadcaster,
      silentLogger,
    );

    const dispatcher = new CommandDispatcher(
      send,
      silentLogger,
      "eias-shopping-ts",
      registry,
      taskManager,
      taskExecutor,
    );

    // === ACT — orch가 create_session 보냄 ===
    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "sess-e2e-1",
      prompt: "hello codex",
      profile: "codex-default",
      requestId: "req-1",
    });

    // task 진행 대기
    const task = taskManager.getTask("sess-e2e-1");
    expect(task).toBeDefined();
    await task!.executionPromise;

    // === ASSERT — orch에 발행된 wire 시퀀스 ===
    const wireTypes = orchReceived.map((m) => m.type);
    expect(wireTypes).toContain("session_created");
    expect(wireTypes).toContain("event");
    expect(wireTypes).toContain("session_updated");

    // session_created가 첫 broadcast (event ack가 그 뒤 또는 같이)
    const createdIdx = orchReceived.findIndex((m) => m.type === "session_created" && m.session);
    expect(createdIdx).toBeGreaterThanOrEqual(0);
    const created = orchReceived[createdIdx];
    expect((created.session as Record<string, unknown>).agent_session_id).toBe("sess-e2e-1");
    expect((created.session as Record<string, unknown>).agentId).toBe("codex-default");
    expect((created.session as Record<string, unknown>).backend).toBe("codex");

    // session_created ACK (requestId 박힘)
    const ack = orchReceived.find((m) => m.type === "session_created" && m.requestId === "req-1");
    expect(ack?.agentSessionId).toBe("sess-e2e-1");

    // event envelopes — B-5: 첫 envelope는 user_message(초기 영속화), 그 다음 codexEvents
    const envelopes = orchReceived.filter((m) => m.type === "event");
    expect(envelopes.length).toBe(codexEvents.length + 1);  // +user_message
    expect((envelopes[0].event as Record<string, unknown>).type).toBe("user_message");
    expect((envelopes[1].event as Record<string, unknown>).type).toBe("session");
    expect((envelopes[2].event as Record<string, unknown>).type).toBe("text_start");
    expect((envelopes[3].event as Record<string, unknown>).type).toBe("text_delta");
    expect((envelopes[4].event as Record<string, unknown>).type).toBe("text_delta");
    expect((envelopes[5].event as Record<string, unknown>).type).toBe("text_end");
    expect((envelopes[6].event as Record<string, unknown>).type).toBe("complete");

    // session_updated 완료 시 1회 (status=completed)
    const updated = orchReceived.filter((m) => m.type === "session_updated");
    expect(updated.length).toBeGreaterThanOrEqual(1);
    const finalUpdate = updated[updated.length - 1];
    expect(finalUpdate.status).toBe("completed");
    expect(finalUpdate.last_assistant_text).toBe("Hello world");  // 누적 text_delta

    // === ASSERT — DB stored proc 호출 ===
    const procNames = dbCalls.map((c) => c.fragments.join("?"));
    expect(procNames.some((p) => p.includes("session_register"))).toBe(true);
    // B-5: user_message 영속(1) + codexEvents
    expect(procNames.filter((p) => p.includes("event_append")).length).toBe(codexEvents.length + 1);
    expect(procNames.some((p) => p.includes("session_update"))).toBe(true);

    // F-3B: session_set_claude_id 1회 호출 (thread id 영속화)
    expect(
      procNames.filter((p) => p.includes("session_set_claude_id")).length,
    ).toBe(1);

    // F-3A: emit_session_message_updated wire — PREVIEW_FIELD_MAP 매칭 + 필드 값 있을 때만.
    // codexEvents 중: text_delta(×2 — "Hello", "Hello world")만 wire 발행.
    // B-5: user_message(1)도 PREVIEW_FIELD_MAP.user_message="text" 매칭으로 last_message 갱신.
    // complete은 PREVIEW_FIELD_MAP에서 result 필드를 보지만 본 fixture는 result 미포함 → skip.
    // text_start/text_end/session은 매핑 없음 → skip.
    // 이 wire는 `last_message` 키 보유로 식별 (G-19 마커).
    const messageUpdates = orchReceived.filter(
      (m) => m.type === "session_updated" && m.last_message !== undefined,
    );
    expect(messageUpdates.length).toBe(3);  // user_message + text_delta x 2
    expect(
      (messageUpdates[2].last_message as Record<string, unknown>).preview,
    ).toBe("Hello world");

    // task 상태
    expect(task!.status).toBe("completed");
    expect(task!.codexThreadId).toBe("thr-codex-1");
    expect(task!.lastEventId).toBe(codexEvents.length + 1);  // +user_message
    expect(task!.lastAssistantText).toBe("Hello world");
  });

  it("Unknown agent profile → error 응답, task·DB·broadcast 없음", async () => {
    const orchReceived: unknown[] = [];
    const send = vi.fn(async (data) => {
      orchReceived.push(data);
    });
    const { sql, calls: dbCalls } = makeStoredProcMock();
    const db = new SessionDBClass(sql);
    const registry = new AgentRegistry([codexAgent]);
    const broadcaster = new SessionBroadcaster(send, registry, "n");
    const persistence = new EventPersistence(db, broadcaster, silentLogger);
    const taskManager = new TaskManager("n", db, broadcaster, silentLogger);
    const factory = vi.fn();
    const taskExecutor = new TaskExecutor(factory, db, persistence, broadcaster, silentLogger);
    const dispatcher = new CommandDispatcher(
      send, silentLogger, "n", registry, taskManager, taskExecutor,
    );

    await dispatcher.dispatch({
      type: "create_session",
      agentSessionId: "x",
      prompt: "y",
      profile: "nonexistent",
      requestId: "r",
    });

    expect(orchReceived).toHaveLength(1);
    expect((orchReceived[0] as { type: string }).type).toBe("error");
    expect(dbCalls).toHaveLength(0);
    expect(factory).not.toHaveBeenCalled();
    expect(taskManager.listTasks()).toHaveLength(0);
  });
});
