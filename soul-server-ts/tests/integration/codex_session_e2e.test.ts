/**
 * Phase 11 통합 테스트 — mock orch ws + fake EnginePort + mock outbox/postgres.
 *
 * 흐름: dispatcher.dispatch(create_session) → task_manager.createTask → task_executor.startExecution
 *  → engine.execute drain → persistent event는 outbox, transient event는 worker WS
 *  → 완료 상태는 terminal effect로 orch ingress가 broadcast
 *
 * 검증:
 *   - session_register stored proc 호출 (DB)
 *   - session_created wire 발행 (orch)
 *   - live event envelope과 durable outbox 이벤트의 분리
 *   - terminal_transition effect 발행 (완료 시)
 *   - lastAssistantText 누적
 */

import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { AgentRegistry, type AgentProfile } from "../../src/agent_registry.js";
import type { SessionMutationHost } from
  "../../src/control_plane/persistence_host_clients.js";
import { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB, SqlClient } from "../../src/db/session_db.js";
import { SessionDB as SessionDBClass } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import { CommandDispatcher } from "../../src/upstream/dispatcher.js";
import type { EventOutboxRecord } from "../../src/upstream/event_outbox.js";
import type { EventAppendAcknowledgement } from
  "../../src/upstream/event_outbox_pump.js";
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

function makeEventOutboxHarness() {
  let sourceSeq = 0;
  const append = vi.fn(async (input: Record<string, unknown>) => {
    sourceSeq += 1;
    return {
      stream_id: "stream-e2e",
      source_seq: sourceSeq,
      ...input,
      payload_hash: `${sourceSeq}`.padStart(64, "0"),
    };
  });
  const waitForAcknowledgement = vi.fn(
    async (record: { source_seq: number }) => record.source_seq,
  );
  const waitForAcknowledgementResult = vi.fn(
    async (record: EventOutboxRecord) => makeAppliedTransitionAcknowledgement(record),
  );
  return { append, waitForAcknowledgement, waitForAcknowledgementResult };
}

function makeAppliedTransitionAcknowledgement(
  record: EventOutboxRecord,
): EventAppendAcknowledgement {
  const effect = record.session_effect;
  if (!effect || ![
    "running_transition",
    "terminal_transition",
    "execution_reserve",
    "execution_prove",
    "execution_adopt_reserve",
    "execution_activate",
    "execution_fail",
    "execution_expire_dead_owner",
    "execution_retire_terminal_ownership",
    "runner_terminal_fact",
    "recovered_runner_terminal_fact",
  ].includes(effect.kind)) {
    throw new Error("transition acknowledgement requires a transition effect");
  }
  const terminal = effect.kind === "terminal_transition";
  const activated = effect.kind === "running_transition"
    || effect.kind === "execution_activate";
  const failed = effect.kind === "execution_fail"
    || effect.kind === "execution_expire_dead_owner";
  const runnerFact = "runner_fact" in effect ? effect.runner_fact : undefined;
  const runnerTerminalStatus = runnerFact === "completed"
    ? "completed"
    : runnerFact === "closed"
      ? "interrupted"
      : "error";
  const reviewState = "review_state" in effect
    ? effect.review_state
    : "not_required";
  return {
    source_seq: record.source_seq,
    event_id: record.source_seq,
    effect_application: {
      applied: true,
      canonical_session: {
        status: terminal
          ? effect.status
          : runnerFact
            ? runnerTerminalStatus
            : activated
              ? "running"
              : failed
                ? "error"
                : "initializing",
        termination_reason: terminal
          ? effect.termination_reason
          : runnerFact === "completed"
            ? "completed_ok"
            : runnerFact === "closed"
              ? "killed"
              : runnerFact
                ? "error_aborted"
                : null,
        termination_detail: "termination_detail" in effect
          ? effect.termination_detail
          : null,
        review_state: reviewState,
        last_assistant_text: "last_assistant_text" in effect
          ? effect.last_assistant_text ?? null
          : null,
        termination_event_id: terminal || runnerFact ? record.source_seq : null,
        updated_at: effect.updated_at,
        last_event_id: record.source_seq,
      },
    },
  };
}

