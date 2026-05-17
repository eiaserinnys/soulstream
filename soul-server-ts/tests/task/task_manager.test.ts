import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

const silentLogger = pino({ level: "silent" });

function makeMocks() {
  const registerSession = vi.fn().mockResolvedValue(undefined);
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  // B-5: 폴더 배정 정본 흐름 mocks (Python `_assign_default_folder_and_broadcast` 정합).
  const assignSessionToFolder = vi.fn().mockResolvedValue(undefined);
  const getDefaultFolder = vi
    .fn()
    .mockResolvedValue({ id: "default-claude", name: "⚙️ 클로드 코드 세션" });
  const getCatalog = vi
    .fn()
    .mockResolvedValue({ folders: [], sessions: {} });
  // PR #56: hydration mock (Python load_evicted_task 정합)
  const getSession = vi.fn().mockResolvedValue(null);
  const db = {
    registerSession,
    deleteSession,
    assignSessionToFolder,
    getDefaultFolder,
    getCatalog,
    getSession,
  } as unknown as SessionDB;

  const emitSessionCreated = vi.fn().mockResolvedValue(undefined);
  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  const emitInterventionSent = vi.fn().mockResolvedValue(undefined);
  const emitCatalogUpdated = vi.fn().mockResolvedValue(undefined);
  const emitEventEnvelope = vi.fn().mockResolvedValue(undefined);
  const emitSessionUpdated = vi.fn().mockResolvedValue(undefined);
  const broadcaster = {
    emitSessionCreated,
    emitSessionDeleted,
    emitInterventionSent,
    emitCatalogUpdated,
    emitEventEnvelope,
    emitSessionUpdated,
  } as unknown as SessionBroadcaster;

  return {
    db,
    broadcaster,
    registerSession,
    deleteSession,
    assignSessionToFolder,
    getDefaultFolder,
    getCatalog,
    getSession,
    emitSessionCreated,
    emitSessionDeleted,
    emitInterventionSent,
    emitCatalogUpdated,
    emitEventEnvelope,
    emitSessionUpdated,
  };
}

describe("TaskManager.createTask", () => {
  it("Task 생성 + DB registerSession + broadcast session_created", async () => {
    const { db, broadcaster, registerSession, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("eias-shopping-ts", db, broadcaster, silentLogger);

    const task = await tm.createTask({
      agentSessionId: "sess-1",
      prompt: "hi",
      profileId: "codex-default",
      callerInfo: { source: "slack" },
    });

    expect(task.agentSessionId).toBe("sess-1");
    expect(task.status).toBe("running");
    expect(task.profileId).toBe("codex-default");
    expect(task.createdAt).toBeInstanceOf(Date);

    expect(registerSession).toHaveBeenCalledTimes(1);
    const regArg = registerSession.mock.calls[0][0];
    expect(regArg.sessionId).toBe("sess-1");
    expect(regArg.nodeId).toBe("eias-shopping-ts");
    expect(regArg.agentId).toBe("codex-default");
    expect(regArg.sessionType).toBe("claude");
    expect(regArg.status).toBe("running");

    expect(emitSessionCreated).toHaveBeenCalledTimes(1);
    // 폴더 명시 없으면 default-claude로 자동 배정 (Python _assign_default_folder_and_broadcast 정합)
    expect(emitSessionCreated.mock.calls[0][1]).toBe("default-claude");
  });

  it("중복 agentSessionId → throw, DB·broadcast 호출 안 함", async () => {
    const { db, broadcaster, registerSession, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "dup", prompt: "x", profileId: "a" });
    expect(registerSession).toHaveBeenCalledTimes(1);

    await expect(
      tm.createTask({ agentSessionId: "dup", prompt: "y", profileId: "a" }),
    ).rejects.toThrow(/already exists/);
    expect(registerSession).toHaveBeenCalledTimes(1);  // 2번째 호출 없음
    expect(emitSessionCreated).toHaveBeenCalledTimes(1);
  });

  it("DB registerSession 실패 시 throw + in-memory 미저장", async () => {
    const { broadcaster } = makeMocks();
    const failRegister = vi.fn().mockRejectedValue(new Error("PK violation"));
    const db = {
      registerSession: failRegister,
      deleteSession: vi.fn(),
    } as unknown as SessionDB;

    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await expect(
      tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "a" }),
    ).rejects.toThrow(/PK violation/);
    expect(tm.getTask("s1")).toBeUndefined();
  });

  it("broadcast 실패해도 task는 생성 (실패 격리)", async () => {
    const { db } = makeMocks();
    const broadcaster = {
      emitSessionCreated: vi.fn().mockRejectedValue(new Error("ws closed")),
    } as unknown as SessionBroadcaster;

    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "a",
    });
    expect(task).toBeDefined();
    expect(tm.getTask("s1")?.agentSessionId).toBe("s1");
  });

  it("folderId 전달 시 emit_session_created에 그대로 박힘", async () => {
    const { db, broadcaster, emitSessionCreated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "a",
      folderId: "folder-42",
    });
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-42");
  });
});

