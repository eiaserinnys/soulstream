import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import type { EnginePort } from "../../src/engine/protocol.js";
import { createInProcessTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskInterventionRoute } from "../../src/task/task_intervention_route.js";
import type { Task } from "../../src/task/task_models.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const logger = pino({ level: "silent" });

describe("TaskManager concurrent evicted task loading", () => {
  it("shares one hydrated task for concurrent terminal interventions", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const getSession = vi.fn(async () => {
      await readGate;
      return terminalSessionRow();
    });
    const db = { getSession } as unknown as SessionDB;
    const persistenceDouble = makeEventPersistenceTestDouble();
    const persistence = persistenceDouble.persistence;
    const broadcaster = {
      emitEventEnvelope: vi.fn(async () => {}),
      emitSessionUpdated: vi.fn(async () => {}),
      emitSessionCreated: vi.fn(async () => {}),
      emitSessionDeleted: vi.fn(async () => {}),
      emitCatalogUpdated: vi.fn(async () => {}),
    } as unknown as SessionBroadcaster;
    const manager = new TaskManager("node-a", db, broadcaster, logger, persistence);
    const internals = manager as unknown as {
      interventionRoute: unknown;
      autoResumeTransition: unknown;
      loadEvictedTask(sessionId: string): Promise<Task | null>;
    };
    expect(internals.interventionRoute).toBeInstanceOf(TaskInterventionRoute);
    expect(internals.autoResumeTransition).toBeInstanceOf(AutoResumeTransition);

    const delivered: string[] = [];
    let executionTask: Task | undefined;
    const onResume = vi.fn((task: Task, activation?: Task["executionActivation"]) => {
      executionTask = task;
      task.status = "running";
      task.executionActivation = undefined;
      task.runner = createInProcessTaskRunnerRuntime({
        backendId: "codex",
        workspaceDir: "/workspace/a",
        async *execute() {},
        async intervene(input) {
          delivered.push(input.prompt);
          return { status: "delivered", mechanism: "active_turn" };
        },
        async interrupt() { return true; },
        async close() {},
      } as unknown as EnginePort);
      vi.spyOn(task.runner.dispatcher, "hasActiveExecution").mockReturnValue(true);
      activation?.resolve();
    });

    const first = manager.addIntervention({
      agentSessionId: "session-a", text: "child report one", user: "agent",
    }, onResume);
    const second = manager.addIntervention({
      agentSessionId: "session-a", text: "child report two", user: "agent",
    }, onResume);
    const third = manager.addIntervention({
      agentSessionId: "session-a", text: "child report three", user: "agent",
    }, onResume);
    expect(getSession).toHaveBeenCalledTimes(1);
    releaseRead();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      { autoResumed: true },
      { delivered: true },
      { delivered: true },
    ]);

    const task = manager.getTask("session-a");
    expect(task).toBeDefined();
    expect(executionTask).toBe(task);
    expect(onResume).toHaveBeenCalledOnce();
    expect(task?.prompt).toBe("child report one");
    expect(delivered).toEqual(["child report two", "child report three"]);
    expect(persistenceDouble.enqueueEvent).toHaveBeenCalledWith(
      "session-a",
      expect.objectContaining({ type: "user_message", text: "child report one" }),
    );
  });

  it("rejects a still-initializing task when the same activation resolves", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const getSession = vi.fn(async () => {
      await readGate;
      return terminalSessionRow();
    });
    const db = { getSession } as unknown as SessionDB;
    const persistence = makeEventPersistenceTestDouble().persistence;
    const broadcaster = {
      emitEventEnvelope: vi.fn(async () => {}),
      emitSessionUpdated: vi.fn(async () => {}),
      emitSessionCreated: vi.fn(async () => {}),
      emitSessionDeleted: vi.fn(async () => {}),
      emitCatalogUpdated: vi.fn(async () => {}),
    } as unknown as SessionBroadcaster;
    const manager = new TaskManager("node-a", db, broadcaster, logger, persistence);
    let activation: Task["executionActivation"] = undefined;
    let announceResumeStarted!: () => void;
    const resumeStarted = new Promise<void>((resolve) => {
      announceResumeStarted = resolve;
    });
    const onResume = vi.fn((_task: Task, current?: Task["executionActivation"]) => {
      activation = current;
      announceResumeStarted();
    });

    const first = manager.addIntervention({
      agentSessionId: "session-a", text: "first", user: "agent",
    }, onResume);
    releaseRead();
    await resumeStarted;
    const second = manager.addIntervention({
      agentSessionId: "session-a", text: "second", user: "agent",
    }, onResume);

    expect(activation).toBeDefined();
    activation?.resolve();
    await expect(first).resolves.toEqual({ autoResumed: true });
    await expect(second).rejects.toThrow(
      "execution activation did not reach running state for session-a",
    );
    expect(onResume).toHaveBeenCalledOnce();
    expect(manager.getTask("session-a")?.status).toBe("initializing");
  });

  it("shares hydration between runner recovery and an intervention", async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const getSession = vi.fn(async () => {
      await readGate;
      return terminalSessionRow();
    });
    const db = { getSession } as unknown as SessionDB;
    const persistence = makeEventPersistenceTestDouble().persistence;
    const broadcaster = {
      emitEventEnvelope: vi.fn(async () => {}),
      emitSessionUpdated: vi.fn(async () => {}),
      emitSessionCreated: vi.fn(async () => {}),
      emitSessionDeleted: vi.fn(async () => {}),
      emitCatalogUpdated: vi.fn(async () => {}),
    } as unknown as SessionBroadcaster;
    const manager = new TaskManager("node-a", db, broadcaster, logger, persistence);
    const recovery = manager.hydrateRunnerRecoveryTask("session-a");
    const intervention = manager.addIntervention({
      agentSessionId: "session-a", text: "wake", user: "agent",
    }, (task, activation) => {
      task.status = "running";
      task.executionActivation = undefined;
      activation?.resolve();
    });
    expect(getSession).toHaveBeenCalledTimes(1);
    releaseRead();
    const [hydrated] = await Promise.all([recovery, intervention]);
    expect(hydrated).toBe(manager.getTask("session-a"));
    expect(getSession).toHaveBeenCalledOnce();
  });
});

function terminalSessionRow(): SessionRow {
  return {
    session_id: "session-a",
    folder_id: null,
    display_name: null,
    node_id: "node-a",
    session_type: "claude",
    status: "completed",
    prompt: "original",
    client_id: null,
    claude_session_id: "backend-session-a",
    last_message: null,
    metadata: [],
    was_running_at_shutdown: false,
    last_event_id: 42,
    last_read_event_id: 42,
    created_at: new Date("2026-11-01T00:00:00Z"),
    updated_at: new Date("2026-11-01T00:01:00Z"),
    agent_id: "agent-a",
    caller_session_id: null,
    away_summary: null,
    termination_reason: "completed_ok",
    termination_detail: null,
    termination_event_id: 41,
  } as SessionRow;
}
