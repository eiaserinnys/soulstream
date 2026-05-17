import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { TaskExecutor, isTerminalStatus } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

/** AsyncIterable로 주어진 이벤트 시퀀스를 yield하는 fake EnginePort. */
function makeFakeEngine(
  events: SSEEventPayload[],
  opts: { throwAt?: number } = {},
): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {
      const total = Math.max(events.length, (opts.throwAt ?? -1) + 1);
      for (let i = 0; i < total; i++) {
        if (opts.throwAt === i) throw new Error("engine boom");
        if (i < events.length) yield events[i];
      }
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeTask(): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "hi",
    status: "running",
    profileId: agent.id,
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeMocks() {
  let nextEventId = 0;
  const persistEvent = vi.fn(async () => ++nextEventId);
  const handleSideEffects = vi.fn(async () => undefined);
  const persistence = { persistEvent, handleSideEffects } as unknown as EventPersistence;

  const updateSession = vi.fn().mockResolvedValue(undefined);
  const setClaudeSessionId = vi.fn().mockResolvedValue(undefined);
  const db = { updateSession, setClaudeSessionId } as unknown as SessionDB;

  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = { emitEventEnvelope, emitSessionUpdated } as unknown as SessionBroadcaster;

  return {
    persistence,
    db,
    broadcaster,
    persistEvent,
    handleSideEffects,
    updateSession,
    setClaudeSessionId,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

describe("TaskExecutor.startExecution", () => {
  it("정상 흐름: 모든 이벤트 persist + broadcast + side effect + 완료 후 session_updated", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "hello", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
    ];
    const engine = makeFakeEngine(events);
    const factory = vi.fn(() => engine);

    const executor = new TaskExecutor(
      factory,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // B-5: turn 진입 *전* user_message 영속화(1건) + 엔진 이벤트(3건) = 총 4건.
    expect(mocks.persistEvent).toHaveBeenCalledTimes(4);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(4);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(4);

    // 첫 persistEvent는 user_message 영속화
    expect(mocks.persistEvent.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      text: "hi",
    });

    expect(task.status).toBe("completed");
    expect(task.lastEventId).toBe(4);  // user_message(1) + 엔진 3건 = 4
    expect(task.codexThreadId).toBe("thr-1");
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.engine).toBeUndefined();

    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", {
      status: "completed",
      last_event_id: 4,
    });
    expect(mocks.emitSessionUpdated).toHaveBeenCalledWith(task);
  });

  it("engine.execute throw → status=error + finalize", async () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine(
      [{ type: "session", session_id: "thr-1" } as SSEEventPayload],
      { throwAt: 1 },  // index 1에서 throw — 첫 yield는 통과
    );
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.error).toContain("engine boom");
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", {
      status: "error",
      last_event_id: 2,  // B-5: user_message(1) + session(2)
    });
  });

  it("persistEvent 실패는 격리 (계속 진행)", async () => {
    const mocks = makeMocks();
    mocks.persistEvent.mockImplementationOnce(async () => {
      throw new Error("db down");
    });
    mocks.persistEvent.mockImplementation(async () => 99);

    const events: SSEEventPayload[] = [
      { type: "text_delta", text: "a", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // 첫 persistEvent throw(user_message 영속화)에도 status=completed (격리)
    // user_message(1, throw) + text_delta(2) + text_end(3) = 3건 호출
    expect(task.status).toBe("completed");
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    // emitEventEnvelope는 user_message + 2건 = 3건 (persistEvent throw에도 broadcast는 호출됨)
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(3);
  });

  it("session 이벤트의 session_id가 task.codexThreadId에 박힘 (1회만)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-first" } as SSEEventPayload,
      { type: "session", session_id: "thr-second" } as SSEEventPayload,  // 두 번째는 무시
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.codexThreadId).toBe("thr-first");
  });

  // === F-3B: Codex thread id DB 영속화 ===

  it("F-3B T6: 첫 session 이벤트 시 db.setClaudeSessionId 호출 + 두 번째 session 이벤트는 호출 안 함", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_delta", text: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "session", session_id: "thr-codex-2" } as SSEEventPayload,  // 두 번째 session은 무시 (가드)
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // 메모리: 첫 thread id만 박힘 (기존 동작 유지)
    expect(task.codexThreadId).toBe("thr-codex-1");

    // DB: setClaudeSessionId 정확히 1회 호출 + 첫 thread id로
    expect(mocks.setClaudeSessionId).toHaveBeenCalledTimes(1);
    expect(mocks.setClaudeSessionId).toHaveBeenCalledWith(
      "sess-1",
      "thr-codex-1",
    );
  });

  it("F-3A 회귀: handleSideEffects throw (DB 실패 등) → 격리, task 진행 계속", async () => {
    // handleSideEffects는 EventPersistence가 DB throw를 호출자에 전파한다 (Python 정합).
    // _processEvent의 try-catch가 이를 받아 task 진행을 막지 않아야 한다.
    const mocks = makeMocks();
    mocks.handleSideEffects.mockRejectedValueOnce(
      new Error("last_message db down"),
    );
    const events: SSEEventPayload[] = [
      { type: "text_delta", text: "a", timestamp: 1 } as SSEEventPayload,
      { type: "text_delta", text: "ab", timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    // user_message(1) + text_delta x 2 = 3건 (첫 handleSideEffects throw에도 다음 이벤트 진행)
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(3);
  });

  it("F-3B T7: db.setClaudeSessionId throw → 격리 (task 진행 계속, status=completed)", async () => {
    const mocks = makeMocks();
    mocks.setClaudeSessionId.mockRejectedValueOnce(
      new Error("connection refused"),
    );

    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-codex-1" } as SSEEventPayload,
      { type: "text_delta", text: "after error", timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // setClaudeSessionId throw에도 task 진행 계속
    expect(task.status).toBe("completed");
    expect(task.codexThreadId).toBe("thr-codex-1");  // 메모리 박기는 throw 전에 완료
    // user_message(1) + session(2) + text_delta(3) = 3건 모두 처리
    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
  });

  it("같은 task에 startExecution 두 번 호출 → throw", () => {
    const mocks = makeMocks();
    const engine = makeFakeEngine([]);
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    expect(() => executor.startExecution(task, agent)).toThrow(/already has an engine/);
  });

  it("interrupt 경로: cancelTask가 status='interrupted' 박은 뒤 정상 drain → completed로 안 덮임 (code-reviewer P1)", async () => {
    const mocks = makeMocks();
    // engine.execute가 *정상* 종료하는 fake (interrupt가 발생해 adapter가 yield 없이 return하는 시나리오 등가)
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "partial", timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    // task_executor가 yield 처리 *전* 외부에서 status="interrupted" 박힘 (cancelTask 시뮬)
    // 단, executionPromise가 이미 진행 중이라 micro-task 대기 후 status 설정
    await Promise.resolve();
    task.status = "interrupted";
    await task.executionPromise;
    // 정상 종료 분기의 `if (status === "running") status = "completed"`가 발동 안 함
    expect(task.status).toBe("interrupted");
    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", {
      status: "interrupted",
      last_event_id: expect.any(Number),
    });
  });

  it("engineFactory throw → status=error, finalize 호출", async () => {
    const mocks = makeMocks();
    const factory = vi.fn(() => {
      throw new Error("factory boom");
    });
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    // startExecution 자체는 engine 설정 단계에서 throw 발생 — *동기 throw*는 호출자에게 직접 전파
    expect(() => executor.startExecution(task, agent)).toThrow(/factory boom/);
    // task.engine은 설정 안 됨
    expect(task.engine).toBeUndefined();
  });
});