describe("TaskManager.getTask / listTasks", () => {
  it("createTask 후 getTask로 조회 가능, listTasks에 포함", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "a", profileId: "p" });
    await tm.createTask({ agentSessionId: "s2", prompt: "b", profileId: "p" });

    expect(tm.getTask("s1")?.prompt).toBe("a");
    expect(tm.getTask("s2")?.prompt).toBe("b");
    expect(tm.getTask("nonexistent")).toBeUndefined();
    expect(tm.listTasks().map((t) => t.agentSessionId).sort()).toEqual(["s1", "s2"]);
  });
});

describe("TaskManager.cancelTask", () => {
  it("진행 중 engine이 있으면 interrupt 호출 + status='interrupted' 박힘 + true 반환", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;

    expect(task.status).toBe("running");
    const result = await tm.cancelTask("s1");
    expect(result).toBe(true);
    expect(task.status).toBe("interrupted");  // code-reviewer P1 정정
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("없는 sessionId → false (silent return 아님 — 반환값으로 신호)", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    expect(await tm.cancelTask("nonexistent")).toBe(false);
  });

  it("이미 completed task → false", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    task.status = "completed";
    task.engine = { interrupt: vi.fn() } as unknown as EnginePort;
    expect(await tm.cancelTask("s1")).toBe(false);
  });
});

describe("TaskManager.deleteTask", () => {
  it("메모리 제거 + DB deleteSession + broadcast session_deleted", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });

    await tm.deleteTask("s1");
    expect(tm.getTask("s1")).toBeUndefined();
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });

  it("진행 중 task → interrupt + drain + cleanup", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const interrupt = vi.fn().mockResolvedValue(true);
    task.engine = { interrupt } as unknown as EnginePort;
    task.executionPromise = Promise.resolve();

    await tm.deleteTask("s1");
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(deleteSession).toHaveBeenCalledWith("s1");
    expect(emitSessionDeleted).toHaveBeenCalledWith("s1");
  });

  it("없는 sessionId → silent (no-op)", async () => {
    const { db, broadcaster, deleteSession, emitSessionDeleted } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.deleteTask("nonexistent");
    expect(deleteSession).not.toHaveBeenCalled();
    expect(emitSessionDeleted).not.toHaveBeenCalled();
  });
});

describe("TaskManager.shutdown", () => {
  it("모든 running task interrupt + drain", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const t1 = await tm.createTask({ agentSessionId: "s1", prompt: "x", profileId: "p" });
    const t2 = await tm.createTask({ agentSessionId: "s2", prompt: "y", profileId: "p" });
    const int1 = vi.fn().mockResolvedValue(true);
    const int2 = vi.fn().mockResolvedValue(true);
    t1.engine = { interrupt: int1 } as unknown as EnginePort;
    t2.engine = { interrupt: int2 } as unknown as EnginePort;
    t1.executionPromise = Promise.resolve();
    t2.executionPromise = Promise.resolve();

    await tm.shutdown();
    expect(int1).toHaveBeenCalledTimes(1);
    expect(int2).toHaveBeenCalledTimes(1);
  });
});

