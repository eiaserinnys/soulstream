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
  const db = { registerSession, deleteSession } as unknown as SessionDB;

  const emitSessionCreated = vi.fn().mockResolvedValue(undefined);
  const emitSessionDeleted = vi.fn().mockResolvedValue(undefined);
  const emitInterventionSent = vi.fn().mockResolvedValue(undefined);
  const broadcaster = {
    emitSessionCreated,
    emitSessionDeleted,
    emitInterventionSent,
  } as unknown as SessionBroadcaster;

  return { db, broadcaster, registerSession, deleteSession, emitSessionCreated, emitSessionDeleted, emitInterventionSent };
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
    expect(emitSessionCreated.mock.calls[0][1]).toBeNull();  // folderId
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

  it("completed task → status=running 전환 + queue push + onResume 호출 + autoResumed result", async () => {
    const { db, broadcaster, emitInterventionSent } = makeMocks();
    const tm = new TaskManager("n", db, broadcaster, silentLogger);
    const task = await tm.createTask({ agentSessionId: "s1", prompt: "p", profileId: "codex-default" });
    task.status = "completed";
    task.completedAt = new Date();
    task.codexThreadId = "thr-1";  // 완료된 turn이 thread id를 남겼다고 가정 (resumeThread 가능)

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
    expect(task.codexThreadId).toBe("thr-1");  // resumeThread를 위해 보존
    expect(onResume).toHaveBeenCalledWith(task);
    expect(emitInterventionSent).toHaveBeenCalledTimes(1);
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
