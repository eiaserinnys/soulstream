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
 * 카드 #1266 U6 결함 1. 종료가 기록된 등록의 러너에서 뒤이은 턴이 막 시작됐다. 러너는 붙었고
 * 실행 슬롯(executionPromise)은 잡혔지만, 중앙이 새 실행 등록을 받기 전이라 러너에는 붙은
 * 명령이 아직 없고 task는 앞 턴의 종료 기록을 그대로 들고 있다(2026-11-13 운영 관찰: 스캔이
 * 이 실행을 끝까지 기다려 195~998초 걸렸다). 스캔은 그 턴을 기다리지 않고, 그 러너를 은퇴시켜
 * 죽이지도 않으며, 옛 등록의 정리는 그 턴이 끝난 뒤의 스캔이 한다.
 */

const NOW_MS = Date.parse("2026-11-13T00:00:30.000Z");
const REGISTRATION_ID = "registration-a";
const SCAN_BUDGET_MS = 1_000;

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

function terminalRegistration(sessionId: string): RunnerRegistration {
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
    // 앞 턴의 종료 명령이 기록된 등록이다.
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-old",
      execution_state: "completed",
      progress_seq: 3,
      progress_at: "2026-11-13T00:00:25.000Z",
      liveness_at: "2026-11-13T00:00:25.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

function setup() {
  // 새 실행 등록을 중앙이 받기 전에 멈춰 세운다. 이 구간이 사건의 상태다.
  let openRegistration!: () => void;
  const registrationGate = new Promise<void>((resolve) => { openRegistration = resolve; });
  let registrationRequested!: () => void;
  const registrationAsked = new Promise<void>((resolve) => { registrationRequested = resolve; });
  let releaseTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });

  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn(async function* () { await turnGate; }),
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
    isClosed: vi.fn(() => false),
    hasActiveExecution: vi.fn(() => false),
    activeExecutionCommandId: vi.fn(() => undefined),
    dispatcherId: vi.fn(() => "dispatcher-a"),
  };
  const retireTerminalRegistration = vi.fn(
    async (beforeRegistrationRetired?: () => Promise<void>) => {
      await beforeRegistrationRetired?.();
    },
  );
  (dispatcher as Record<string, unknown>).retireTerminalRegistration = retireTerminalRegistration;
  const runner = {
    engine: fakeEngine(),
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  } as TaskRunnerRuntime;

  const double = makeEventPersistenceTestDouble();
  Object.assign(double.persistence, {
    recordExecutionRegistrationAndWaitForApplication: vi.fn(async () => {
      registrationRequested();
      await registrationGate;
      return {
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
          registrationId: REGISTRATION_ID,
          executionCommandId: "execute-next",
        },
      };
    }),
  });
  const factory = vi.fn(() => {
    throw new Error("a fresh runner must not be spawned; the attached runner is reused");
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

  // 앞 턴이 종료됐고 그 종료가 기록됐다. 러너는 그 등록으로 붙어 있다.
  const task: Task = {
    agentSessionId: "sess-a",
    prompt: "next turn",
    status: "completed",
    profileId: agent.id,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    completedAt: new Date("2026-11-13T00:00:10.000Z"),
    terminationReason: "completed_ok",
    terminationEventRecorded: true,
    terminalEventId: 10,
    lastEventId: 10,
    lastReadEventId: 10,
    interventionQueue: [],
    runner,
    // 앞 턴이 보유한 러너를 뒤이은 턴이 그대로 이어 쓴다.
    runnerRetainedForDetachedWork: true,
  };

  const terminate = vi.fn(async () => {});
  const spawnerRetire = vi.fn(async () => {});
  const registration = terminalRegistration(task.agentSessionId);
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
      retireTerminalRegistration: spawnerRetire,
    },
    scan: async () => structuredClone({ registrations: [registration], errors: [] }),
    hydrate: async (hydrated: RunnerRegistration) => hydrated,
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
    executor, coordinator, task, runner, dispatcher, terminate, spawnerRetire,
    retireTerminalRegistration, registrationAsked, openRegistration, releaseTurn,
  };
}

async function scanWithin(
  subject: ReturnType<typeof setup>,
  budgetMs: number,
): Promise<"scanned" | "blocked"> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      subject.coordinator.scanOnce().then(() => "scanned" as const),
      new Promise<"blocked">((resolve) => {
        timer = setTimeout(() => resolve("blocked"), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("card #1266 U6 scan and a successor turn on a recorded-terminal registration", () => {
  it("returns without waiting for the successor turn and leaves its runner alive", async () => {
    const subject = setup();
    const execution = subject.executor.startNewExecution(subject.task, agent);
    await subject.registrationAsked;
    // 러너는 붙었고 실행 슬롯은 잡혔지만 붙은 명령은 아직 없다.
    expect(subject.task.runner).toBe(subject.runner);
    expect(subject.task.executionPromise).toBeDefined();
    expect(subject.dispatcher.activeExecutionCommandId()).toBeUndefined();

    expect(await scanWithin(subject, SCAN_BUDGET_MS)).toBe("scanned");

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(subject.dispatcher.detachHost).not.toHaveBeenCalled();
    expect(subject.dispatcher.close).not.toHaveBeenCalled();
    expect(subject.task.runner).toBe(subject.runner);

    // 정리: 중앙이 등록을 받고 턴이 끝난다.
    subject.openRegistration();
    subject.releaseTurn();
    await execution;
    await subject.task.executionPromise;
  });

  it("retires the old registration on a scan after the successor turn ended", async () => {
    const subject = setup();
    const execution = subject.executor.startNewExecution(subject.task, agent);
    await subject.registrationAsked;
    expect(await scanWithin(subject, SCAN_BUDGET_MS)).toBe("scanned");
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();

    subject.openRegistration();
    subject.releaseTurn();
    await execution;
    await subject.task.executionPromise;
    // 뒤이은 턴이 끝나 종료가 기록됐다.
    subject.task.status = "completed";
    subject.task.terminationReason = "completed_ok";
    subject.task.terminationEventRecorded = true;
    subject.task.terminalEventId = 21;

    expect(await scanWithin(subject, SCAN_BUDGET_MS)).toBe("scanned");
    await subject.coordinator.waitForSettled();

    // 러너는 턴과 함께 떼어졌으므로 옛 등록은 등록 정리 길(spawner)로 한 번 은퇴한다.
    expect(subject.spawnerRetire).toHaveBeenCalledOnce();
    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
  });
});