describe("TaskManager.addIntervention (B-4)", () => {
  it("running task → queue push + intervention_sent broadcast + queued result", async () => {
    const { db, broadcaster, emitInterventionSent } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");
    expect(task.interventionQueue).toEqual([]);

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "hello", user: "alice" },
      onResume,
    );

    expect(result).toEqual({ queued: true, queuePosition: 1 });
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toMatchObject({ text: "hello", user: "alice" });
    expect(emitInterventionSent).toHaveBeenCalledTimes(1);
    expect(emitInterventionSent).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ text: "hello", user: "alice" }),
    );
    expect(onResume).not.toHaveBeenCalled();
  });

  it("연속 큐잉 시 queuePosition이 1, 2로 증가", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    const onResume = vi.fn();
    const r1 = await tm.addIntervention({ agentSessionId: "s1", text: "a", user: "u" }, onResume);
    const r2 = await tm.addIntervention({ agentSessionId: "s1", text: "b", user: "u" }, onResume);
    expect(r1).toEqual({ queued: true, queuePosition: 1 });
    expect(r2).toEqual({ queued: true, queuePosition: 2 });
  });

  it("completed task → user_message wire (UI 흰색) + status=running + session_updated + onResume + autoResumed", async () => {
    // 결함 A 정정 (PR #55): completed/error/interrupted → intervention_sent가 아닌
    // user_message로 wire 박힘 (Python `create_task(prompt=text)` 모델 정합).
    // 결함 B 정정: session_updated wire를 *상태 전환 직후* broadcast하여 soul-app TypingIndicator
    // (session.status === "running")가 즉시 표시.
    const broadcasterMocks = makeMocks();
    const tm = new TaskManager("n", broadcasterMocks.db, broadcasterMocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();
    task.codexThreadId = "thr-1";

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "resume", user: "u", callerInfo: { source: "agent" } },
      onResume,
    );

    expect(result).toEqual({ autoResumed: true });
    expect(task.status).toBe("running");
    expect(task.completedAt).toBeUndefined();
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0]).toMatchObject({ text: "resume", user: "u" });
    expect(task.codexThreadId).toBe("thr-1");
    expect(onResume).toHaveBeenCalledWith(task);
    // intervention_sent는 *발행 안 함* (auto-resume은 user_message 경로)
    expect(broadcasterMocks.emitInterventionSent).not.toHaveBeenCalled();
    // session_updated가 status=running 박힌 task로 broadcast
    expect(broadcasterMocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(broadcasterMocks.emitSessionUpdated.mock.calls[0][0]).toBe(task);
  });

  it.each(["error", "interrupted"] as const)("%s task → 같은 auto-resume 경로", async (status) => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = status;
    task.error = status === "error" ? "prior error" : undefined;
    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );
    expect(result).toEqual({ autoResumed: true });
    expect(task.status).toBe("running");
    expect(task.error).toBeUndefined();
    expect(onResume).toHaveBeenCalledWith(task);
  });

  it("미존재 task → throw 'Task not found'", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const onResume = vi.fn();
    await expect(
      tm.addIntervention({ agentSessionId: "missing", text: "x", user: "u" }, onResume),
    ).rejects.toThrow("Task not found: missing");
    expect(onResume).not.toHaveBeenCalled();
  });

  it("P1-1 race 보호: completed task의 executionPromise가 살아있으면 await 후 진행 (startExecution throw 차단)", async () => {
    const { db, broadcaster } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";

    // _finalize 미완료 상태를 시뮬레이션 — executionPromise는 살아있고 engine도 살아있음.
    let resolveFinalize: () => void = () => undefined;
    const finalizePromise = new Promise<void>((r) => { resolveFinalize = r; });
    task.executionPromise = finalizePromise;
    const engineCloseSpy = vi.fn().mockResolvedValue(undefined);
    task.engine = { interrupt: async () => true, close: engineCloseSpy } as unknown as EnginePort;

    const onResumeCalled: Task[] = [];
    const onResume = (t: Task) => onResumeCalled.push(t);

    // addIntervention을 트리거하지만 await — finalize가 아직 끝나지 않아 await 멈춤.
    const addPromise = tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );

    // 잠시 후 finalize가 끝났다고 신호 + task.engine 정리(시뮬레이션)
    setTimeout(() => {
      task.engine = undefined;
      resolveFinalize();
    }, 5);

    const result = await addPromise;
    expect(result).toEqual({ autoResumed: true });
    expect(onResumeCalled).toHaveLength(1);
    // onResume이 호출된 시점에는 task.engine이 undefined여야 startExecution이 throw하지 않음.
    expect(task.engine).toBeUndefined();
  });

  it("intervention_sent broadcast 실패 시 격리 (task 진행 유지) — running 경로", async () => {
    const { db, broadcaster, emitInterventionSent } = makeMocks();
    emitInterventionSent.mockRejectedValueOnce(new Error("ws down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      onResume,
    );
    expect(result).toEqual({ queued: true, queuePosition: 1 });
    expect(task.interventionQueue).toHaveLength(1);  // broadcast 실패에도 queue는 살아있음
  });
});

