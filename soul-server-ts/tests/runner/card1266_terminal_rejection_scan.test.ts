import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { RunnerRecoveryCoordinator } from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { TaskLifecycleTransition } from "../../src/task/task_lifecycle_transition.js";
import { TaskRunnerRecovery } from "../../src/task/task_runner_recovery.js";
import type { Task } from "../../src/task/task_models.js";

/**
 * 카드 #1266 U2a, 별건 7. 서버가 사유도 종료 사건 번호도 없이 거절하는 종료(서버가 스스로 닫은
 * 세션, 운영 첫 거절의 꼴)가 주기 훑기와 재시작에서 다시 올라가지 않는다. 시험 코드가
 * 표시 검사를 흉내 내지 않고 실제 RunnerRecoveryCoordinator.scanOnce를 돌린다.
 */

const NOW_MS = Date.parse("2026-08-11T00:00:30.000Z");

function registration(options: {
  sessionId?: string;
  pidAlive?: boolean;
  lifecycleState?: "running" | "completed" | "failed" | "reaped" | "closed";
  progressedAt?: string;
  terminalError?: { code: string; message: string } | null;
} = {}): RunnerRegistration {
  const sessionId = options.sessionId ?? "session-a";
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "codex",
      agent: {
        id: "agent-a",
        name: "Agent A",
        backend: "codex",
        workspace_dir: "/workspace/a",
      },
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
    registrationId: "registration-a",
    pidStartIdentity: "start-4123",
    pidAlive: options.pidAlive ?? true,
    registeredAtMs: Date.parse("2026-08-11T00:00:00.000Z"),
    bootstrap: {
      stream_id: `stream-${sessionId}`,
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: `backend-${sessionId}`,
        cwd: "/workspace/a",
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-a",
        snapshot_path: "/release/sha-a/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-11T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 4123,
      execution_command_id: "execute-a",
      execution_state: options.lifecycleState ?? "running",
      progress_seq: 3,
      progress_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      liveness_at: options.progressedAt ?? "2026-08-11T00:00:20.000Z",
      in_flight_tools: [],
      terminal_error: options.terminalError ?? null,
    },
  };
}

/** 디스크에 남은 러너 등록 상태다. 재시작해도 이 객체는 그대로다. */
interface Disk {
  registrations: RunnerRegistration[];
}

function freshTask(): Task {
  return {
    agentSessionId: "session-a",
    prompt: "continue",
    status: "running",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

/** 노드 프로세스 하나다. 서버 쪽 세션은 이미 interrupted로 닫혀 있다. */
function boot(disk: Disk, enqueue: ReturnType<typeof vi.fn>, options: { failFirstRetire?: boolean } = {}) {
  const task = freshTask();
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  let failRetire = options.failFirstRetire === true;
  const retireTerminalRegistration = vi.fn(async (_paths: unknown, registrationId: string | null) => {
    if (failRetire) {
      failRetire = false;
      throw new Error("retire failed once");
    }
    for (const entry of disk.registrations) {
      if (entry.registrationId === registrationId) entry.retiredAt = "2026-08-11T00:00:31.000Z";
    }
  });
  let coordinator!: RunnerRecoveryCoordinator;
  const lifecycle = new TaskLifecycleTransition({
    logger: pino({ level: "silent" }),
    persistence: { enqueueTerminalTransitionAndWaitForApplication: enqueue } as never,
    retireRejectedRegistration: async (rejected, registrationId) =>
      await coordinator.retireRejectedTerminalRegistration(rejected, registrationId),
  });
  const recovery = new TaskRunnerRecovery({
    getTask: () => task,
    loadTask: async () => task,
    rememberTask: () => {},
    lifecycleTransition: lifecycle,
    logger: { warn: vi.fn() },
  });
  coordinator = new RunnerRecoveryCoordinator({
    nodeId: "node-a",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    closedTailDrainer: { drain: vi.fn(async () => {}) },
    logger,
    spawner: {
      terminate: vi.fn(async () => {}),
      invalidateRegistration: vi.fn(async () => {}),
      retireTerminalRegistration,
    },
    scan: async () => structuredClone({ registrations: disk.registrations, errors: [] }),
    hydrate: async (registration: RunnerRegistration) => registration,
    now: () => NOW_MS,
    taskManager: {
      hydrateRunnerRecoveryTask: vi.fn(async () => task),
      markRunnerFailure: vi.fn(async () => {}),
      projectClosedRunner: async (owned: Task, detail: string) =>
        await recovery.projectClosed(owned, detail),
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
  return { coordinator, task, retireTerminalRegistration };
}

/** 사유 없음, 정본 termination_event_id null, 서버 세션은 이미 interrupted/node_disconnect_timeout. */
function serverClosedRejection() {
  return vi.fn(async (..._args: unknown[]) => ({
    eventId: 247,
    applied: false,
    canonicalSession: {
      status: "interrupted",
      termination_reason: "killed",
      termination_detail: "node_disconnect_timeout",
      review_state: "not_required",
      last_assistant_text: null,
      termination_event_id: null,
      updated_at: "2026-08-11T00:00:10.000Z",
      last_event_id: 246,
    },
    canonicalExecutionRegistration: null,
  }));
}

async function scan(coordinator: RunnerRecoveryCoordinator, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await coordinator.scanOnce();
    await coordinator.waitForSettled();
  }
}

describe("card #1266 U2a rejected terminal does not repeat", () => {
  it("submits the rejected terminal once across many periodic scans and retires its registration", async () => {
    const disk: Disk = { registrations: [registration({ pidAlive: false, lifecycleState: "closed" })] };
    const enqueue = serverClosedRejection();
    const node = boot(disk, enqueue);

    await scan(node.coordinator, 6);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(node.retireTerminalRegistration).toHaveBeenCalledOnce();
    expect(disk.registrations[0]!.retiredAt).toBeDefined();
  });

  it("submits it zero more times after a restart over the same disk state", async () => {
    const disk: Disk = { registrations: [registration({ pidAlive: false, lifecycleState: "closed" })] };
    const enqueue = serverClosedRejection();
    await scan(boot(disk, enqueue).coordinator, 2);
    expect(enqueue).toHaveBeenCalledOnce();

    // 거절 직후 재시작한다. 코디네이터와 task를 새로 만들어 같은 디스크 상태를 훑는다.
    const restarted = boot(disk, enqueue);
    await scan(restarted.coordinator, 3);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(restarted.retireTerminalRegistration).not.toHaveBeenCalled();
  });

  it("retires on the next scan when the first retirement failed, still without resubmitting", async () => {
    const disk: Disk = { registrations: [registration({ pidAlive: false, lifecycleState: "closed" })] };
    const enqueue = serverClosedRejection();
    const node = boot(disk, enqueue, { failFirstRetire: true });

    await scan(node.coordinator, 4);

    expect(enqueue).toHaveBeenCalledOnce();
    expect(node.retireTerminalRegistration).toHaveBeenCalledTimes(2);
    expect(disk.registrations[0]!.retiredAt).toBeDefined();
    expect(node.task.rejectedTerminationRegistrationId).toBeUndefined();
  });
});
