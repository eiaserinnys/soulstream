import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { RunnerRecoveryCoordinator } from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import {
  TaskExecutor,
  type RunnerProcessRuntimeFactory,
} from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "../task/event_persistence_test_double.js";

/**
 * 카드 #1266 U2a 고침 A. 종료가 거절되어 거절 표시가 남은 뒤, 백그라운드 작업으로 보유한
 * 러너가 같은 등록으로 다음 턴을 돌린다. 실제 TaskExecutor가 보유 러너를 다시 쓰고, 그 턴이
 * 도는 동안 실제 RunnerRecoveryCoordinator.scanOnce를 여러 번 돌려도 새 턴의 러너가
 * 은퇴되거나 떼어지지 않아야 한다.
 */

const NOW_MS = Date.parse("2026-11-13T00:00:30.000Z");
const REGISTRATION_ID = "registration-a";

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

function fakeEngine(): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {},
    async interrupt() { return true; },
    async close() {},
  };
}

function liveRegistration(sessionId: string): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: { id: agent.id, name: agent.name, backend: "codex", workspace_dir: agent.workspace_dir },
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: "sha-a",
      snapshotPath: "/release/sha-a/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 4123,
    registrationId: REGISTRATION_ID,
    pidStartIdentity: "start-4123",
    pidAlive: true,
    registeredAtMs: Date.parse("2026-11-13T00:00:00.000Z"),
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `backend-${sessionId}`,
        cwd: "/tmp/codex-default",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-11-13T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-next",
      execution_state: "running",
      progress_seq: 3,
      progress_at: "2026-11-13T00:00:25.000Z",
      liveness_at: "2026-11-13T00:00:25.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

function setup(registrationOwner = REGISTRATION_ID) {
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
  let turnStarted!: () => void;
  const turnRunning = new Promise<void>((resolve) => { turnStarted = resolve; });
  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn(async function* () {
      turnStarted();
      await turnGate;
    }),
    recoverFrames: vi.fn(async function* () {}),
    registrationId: vi.fn(() => REGISTRATION_ID),
    prepareExecutionIdentity: vi.fn(async () => ({
      registrationId: REGISTRATION_ID,
      pid: 4123,
      startIdentity: "start-4123",
      executionCommandId: "execute-next",
    })),
    rollbackExecutionIdentity: vi.fn(async () => {}),
    prepareSession: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    detachHost: vi.fn(async () => {}),
    releaseEventStreamRegistration: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    waitForSessionAck: vi.fn(async () => 12),
  };
  const runner = {
    engine: fakeEngine(),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  } as TaskRunnerRuntime;
  const double = makeEventPersistenceTestDouble();
  Object.assign(double.persistence, {
    recordExecutionRegistrationAndWaitForApplication: vi.fn(async () => ({
      eventId: 20,
      applied: true,
      canonicalSession: {
        status: "running",
        termination_reason: null,
        termination_detail: null,
        review_state: "not_required",
        last_assistant_text: null,
        termination_event_id: null,
        updated_at: "2026-11-13T00:00:20.000Z",
        last_event_id: 20,
      },
      canonicalExecutionRegistration: {
        registrationId: registrationOwner,
        executionCommandId: registrationOwner === REGISTRATION_ID ? "execute-next" : "execute-other",
      },
    })),
  });
  const factory = vi.fn(() => {
    throw new Error("a fresh runner must not be spawned; the retained runner is reused");
  }) as unknown as RunnerProcessRuntimeFactory;
  const executor = new TaskExecutor(
    () => fakeEngine(),
    { updateSession: vi.fn(), setClaudeSessionId: vi.fn(), getSession: vi.fn() } as unknown as SessionDB,
    double.persistence,
    { emitEventEnvelope: vi.fn(), emitSessionUpdated: vi.fn() } as unknown as SessionBroadcaster,
    pino({ level: "silent" }),
    undefined, undefined, undefined, undefined, undefined, undefined,
    factory,
  );

  // 앞 턴의 종료가 다시 될 까닭 없이 거절됐다. 러너는 백그라운드 작업으로 보유 중이라
  // 은퇴를 미루고 표시만 남았다(task_lifecycle_transition.settleRejection).
  const task: Task = {
    agentSessionId: "sess-a",
    prompt: "next turn",
    status: "completed",
    profileId: agent.id,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    completedAt: new Date("2026-11-13T00:00:10.000Z"),
    lastEventId: 10,
    lastReadEventId: 10,
    interventionQueue: [],
    runner,
    runnerRetainedForDetachedWork: true,
    rejectedTerminationRegistrationId: REGISTRATION_ID,
  };

  const retireTerminalRegistration = vi.fn(async () => {});
  const terminate = vi.fn(async () => {});
  const disk = { registrations: [liveRegistration(task.agentSessionId)] };
  const coordinator = new RunnerRecoveryCoordinator({
    nodeId: "node-a",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    spawner: {
      terminate,
      invalidateRegistration: vi.fn(async () => {}),
      retireTerminalRegistration,
    },
    scan: async () => structuredClone({ registrations: disk.registrations, errors: [] }),
    hydrate: async (registration: RunnerRegistration) => registration,
    now: () => NOW_MS,
    taskManager: {
      hydrateRunnerRecoveryTask: vi.fn(async () => task),
      markRunnerFailure: vi.fn(async () => {}),
      projectClosedRunner: vi.fn(async () => {}),
      listTasks: () => [task],
      forgetRunnerRecoveryTask: vi.fn(),
    },
    taskExecutor: {
      recoverRegisteredRunner: vi.fn(async () => {}),
      retainRegisteredDetachedRunner: vi.fn(async () => false),
      releaseExpiredRetainedRunner: vi.fn(async () => "not_released" as const),
      completeRetainedRunnerReleaseAfterTermination: vi.fn(() => false),
    },
  } as never);

  return {
    executor, coordinator, task, runner, dispatcher, factory,
    retireTerminalRegistration, terminate, turnRunning, releaseTurn,
  };
}

describe("card #1266 U2a rejected-terminal mark and a new turn on the retained runner", () => {
  it("does not retire or detach the retained runner that runs the next turn across many scans", async () => {
    const subject = setup();
    const execution = subject.executor.startNewExecution(subject.task, agent);
    await subject.turnRunning;

    expect(subject.factory).not.toHaveBeenCalled();
    expect(subject.task.runner).toBe(subject.runner);

    for (let index = 0; index < 4; index += 1) {
      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();
    }

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.dispatcher.detachHost).not.toHaveBeenCalled();
    expect(subject.task.runner).toBe(subject.runner);
    expect(subject.task.rejectedTerminationRegistrationId).toBeUndefined();

    subject.releaseTurn();
    await execution;
    await subject.task.executionPromise;
  });

  it("keeps the mark when the reused runner's new registration is rejected, so the old terminal still retires", async () => {
    const subject = setup("registration-other");
    await subject.executor.startNewExecution(subject.task, agent);
    await subject.task.executionPromise;

    // 새 등록이 서지 않았다. 표시는 앞 턴의 거절된 종료를 위해 남는다.
    expect(subject.task.rejectedTerminationRegistrationId).toBe(REGISTRATION_ID);
    expect(subject.dispatcher.executeFrames).not.toHaveBeenCalled();

    for (let index = 0; index < 3; index += 1) {
      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();
    }
    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
  });
});