// B-5: 세션-폴더 배정 정본 (Python `_assign_default_folder_and_broadcast` 정합)
describe("TaskManager.createTask — 폴더 배정 + catalog broadcast", () => {
  it("folderId 명시 → assignSessionToFolder(folderId) + emitSessionCreated(task, folderId)", async () => {
    const { db, broadcaster, assignSessionToFolder, getDefaultFolder, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s1",
      prompt: "x",
      profileId: "codex-default",
      folderId: "folder-explicit",
    });
    expect(assignSessionToFolder).toHaveBeenCalledWith("s1", "folder-explicit");
    expect(getDefaultFolder).not.toHaveBeenCalled();  // 명시 folder가 있으면 default lookup 안 함
    expect(emitSessionCreated.mock.calls[0][1]).toBe("folder-explicit");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 → DEFAULT_FOLDERS['claude'] lookup + assign + emit", async () => {
    const { db, broadcaster, assignSessionToFolder, getDefaultFolder, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s2",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(getDefaultFolder).toHaveBeenCalledWith("⚙️ 클로드 코드 세션");
    expect(assignSessionToFolder).toHaveBeenCalledWith("s2", "default-claude");
    expect(emitSessionCreated.mock.calls[0][1]).toBe("default-claude");
    expect(emitCatalogUpdated).toHaveBeenCalledTimes(1);
  });

  it("folderId 미지정 + 기본 폴더 없음 → 폴더 배정·broadcast 안 함 (graceful, Python L306-307)", async () => {
    const { db, broadcaster, assignSessionToFolder, emitSessionCreated, emitCatalogUpdated, getDefaultFolder } = makeMocks();
    getDefaultFolder.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s3",
      prompt: "x",
      profileId: "codex-default",
    });
    expect(assignSessionToFolder).not.toHaveBeenCalled();
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // 폴더 배정 안 됐으면 broadcast 안 함 (Python L311 gate)
  });

  it("assignSessionToFolder throw → 격리, task 생성은 성공 (부가 기능 실패 분리)", async () => {
    const { db, broadcaster, assignSessionToFolder, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    assignSessionToFolder.mockRejectedValueOnce(new Error("db down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s4",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f-x",
    });
    expect(task.agentSessionId).toBe("s4");  // task 생성 성공
    // 폴더 배정 실패 → emit에 null 전달, catalog broadcast 안 함
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();
    expect(emitCatalogUpdated).not.toHaveBeenCalled();
  });

  it("getCatalog throw → 격리 (Python L317-321 정합), task·session_created 정상 진행", async () => {
    const { db, broadcaster, getCatalog, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    getCatalog.mockRejectedValueOnce(new Error("catalog query down"));
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({
      agentSessionId: "s5",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f-y",
    });
    expect(task.agentSessionId).toBe("s5");
    expect(emitSessionCreated.mock.calls[0][1]).toBe("f-y");  // 폴더 배정은 성공 (assign은 throw 안 함)
    expect(emitCatalogUpdated).not.toHaveBeenCalled();  // catalog 실패는 broadcast 차단
  });

  it("emitCatalogUpdated가 emitSessionCreated *이전*에 호출됨 (Python L304 순서 보장)", async () => {
    const { db, broadcaster, emitSessionCreated, emitCatalogUpdated } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    await tm.createTask({
      agentSessionId: "s6",
      prompt: "x",
      profileId: "codex-default",
      folderId: "f",
    });
    // mock 호출 순서 검증
    const catalogOrder = emitCatalogUpdated.mock.invocationCallOrder[0];
    const createdOrder = emitSessionCreated.mock.invocationCallOrder[0];
    expect(catalogOrder).toBeLessThan(createdOrder);
  });
});