describe("isTerminalStatus", () => {
  it("completed/error/interrupted는 terminal", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("error")).toBe(true);
    expect(isTerminalStatus("interrupted")).toBe(true);
  });
  it("running은 non-terminal", () => {
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("TaskExecutor multi-turn (B-4)", () => {
  it("turn 종료 시 interventionQueue 비어있지 않으면 다음 turn 자동 시작 (resume)", async () => {
    // turn 1: session(thr-1) + text_delta("a") + text_end + complete
    // turn 종료 후 task.interventionQueue.push({text:"continue"}) — 외부 큐잉 시뮬레이션
    // turn 2: text_delta("b") + text_end + complete
    // 결과 status="completed", 두 turn 모두 drain
    const mocks = makeMocks();
    const turn1: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "a", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const turn2: SSEEventPayload[] = [
      { type: "text_delta", text: "b", timestamp: 2 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    let turnCount = 0;
    const captured: { turn: number; resumeSessionId: string | undefined }[] = [];

    const task = makeTask();
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      // eslint-disable-next-line require-yield
      async *execute(params): AsyncIterable<SSEEventPayload> {
        captured.push({
          turn: turnCount,
          resumeSessionId: params?.resumeSessionId,
        });
        const events = turnCount === 0 ? turn1 : turn2;
        turnCount += 1;
        // turn 1 첫 이벤트(session) 처리 후 외부에서 큐 push를 시뮬레이션:
        // turn 1 drain이 끝나기 전에 마지막 이벤트 직후 push (concurrent 시뮬레이션 어렵지만,
        // 본 테스트는 *turn 종료 시 queue 확인* 흐름이 정합인지 보는 것이라 yield 이전 push로 등가).
        if (turnCount === 1) {
          // turn 1 끝나기 전에 queue에 push (외부 intervene이 들어왔다고 가정)
          task.interventionQueue.push({ text: "continue", user: "u" });
        }
        for (const ev of events) {
          yield ev;
        }
      },
      async interrupt() { return true; },
      async close() {},
    };
    const factory = vi.fn(() => engine);
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);

    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(turnCount).toBe(2);
    expect(captured[0].resumeSessionId).toBeUndefined();
    // 두 번째 turn은 첫 turn에서 박힌 codexThreadId로 resume
    expect(captured[1].resumeSessionId).toBe("thr-1");
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toHaveLength(0);
  });

  it("P1-3: turn throw 시 interventionQueue 미처리 메시지가 있으면 wire error 이벤트 발행 + queue 정리", async () => {
    // 사용자가 인터벤션을 보냈는데(intervention_sent broadcast 수신) 그 직후 turn이 throw하면
    // 메시지가 silent로 사라진다. 사용자에게 명시 error 이벤트로 통지하여 재전송 결정 가능하게 한다.
    const mocks = makeMocks();
    const task = makeTask();
    task.interventionQueue.push({ text: "pending", user: "u" });

    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      // eslint-disable-next-line require-yield
      async *execute(): AsyncIterable<SSEEventPayload> {
        throw new Error("engine boom");
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(task.interventionQueue).toHaveLength(0);  // 재처리 방지로 비움
    // 사용자 통지를 위한 wire error 이벤트가 broadcast됨
    const errorBroadcast = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "error" && /skipped/.test((c[1] as { message: string }).message),
    );
    expect(errorBroadcast).toBeDefined();
  });

  it("turn 종료 시 interventionQueue 비어있으면 status=completed로 종료 (단일 turn 회귀)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const factory = vi.fn(() => makeFakeEngine(events));
    const executor = new TaskExecutor(factory, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.status).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

// B-5: 초기 user_message 영속화 (Python `_persist_initial_messages` 정합)
describe("TaskExecutor _persistInitialUserMessage (B-5)", () => {
  it("첫 turn 진입 전 user_message가 persistEvent + broadcast + handleSideEffects 모두 수행", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.callerInfo = { source: "slack", display_name: "Alice" };
    executor.startExecution(task, agent);
    await task.executionPromise;

    const firstCall = mocks.persistEvent.mock.calls[0];
    expect(firstCall[0]).toBe("sess-1");  // sessionId
    expect(firstCall[1]).toMatchObject({
      type: "user_message",
      text: "hi",  // task.prompt
      user: "Alice",  // caller_info.display_name 우선
    });
    expect((firstCall[1] as Record<string, unknown>).caller_info).toEqual({
      source: "slack",
      display_name: "Alice",
    });

    // broadcast도 첫 envelope로
    const firstEnvelope = mocks.emitEventEnvelope.mock.calls[0];
    expect(firstEnvelope[0]).toBe("sess-1");
    expect((firstEnvelope[1] as Record<string, unknown>).type).toBe("user_message");
  });

  it("caller_info 미설정 → user 필드는 'unknown', caller_info 키 미박음", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();  // callerInfo 미설정
    executor.startExecution(task, agent);
    await task.executionPromise;

    const first = mocks.persistEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(first.user).toBe("unknown");
    expect(first.caller_info).toBeUndefined();
  });

  it("persistEvent throw 시 격리 — engine.execute는 정상 진행", async () => {
    const mocks = makeMocks();
    mocks.persistEvent.mockImplementationOnce(async () => {
      throw new Error("user_message db down");
    });
    mocks.persistEvent.mockImplementation(async () => 42);
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(task.status).toBe("completed");  // user_message 실패에도 task 정상 진행
  });

  it("turn-loop intervention dequeue 시점에는 user_message 추가 영속화 안 함 (multi-turn 1회만)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({ text: "second turn", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;

    // user_message는 *최초 1회*만. intervention_sent는 task_manager가 영속화 (task_manager.test.ts에서 보호).
    const userMessages = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMessages.length).toBe(1);
  });
});
