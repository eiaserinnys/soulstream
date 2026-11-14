import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { RunnerRecoveryCoordinator } from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { createExecutionActivation, type Task } from "../../src/task/task_models.js";

/**
 * 카드 #1266 U2b 8-나. 러너 복구의 앞 검사(거절된 종료의 등록을 은퇴시키는 갈래)는 새 실행이 돌고
 * 있는 task를 건너뛴다. 그 갈래를 단독으로 본다: 같은 표시와 같은 등록이어도 실행이 돌고 있으면
 * 은퇴하지 않고, 돌지 않으면 은퇴한다.
 */
const NOW_MS = Date.parse("2026-11-13T00:00:30.000Z");
const REGISTRATION_ID = "registration-a";

const agent: AgentProfile = {
  id: "codex-default",
  name: "Codex Default",
  backend: "codex",
  workspace_dir: "/tmp/codex-default",
};

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


function setup(task: Task) {
  const retireTerminalRegistration = vi.fn(async () => {});
  const terminate = vi.fn(async () => {});
  const forgetRunnerRecoveryTask = vi.fn();
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
      forgetRunnerRecoveryTask,
    },
    taskExecutor: {
      recoverRegisteredRunner: vi.fn(async () => {}),
      retainRegisteredDetachedRunner: vi.fn(async () => false),
      releaseExpiredRetainedRunner: vi.fn(async () => "not_released" as const),
      completeRetainedRunnerReleaseAfterTermination: vi.fn(() => false),
    },
  } as never);
  return { coordinator, retireTerminalRegistration, terminate, forgetRunnerRecoveryTask };
}

function markedTask(overrides: Partial<Task>): Task {
  return {
    agentSessionId: "sess-a",
    prompt: "next turn",
    status: "completed",
    profileId: agent.id,
    createdAt: new Date("2026-11-13T00:00:00.000Z"),
    completedAt: new Date("2026-11-13T00:00:10.000Z"),
    lastEventId: 10,
    lastReadEventId: 10,
    interventionQueue: [],
    rejectedTerminationRegistrationId: REGISTRATION_ID,
    ...overrides,
  };
}

describe("card #1266 U2b the pre-check of the rejected-terminal mark skips a task whose execution is running", () => {
  it("retires the rejected registration when no execution is running", async () => {
    const subject = setup(markedTask({}));

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
  });

  it("does not retire the registration while a new execution is running, across many scans", async () => {
    const running = new Promise<void>(() => {});
    const task = markedTask({ status: "running", executionPromise: running });
    const subject = setup(task);

    for (let index = 0; index < 3; index += 1) {
      await subject.coordinator.scanOnce();
      await subject.coordinator.waitForSettled();
    }

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
    expect(subject.terminate).not.toHaveBeenCalled();
    expect(task.rejectedTerminationRegistrationId).toBe(REGISTRATION_ID);
  });

  it("does not retire a registration other than the marked one", async () => {
    const subject = setup(markedTask({ rejectedTerminationRegistrationId: "registration-b" }));

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.retireTerminalRegistration).not.toHaveBeenCalled();
  });
});

describe("card #1266 U2b a task kept only for its rejected registration is forgotten once that registration retires", () => {
  it("forgets an active task that has no runner, registration or execution after the later retirement succeeds", async () => {
    // 로컬 소유 정리가 은퇴 실패 때문에 붙들어 둔 꼴이다: 활성인데 러너도 등록도 실행도 없다.
    const task = markedTask({ status: "running", completedAt: undefined });
    const subject = setup(task);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "sess-a" }),
    );
  });

  it("does not forget a task that already ended (the retirement only clears the mark)", async () => {
    const subject = setup(markedTask({}));

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("does not forget an active task that still has a registration", async () => {
    const subject = setup(markedTask({
      status: "running",
      completedAt: undefined,
      executionRegistration: { registrationId: "registration-live", executionCommandId: "execute-live" },
    }));

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("does not forget a task that is starting behind its start barrier when the retirement succeeds", async () => {
    // 자동 재개가 status를 initializing으로 바꾸고 시동 장벽을 세운 뒤 러너 없이 기다리는 꼴이다.
    const activation = createExecutionActivation();
    void activation.promise.catch(() => undefined);
    const task = markedTask({ status: "initializing", completedAt: undefined, executionActivation: activation });
    const subject = setup(task);

    await subject.coordinator.scanOnce();
    await subject.coordinator.waitForSettled();

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("does not forget a starting task when the registration is already gone from disk and only the mark is cleared", async () => {
    const activation = createExecutionActivation();
    void activation.promise.catch(() => undefined);
    const task = markedTask({
      status: "initializing",
      completedAt: undefined,
      executionActivation: activation,
      rejectedTerminationRegistrationId: "registration-gone",
    });
    const subject = setup(task);

    await subject.coordinator.retireRejectedTerminalRegistration(task, "registration-gone");

    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("forgets the orphan when the registration is already gone from disk and only the mark is cleared", async () => {
    const task = markedTask({ status: "running", completedAt: undefined });
    const subject = setup(task);
    // 디스크에서 등록이 이미 없다: 은퇴할 것이 없고 표시만 지운다.
    await subject.coordinator.retireRejectedTerminalRegistration(task, "registration-gone");
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();

    task.rejectedTerminationRegistrationId = "registration-gone";
    await subject.coordinator.retireRejectedTerminalRegistration(task, "registration-gone");

    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "sess-a" }),
    );
  });
});

describe("card #1266 U5a 자: retiring a registration clears only its own rejected-terminal mark", () => {
  it("keeps the mark another registration left, and does not forget the task that still carries it", async () => {
    // 디스크의 등록(registration-a)은 은퇴하지만 task의 표시는 다른 등록(registration-b)의 것이다.
    const task = markedTask({
      status: "running",
      completedAt: undefined,
      rejectedTerminationRegistrationId: "registration-b",
    });
    const subject = setup(task);

    await subject.coordinator.retireRejectedTerminalRegistration(task, REGISTRATION_ID);

    expect(subject.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(task.rejectedTerminationRegistrationId).toBe("registration-b");
    // 활성이고 러너도 등록도 실행도 없지만 표시가 남아 있어 잊지 않는다.
    expect(subject.forgetRunnerRecoveryTask).not.toHaveBeenCalled();
  });

  it("clears its own mark and forgets the orphan once no other mark remains", async () => {
    const task = markedTask({ status: "running", completedAt: undefined });
    const subject = setup(task);

    await subject.coordinator.retireRejectedTerminalRegistration(task, REGISTRATION_ID);

    expect(task.rejectedTerminationRegistrationId).toBeUndefined();
    expect(subject.forgetRunnerRecoveryTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: "sess-a" }),
    );
  });
});