// B-5: session_broadcaster.emitCatalogUpdated wire 형상 회귀는 session_broadcaster.test.ts에서 보호.

// B-5: intervention_sent 영속화 (Python `task_executor.py:352-389` 정합)
describe("TaskManager.addIntervention — intervention_sent 영속화 (B-5)", () => {
  it("persistence 주입 시 intervention_sent를 persistEvent + broadcast 모두 호출", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(123);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;

    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");

    await tm.addIntervention(
      { agentSessionId: "s1", text: "추가 메시지", user: "alice", callerInfo: { source: "slack" } },
      vi.fn(),
    );

    expect(persistEvent).toHaveBeenCalledTimes(1);
    const persisted = persistEvent.mock.calls[0][1] as Record<string, unknown>;
    expect(persisted.type).toBe("intervention_sent");
    expect(persisted.text).toBe("추가 메시지");
    expect(persisted.user).toBe("alice");
    expect(persisted.caller_info).toEqual({ source: "slack" });
    expect(typeof persisted.timestamp).toBe("number");

    expect(handleSideEffects).toHaveBeenCalledTimes(1);
    expect(mocks.emitInterventionSent).toHaveBeenCalledTimes(1);
    // 호출 순서: persistEvent → handleSideEffects → emitInterventionSent (last_message 갱신 후 broadcast)
    expect(persistEvent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.emitInterventionSent.mock.invocationCallOrder[0],
    );
    expect(task.lastEventId).toBe(123);
  });

  it("persistence 미주입(legacy) → persistEvent skip, broadcast만 발행", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);  // persistence 생략
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    // broadcast는 호출됨
    expect(mocks.emitInterventionSent).toHaveBeenCalledTimes(1);
  });

  it("persistEvent throw → 격리, broadcast는 정상 진행", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockRejectedValueOnce(new Error("events db down"));
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    const result = await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    expect(result).toEqual({ queued: true, queuePosition: 1 });
    expect(mocks.emitInterventionSent).toHaveBeenCalledTimes(1);
  });
});

