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

  it("신규 task attachmentPaths → user_message.attachments 보존 + 이미지 path는 engine params로 전달", async () => {
    const mocks = makeMocks();
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.attachmentPaths = ["/tmp/incoming/sess/a.jpeg", "/tmp/incoming/sess/readme.txt"];
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.jpeg"]);
    expect(mocks.persistEvent.mock.calls[0][1]).toMatchObject({
      type: "user_message",
      attachments: ["/tmp/incoming/sess/a.jpeg", "/tmp/incoming/sess/readme.txt"],
    });
  });

  it("task.reasoningEffort를 engine.execute params로 전달한다", async () => {
    const mocks = makeMocks();
    let capturedReasoningEffort: string | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedReasoningEffort = params.reasoningEffort;
        yield { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
    );
    const task = makeTask();
    task.reasoningEffort = "low";
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedReasoningEffort).toBe("low");
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

  // === B-7: 피위임 완료 회송 (CompletionNotifier 주입 회귀) ===

  it("B-7: callerSessionId 있고 notifier 주입 시 finalize 후 notify 1회 호출", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_delta", text: "child result", timestamp: 1 } as SSEEventPayload,
      { type: "text_end", timestamp: 2 } as SSEEventPayload,
    ];
    const notify = vi.fn().mockResolvedValue(undefined);
    const notifier = { notify };
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      notifier,
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(task);
  });

  it("B-7: callerSessionId 없으면 notifier 주입되어도 notify 호출 안 됨", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    const notify = vi.fn().mockResolvedValue(undefined);
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      { notify },
    );
    const task = makeTask();
    // callerSessionId 미설정
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(notify).not.toHaveBeenCalled();
  });

  it("B-7: notifier 미주입(legacy) — finalize 정상 + notify 의존성 없음", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      // contextBuilder, completionNotifier 모두 미주입 (기존 테스트 회귀)
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";  // 있어도 notifier 없으면 호출 안 됨
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(task.status).toBe("completed");
    expect(mocks.emitSessionUpdated).toHaveBeenCalled();
  });

  it("B-7: notifier.notify가 throw해도 finalize는 격리 (task.status 그대로)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-1" } as SSEEventPayload,
      { type: "text_end", timestamp: 1 } as SSEEventPayload,
    ];
    // notifier가 throw — 운영 시 발생하면 안 되지만 안전망 검증
    const notify = vi.fn().mockRejectedValue(new Error("notifier boom"));
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      { notify },
    );
    const task = makeTask();
    task.callerSessionId = "parent-sess-1";
    executor.startExecution(task, agent);

    // executionPromise는 정상 resolve (finalize에서 throw 격리됨)
    await expect(task.executionPromise).resolves.toBeUndefined();
    expect(task.status).toBe("completed");
    expect(notify).toHaveBeenCalledTimes(1);
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

  it("P1-3: turn 진행 중 intervention 도착 후 turn throw → interventionQueue 미처리 메시지 wire error 이벤트 발행 + queue 정리", async () => {
    // 사용자가 인터벤션을 보냈는데(intervention_sent broadcast 수신) 그 직후 turn이 throw하면
    // 메시지가 silent로 사라진다. 사용자에게 명시 error 이벤트로 통지하여 재전송 결정 가능하게 한다.
    // B-5 P0 fix 반영: queue가 비어있는 신규 task로 시작 → engine generator 진행 중 push →
    // generator throw → catch 분기에서 queue 비어있지 않으면 error 발행 (PR #52 의도 유지).
    const mocks = makeMocks();
    const task = makeTask();

    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(): AsyncIterable<SSEEventPayload> {
        // 첫 yield 후 외부 intervention 도착 시뮬레이션
        yield { type: "session", session_id: "thr-1" } as SSEEventPayload;
        task.interventionQueue.push({ text: "pending", user: "u" });
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

// ride-along 5자리: `_event_id` envelope 운반 (Ft1NJquP — Python `task_executor.py:248` 정합)
describe("TaskExecutor _processEvent — _event_id ride-along (Python L248 정합)", () => {
  // 분석 캐시 `20260518-1338-codex-live-event-id-race.md`: persistEvent에서 받은 id를 event dict에
  // `_event_id`로 박은 뒤 broadcast. orch session_events.py가 SSE id로 추출하여 대시보드
  // tree-placer가 dedup·순서 보장. 누락 시 모든 live 이벤트가 eventId=0으로 같은 키 취급되어
  // text_start skip → text_delta/end 미박힘 (라이브 결함 root cause).

  it("매 event broadcast envelope에 _event_id가 박힌다 (persistEvent eventId 정합)", async () => {
    const mocks = makeMocks();  // persistEvent가 nextEventId++ 반환
    const events: SSEEventPayload[] = [
      { type: "session", session_id: "thr-x" } as SSEEventPayload,
      { type: "text_start", timestamp: 1 } as SSEEventPayload,
      { type: "text_delta", text: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // user_message + 4 turn events = 5 emit
    const emitCalls = mocks.emitEventEnvelope.mock.calls;
    // 모든 envelope event payload에 _event_id (number) 있음
    for (const call of emitCalls) {
      const payload = call[1] as Record<string, unknown>;
      expect(payload._event_id).toEqual(expect.any(Number));
    }
  });

  it("persistEvent throw → _event_id 미박힘 + broadcast는 계속 (격리)", async () => {
    const mocks = makeMocks();
    // user_message persist는 성공, 첫 turn event persist는 실패하도록 시뮬레이션
    let callCount = 0;
    mocks.persistEvent.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) throw new Error("events db down");
      return callCount;
    });
    const events: SSEEventPayload[] = [
      { type: "text_delta", text: "hi", timestamp: 1 } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // text_delta는 persist throw — _event_id 없음. complete는 성공 — _event_id 있음.
    const textDeltaCall = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "text_delta",
    );
    expect(textDeltaCall).toBeDefined();
    expect((textDeltaCall![1] as Record<string, unknown>)._event_id).toBeUndefined();

    const completeCall = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "complete",
    );
    expect(completeCall).toBeDefined();
    expect((completeCall![1] as Record<string, unknown>)._event_id).toEqual(expect.any(Number));
  });
});

// B-5: 초기 system_message + user_message 영속화 (Python `_persist_initial_messages` 정합)
// 본 describe는 contextBuilder 미주입(legacy) 흐름. system_message·user_message.context는
// 별 describe(`TaskExecutor _persistInitialMessages with contextBuilder`)에서 검증.
describe("TaskExecutor _persistInitialMessages — contextBuilder 미주입 (legacy)", () => {
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

  it("auto-resume task (queue에 메시지 push된 상태로 startExecution) → user_message 영속화 *건너뜀* (B-5 P0 fix)", async () => {
    // queue 있는 task는 *auto-resume 흐름* — intervention_sent는 addIntervention에서 이미
    // 영속화됐고 task.prompt는 prior turn에서 처리된 원래 발화. user_message 추가 영속화 시
    // events 타임라인 어그러짐 (intervention_sent → 원래 prompt user_message 중복).
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const executor = new TaskExecutor(() => makeFakeEngine(events), mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({ text: "second turn", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;

    // user_message는 *0회* (auto-resume 흐름이므로 intervention_sent로만 처리)
    const userMessages = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMessages.length).toBe(0);
  });

  it("auto-resume task: 첫 turn prompt = queue dequeue.text (task.prompt 재실행 안 함)", async () => {
    // P0 fix 핵심 회귀: queue 있는 task는 첫 turn engine.execute에 *queue 메시지*를 prompt로 전달.
    // task.prompt는 prior turn에서 이미 codex thread에 처리된 원래 발화 — 재실행하면 중복 응답.
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt: string | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();  // task.prompt = "hi" (원래 prompt)
    task.interventionQueue.push({ text: "new message", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;
    expect(capturedPrompt).toBe("new message");  // task.prompt="hi"가 아니라 queue dequeue
  });

  it("auto-resume attachmentPaths → 이미지 attachment는 EngineExecuteParams.imageAttachmentPaths로 전달", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt = "";
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({
      text: "이 파일 보여?",
      user: "u",
      attachmentPaths: ["/tmp/incoming/sess/a.png"],
    });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedPrompt).toBe("이 파일 보여?");
    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
  });

  it("auto-resume attachmentPaths → 비이미지는 attached_files context에 남고 이미지만 분리된다", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    let capturedPrompt = "";
    let capturedImageAttachmentPaths: string[] | undefined;
    const engine: EnginePort = {
      backendId: "codex",
      workspaceDir: "/tmp/codex-default",
      async *execute(params): AsyncIterable<SSEEventPayload> {
        capturedPrompt = params.prompt;
        capturedImageAttachmentPaths = params.imageAttachmentPaths;
        for (const e of events) yield e;
      },
      async interrupt() { return true; },
      async close() {},
    };
    const executor = new TaskExecutor(() => engine, mocks.db, mocks.persistence, mocks.broadcaster, silentLogger);
    const task = makeTask();
    task.interventionQueue.push({
      text: "첨부 확인",
      user: "u",
      attachmentPaths: ["/tmp/incoming/sess/a.png", "/tmp/incoming/sess/readme.txt"],
    });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(capturedImageAttachmentPaths).toEqual(["/tmp/incoming/sess/a.png"]);
    expect(capturedPrompt).toContain("<attached_files>");
    expect(capturedPrompt).not.toContain("/tmp/incoming/sess/a.png");
    expect(capturedPrompt).toContain("/tmp/incoming/sess/readme.txt");
    expect(capturedPrompt.endsWith("첨부 확인")).toBe(true);
  });
});

// B-6 정정: contextBuilder 주입 흐름에서 system_message 영속화 + user_message.context 박힘
// (Python `_persist_initial_messages` 복수형 정합). 분석 캐시
// `20260518-0945-codex-context-mcp-cancel.md` Part A-3a wire emit 누락 root cause 해소.
describe("TaskExecutor _persistInitialMessages — contextBuilder 주입 (Python 복수형 정합)", () => {
  // contextBuilder mock 헬퍼 — build() 반환을 직접 제어
  function makeFakeContextBuilder(
    ctx: {
      effectiveSystemPrompt?: string;
      combinedContextItems: Array<{ key: string; label: string; content: unknown }>;
      assembledPrompt: string;
    },
  ): {
    build: ReturnType<typeof vi.fn>;
  } {
    return {
      build: vi.fn(async () => ctx),
    };
  }

  it("effectiveSystemPrompt 있음 → system_message 이벤트 영속화 + broadcast (Python L133-146)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "you are codex",
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // persistEvent 첫 호출은 system_message (Python 순서 — system_message 먼저, user_message 다음).
    // payload는 *strict equal* {type, text} 2키만 — Python L136-139·soul-ui SystemMessageEvent 정합.
    // 추가 키(timestamp 등) 잔존 회귀를 차단한다.
    const calls = mocks.persistEvent.mock.calls;
    const sysCall = calls.find((c) => (c[1] as { type: string }).type === "system_message");
    expect(sysCall).toBeDefined();
    // ride-along 5자리 — persist 직후 _event_id가 박히고 mock은 reference 저장이므로
    // strict equal에 _event_id가 포함됨. Python `task_executor.py:141` 정합.
    expect(sysCall![1]).toEqual({
      type: "system_message",
      text: "you are codex",
      _event_id: expect.any(Number),
    });
    // broadcast envelope도 strict equal — 영속과 wire 양쪽에서 형상 정합 (_event_id 포함)
    const sysEnvelope = mocks.emitEventEnvelope.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysEnvelope).toBeDefined();
    expect(sysEnvelope![1]).toEqual({
      type: "system_message",
      text: "you are codex",
      _event_id: expect.any(Number),
    });
  });

  it("effectiveSystemPrompt 없음 → system_message 영속화 skip (Python L134 가드 정합)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      // effectiveSystemPrompt undefined
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
  });

  it("combinedContextItems 있음 → user_message 페이로드에 context 키 박힘 (Python L155)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const items = [
      { key: "soulstream_session", label: "Soulstream 세션 정보", content: { foo: 1 } },
      { key: "atom_context", label: "atom 트리", content: "# tree\n..." },
    ];
    const fakeBuilder = makeFakeContextBuilder({
      combinedContextItems: items,
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userCall).toBeDefined();
    expect((userCall![1] as Record<string, unknown>).context).toEqual(items);
  });

  it("combinedContextItems 빈 배열 → user_message에 context 키 미박힘", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      combinedContextItems: [],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect((userCall![1] as Record<string, unknown>).context).toBeUndefined();
  });

  it("system_message + user_message 순서 — system_message가 먼저 (Python 정합)", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "sys",
      combinedContextItems: [{ key: "k", label: "L", content: "c" }],
      assembledPrompt: "hi",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    const types = mocks.persistEvent.mock.calls.map((c) => (c[1] as { type: string }).type);
    const sysIdx = types.indexOf("system_message");
    const userIdx = types.indexOf("user_message");
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(sysIdx);
  });

  it("contextBuilder.build throw → ctx 격리 후 task.prompt 그대로 첫 turn 실행", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = {
      build: vi.fn(async () => {
        throw new Error("atom HTTP timeout");
      }),
    };
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    executor.startExecution(task, agent);
    await task.executionPromise;

    // ctx 격리 → system_message 영속화 0회, user_message.context 키 미박힘 (legacy 동작)
    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
    const userCall = mocks.persistEvent.mock.calls.find(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect((userCall![1] as Record<string, unknown>).context).toBeUndefined();
    expect(task.status).toBe("completed");  // 본 task 진행에 영향 0
  });

  it("auto-resume (queue 비어있지 않음) → contextBuilder.build 자체 호출 안 함", async () => {
    const mocks = makeMocks();
    const events: SSEEventPayload[] = [
      { type: "complete", usage: {}, timestamp: 1 } as SSEEventPayload,
    ];
    const fakeBuilder = makeFakeContextBuilder({
      effectiveSystemPrompt: "sys",
      combinedContextItems: [{ key: "k", label: "L", content: "c" }],
      assembledPrompt: "queued",
    });
    const executor = new TaskExecutor(
      () => makeFakeEngine(events),
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      fakeBuilder as unknown as Parameters<typeof TaskExecutor>[5],
    );
    const task = makeTask();
    task.interventionQueue.push({ text: "queued", user: "u" });
    executor.startExecution(task, agent);
    await task.executionPromise;

    expect(fakeBuilder.build).not.toHaveBeenCalled();
    // system_message·user_message 영속화도 0회 (auto-resume 흐름)
    const sysCalls = mocks.persistEvent.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "system_message",
    );
    expect(sysCalls.length).toBe(0);
  });
});
