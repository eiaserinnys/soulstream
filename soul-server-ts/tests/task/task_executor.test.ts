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

    expect(mocks.persistEvent).toHaveBeenCalledTimes(3);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(3);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(3);

    expect(task.status).toBe("completed");
    expect(task.lastEventId).toBe(3);  // persistEvent가 1, 2, 3 반환
    expect(task.codexThreadId).toBe("thr-1");  // session 이벤트에서 박힘
    expect(task.completedAt).toBeInstanceOf(Date);
    expect(task.engine).toBeUndefined();  // _finalize에서 cleanup

    expect(mocks.updateSession).toHaveBeenCalledWith("sess-1", {
      status: "completed",
      last_event_id: 3,
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
      last_event_id: 1,
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

    // 첫 persistEvent throw에도 status=completed (격리)
    expect(task.status).toBe("completed");
    expect(mocks.persistEvent).toHaveBeenCalledTimes(2);
    expect(mocks.emitEventEnvelope).toHaveBeenCalledTimes(2);
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
    // 두 이벤트 모두 처리됨 (첫 handleSideEffects throw에도 다음 이벤트 진행)
    expect(mocks.persistEvent).toHaveBeenCalledTimes(2);
    expect(mocks.handleSideEffects).toHaveBeenCalledTimes(2);
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
    expect(mocks.persistEvent).toHaveBeenCalledTimes(2);  // 두 이벤트 모두 처리
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