// PR #55: 결함 A·B 정합 (resume vs intervention 분기 + typing indicator)
describe("TaskManager.addIntervention — running vs completed wire 분기 (결함 A·B)", () => {
  it("running task → intervention_sent wire 발행, user_message·session_updated 발행 안 함", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(1);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(task.status).toBe("running");

    await tm.addIntervention(
      { agentSessionId: "s1", text: "추가", user: "u" },
      vi.fn(),
    );

    // intervention_sent만 발행, user_message envelope·session_updated 발행 안 함
    expect(mocks.emitInterventionSent).toHaveBeenCalledTimes(1);
    expect(mocks.emitEventEnvelope).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).not.toHaveBeenCalled();
    // persistEvent에 박힌 type은 intervention_sent
    expect((persistEvent.mock.calls[0][1] as { type: string }).type).toBe("intervention_sent");
  });

  it("completed task → user_message envelope + session_updated + onResume, intervention_sent 발행 안 함", async () => {
    const mocks = makeMocks();
    const persistEvent = vi.fn().mockResolvedValue(2);
    const handleSideEffects = vi.fn().mockResolvedValue(undefined);
    const persistence = { persistEvent, handleSideEffects } as unknown as import("../../src/db/event_persistence.js").EventPersistence;
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger, persistence);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();

    await tm.addIntervention(
      { agentSessionId: "s1", text: "이어서", user: "alice", callerInfo: { source: "slack", display_name: "Alice" } },
      vi.fn(),
    );

    // user_message envelope 발행
    const envelopeCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(envelopeCalls.length).toBe(1);
    expect((envelopeCalls[0][1] as Record<string, unknown>).text).toBe("이어서");
    expect((envelopeCalls[0][1] as Record<string, unknown>).caller_info).toEqual({ source: "slack", display_name: "Alice" });

    // persistEvent에 박힌 type은 user_message
    expect((persistEvent.mock.calls[0][1] as { type: string }).type).toBe("user_message");

    // session_updated가 status="running" 박힌 task로 broadcast (결함 B fix)
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect((mocks.emitSessionUpdated.mock.calls[0][0] as { status: string }).status).toBe("running");

    // intervention_sent는 발행 안 함
    expect(mocks.emitInterventionSent).not.toHaveBeenCalled();
  });

  it.each(["error", "interrupted"] as const)("%s task → user_message 분기 (completed와 동일)", async (status) => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = status;
    await tm.addIntervention(
      { agentSessionId: "s1", text: "재개", user: "u" },
      vi.fn(),
    );
    const envelopeCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(envelopeCalls.length).toBe(1);
    expect(mocks.emitInterventionSent).not.toHaveBeenCalled();
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
  });

  it("session_updated가 user_message broadcast *이후*에 발행됨 (클라이언트 store 정합)", async () => {
    // status="running" wire가 클라이언트에 도달하기 *전에* user_message가 박혀야
    // typing indicator가 새 메시지 *뒤*에 표시 (UX 자연스러움).
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    const userMsgOrder = mocks.emitEventEnvelope.mock.invocationCallOrder[0];
    const sessionUpdatedOrder = mocks.emitSessionUpdated.mock.invocationCallOrder[0];
    expect(userMsgOrder).toBeLessThan(sessionUpdatedOrder);
  });
});