describe("Phase B-3 E2E: create_session → engine drain → ingress effects", () => {
  it("정상 흐름 — session_created + transient envelopes + durable effects", async () => {
    // mock orch — broadcast 메시지 캡처
    const orchReceived: Record<string, unknown>[] = [];
    const send = vi.fn(async (data: unknown) => {
      orchReceived.push(data as Record<string, unknown>);
    });

    // mock postgres — 모든 stored proc 호출 캡처
    const { sql, calls: dbCalls } = makeStoredProcMock();
    const db = new SessionDBClass(sql);

    const registry = new AgentRegistry([codexAgent]);

    // fake Codex events: thread.started → live text lifecycle → assistant_message → complete
    const codexEvents: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_start", timestamp: 1 } as SSEEventPayload,
      { type: "text_delta", text: "Hello", timestamp: 2 } as SSEEventPayload,
      { type: "text_delta", text: "Hello world", timestamp: 3 } as SSEEventPayload,
      { type: "text_end", timestamp: 4 } as SSEEventPayload,
      { type: "assistant_message", content: "Hello world", timestamp: 4.5 } as SSEEventPayload,
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
    const outbox = makeEventOutboxHarness();
    const persistence = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      { append: outbox.append } as never,
      {
        waitForAcknowledgement: outbox.waitForAcknowledgement,
        waitForAcknowledgementResult: outbox.waitForAcknowledgementResult,
      } as never,
    );
    const registerSession = vi.fn(async () => undefined);
    const sessionMutations = {
      registerSession,
      transitionSession: vi.fn(async () => undefined),
      renameSession: vi.fn(async () => undefined),
      deleteSession: vi.fn(async () => undefined),
      acknowledgeReview: vi.fn(async () => "acknowledged" as const),
    } satisfies SessionMutationHost;
    const taskManager = new TaskManager(
      "eias-shopping-ts",
      db,
      broadcaster,
      silentLogger,
      persistence,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      sessionMutations,
    );

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
    expect(wireTypes).not.toContain("session_updated");

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

    // Worker WS에는 text lifecycle transient 이벤트만 직접 실린다.
    const envelopes = orchReceived.filter((m) => m.type === "event");
    expect(envelopes.map((item) => (item.event as Record<string, unknown>).type)).toEqual([
      "text_start",
      "text_delta",
      "text_delta",
      "text_end",
    ]);

    // Persistent 이벤트는 전부 outbox에 들어가고 worker가 DB나 event wire를 우회하지 않는다.
    const durableTypes = outbox.append.mock.calls.map(
      ([input]) => (input as Record<string, unknown>).event_type,
    );
    expect(durableTypes).toEqual([
      "metadata",
      "metadata",
      "metadata",
      "user_message",
      "session",
      "assistant_message",
      "complete",
      "session_ended",
    ]);

    // === ASSERT — session mutations are host/effect owned, not worker DB writes ===
    expect(registerSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-e2e-1" }),
      "register_session:sess-e2e-1",
    );
    const procNames = dbCalls.map((c) => c.fragments.join("?"));
    expect(procNames.some((p) => p.includes("session_register"))).toBe(false);
    expect(procNames.filter((p) => p.includes("event_append")).length).toBe(0);
    expect(procNames.some((p) => p.includes("session_update"))).toBe(false);
    expect(procNames.some((p) => p.includes("session_set_claude_id"))).toBe(false);
    expect(outbox.append.mock.calls.map(([input]) =>
      (input as Record<string, unknown>).session_effect)).toEqual([
      expect.objectContaining({ kind: "execution_reserve" }),
      expect.objectContaining({ kind: "execution_prove" }),
      expect.objectContaining({ kind: "execution_activate" }),
      expect.objectContaining({ kind: "last_message" }),
      { kind: "set_backend_session_id", backend_session_id: "thr-codex-1" },
      expect.objectContaining({ kind: "last_message" }),
      null,
      expect.objectContaining({
        kind: "runner_terminal_fact",
        runner_fact: "completed",
      }),
    ]);

    // task 상태
    expect(task!.status).toBe("completed");
    expect(task!.codexThreadId).toBe("thr-codex-1");
    expect(task!.lastEventId).toBe(8);
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
    const outbox = makeEventOutboxHarness();
    const persistence = new EventPersistence(
      db,
      broadcaster,
      silentLogger,
      { append: outbox.append } as never,
      {
        waitForAcknowledgement: outbox.waitForAcknowledgement,
        waitForAcknowledgementResult: outbox.waitForAcknowledgementResult,
      } as never,
    );
    const taskManager = new TaskManager("n", db, broadcaster, silentLogger, persistence);
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