// PR #56: 결함 D — 서버 재기동 후 task hydration (Python load_evicted_task 정합)
describe("TaskManager.addIntervention — 메모리 비어 있을 때 DB hydration (결함 D)", () => {
  it("메모리에 task가 없고 DB에도 없으면 throw (현 동작 보존)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce(null);
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "missing", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: missing");
    expect(mocks.getSession).toHaveBeenCalledWith("missing");
  });

  it("메모리에 task가 없고 DB에 completed 세션이 있으면 hydrate + auto-resume 흐름 진입", async () => {
    const mocks = makeMocks();
    // DB row 반환 — codex 세션 (claude_session_id가 codex thread id)
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-evicted",
      folder_id: "f-1",
      display_name: null,
      node_id: "n",
      session_type: "claude",
      status: "completed",
      prompt: "원래 prompt",
      client_id: null,
      claude_session_id: "thr-codex-abc",  // codex thread id (PR #48 F-3B)
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      last_event_id: 42,
      last_read_event_id: 10,
      created_at: new Date("2026-05-17T10:00:00Z"),
      updated_at: new Date("2026-05-17T10:05:00Z"),
      agent_id: "codex-default",
      caller_session_id: null,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);

    const onResume = vi.fn();
    const result = await tm.addIntervention(
      { agentSessionId: "sess-evicted", text: "이어서", user: "u" },
      onResume,
    );

    // auto-resume 흐름 진입
    expect(result).toEqual({ autoResumed: true });
    // hydrate된 task가 메모리에 추가됨
    const memTask = tm.getTask("sess-evicted");
    expect(memTask).toBeDefined();
    expect(memTask!.status).toBe("running");  // auto-resume에서 전환
    expect(memTask!.codexThreadId).toBe("thr-codex-abc");  // resumeThread를 위해 복원
    expect(memTask!.profileId).toBe("codex-default");
    expect(memTask!.prompt).toBe("원래 prompt");
    expect(memTask!.lastEventId).toBeGreaterThanOrEqual(42);  // hydrate 후 user_message 영속 가능
    // user_message 영속·broadcast + session_updated (PR #55 분기)
    const userMsgCalls = mocks.emitEventEnvelope.mock.calls.filter(
      (c) => (c[1] as { type: string }).type === "user_message",
    );
    expect(userMsgCalls.length).toBe(1);
    expect(mocks.emitSessionUpdated).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith(memTask);
  });

  it.each(["error", "interrupted"] as const)("DB에 %s 세션도 hydrate 가능 (terminal 모두)", async (status) => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-t",
      session_type: "claude",
      status,
      prompt: "p",
      claude_session_id: "thr-x",
      last_event_id: 5,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    const result = await tm.addIntervention(
      { agentSessionId: "sess-t", text: "재개", user: "u" },
      vi.fn(),
    );
    expect(result).toEqual({ autoResumed: true });
    expect(tm.getTask("sess-t")!.status).toBe("running");
  });

  it("DB row.status가 비정상 값이면 null 반환 → throw (graceful)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-bad",
      session_type: "claude",
      status: "invalid_status",  // 비정상
      prompt: "p",
      claude_session_id: null,
      last_event_id: 0,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: null,
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: null,
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-bad", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: sess-bad");
  });

  it("db.getSession throw → graceful null (Task not found으로 정규화)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockRejectedValueOnce(new Error("db connection lost"));
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await expect(
      tm.addIntervention({ agentSessionId: "sess-x", text: "x", user: "u" }, vi.fn()),
    ).rejects.toThrow("Task not found: sess-x");
  });

  it("메모리에 task가 있으면 hydration skip (기존 동작 보존)", async () => {
    const mocks = makeMocks();
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    expect(tm.getTask("s1")).toBeDefined();
    await tm.addIntervention(
      { agentSessionId: "s1", text: "x", user: "u" },
      vi.fn(),
    );
    // 메모리 hit이라 getSession 호출 안 됨
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it("hydrate된 task의 첫 turn이 queue dequeue로 진입 (PR #54 P0 fix와 정합)", async () => {
    const mocks = makeMocks();
    mocks.getSession.mockResolvedValueOnce({
      session_id: "sess-h",
      session_type: "claude",
      status: "completed",
      prompt: "원래",
      claude_session_id: "thr-h",
      last_event_id: 3,
      last_read_event_id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      agent_id: "codex-default",
      caller_session_id: null,
      folder_id: null,
      display_name: null,
      node_id: "n",
      client_id: null,
      last_message: null,
      metadata: null,
      was_running_at_shutdown: false,
      away_summary: null,
    });
    const tm = new TaskManager("n", mocks.db, mocks.broadcaster, silentLogger);
    await tm.addIntervention(
      { agentSessionId: "sess-h", text: "새 메시지", user: "u" },
      vi.fn(),
    );
    const task = tm.getTask("sess-h")!;
    // PR #55 auto-resume: queue에 메시지 push됨, task.prompt는 원래 그대로
    expect(task.interventionQueue).toHaveLength(1);
    expect(task.interventionQueue[0].text).toBe("새 메시지");
    expect(task.prompt).toBe("원래");  // 원래 prompt 보존
  });
});
