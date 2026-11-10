import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { Env } from "../../src/config.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import { composeSessionIsolation } from
  "../../src/runtime/session_isolation_composition.js";
import { composeTaskRuntime } from "../../src/runtime/task_runtime_composition.js";
import { prepareRecoveredTask } from "../../src/runner/runner_recovery_task.js";
import {
  createInProcessTaskRunnerRuntime,
  createTaskRunnerRuntime,
  type TaskRunnerRuntime,
} from "../../src/runner/task_runner_runtime.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { IsolationPreparationPolicyError } from
  "../../src/runner/session_filesystem_errors.js";
import type { SessionIsolationTurnGate } from
  "../../src/security/session_isolation_turn.js";
import { AutoResumeTransition } from "../../src/task/task_auto_resume_transition.js";
import { TaskDeliveryLedgerGate } from "../../src/task/task_delivery_ledger_gate.js";
import type { RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import {
  createExecutionActivation,
  type InterventionMessage,
  type Task,
} from "../../src/task/task_models.js";
import type { TaskManager } from "../../src/task/task_manager.js";
import { TransientEventLogAggregator } from
  "../../src/task/transient_event_log_aggregator.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const isolationModuleMocks = vi.hoisted(() => ({
  prepareIsolationPlan: vi.fn(async (input: Record<string, unknown>) => ({
    spec: {
      sessionId: input.sessionId,
      workspaceDir: input.workspaceDir,
      scratchWorkspaceDir: input.scratchWorkspaceDir,
      bindings: [],
      masks: [],
    },
    sanitizedServers: [],
    env: {},
    resolvConfPath: "/etc/resolv.conf",
    contextNotice: "",
  })),
  createIsolationHostPorts: vi.fn(() => ({
    resolveGitCommonDir: async (repositoryPath: string) => `/git-common${repositoryPath}`,
    detectWsl: async () => false,
  })),
}));
vi.mock("../../src/runner/session_filesystem_plan.js", () => ({
  prepareIsolationPlan: isolationModuleMocks.prepareIsolationPlan,
}));
vi.mock("../../src/runner/session_isolation_host_ports.js", () => ({
  createIsolationHostPorts: isolationModuleMocks.createIsolationHostPorts,
}));

const silentLogger = pino({ level: "silent" });

const PROFILE_WORKSPACE = "/agents/profile-w";
const ATTACHED_WORKTREE = "/projects/soulstream--attachment-t";

const profileAgent: AgentProfile = {
  id: "profile-w",
  name: "Profile W",
  backend: "opencode",
  workspace_dir: PROFILE_WORKSPACE,
  env: { PROFILE_ENV_MARKER: "from-profile" },
};

/** prepareRecoveredTask restores the registration agent, already the worktree. */
const restoredAgent: AgentProfile = {
  ...profileAgent,
  workspace_dir: ATTACHED_WORKTREE,
};

const restrictedDecision = {
  sessionId: "sess-1",
  tier: "restricted",
  policyVersion: 1,
  reason: "untrusted-preset",
  presetId: null,
} as const;

function makeEngine(turns: EngineExecuteParams[]): EnginePort {
  return {
    backendId: "opencode",
    workspaceDir: ATTACHED_WORKTREE,
    async *execute(params): AsyncIterable<SSEEventPayload> {
      turns.push(params);
      yield {
        type: "assistant_message",
        content: "done",
        timestamp: 1,
      } as SSEEventPayload;
      yield { type: "complete", result: "done", timestamp: 2 } as SSEEventPayload;
    },
    async interrupt() { return true; },
    async close() {},
    async intervene() {
      return {
        status: "not_delivered",
        mechanism: "interrupt_then_next_turn",
        reason: "next_turn_required",
      };
    },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "previous prompt",
    status: "completed",
    profileId: profileAgent.id,
    createdAt: new Date("2026-11-09T00:00:00.000Z"),
    lastEventId: 12,
    lastReadEventId: 0,
    terminalEventId: 12,
    terminationReason: "completed_ok",
    interventionQueue: [],
    ...overrides,
  };
}

function makeRegistration(): RunnerRegistration {
  return {
    config: {
      sessionId: "sess-1",
      agent: restoredAgent,
      backend: "opencode",
      codeSha: "release-test",
      snapshotPath: "/release/test",
    },
  } as unknown as RunnerRegistration;
}

function makeGate(): SessionIsolationTurnGate & {
  resolveDecision: ReturnType<typeof vi.fn>;
} {
  return {
    resolveDecision: vi.fn().mockResolvedValue(restrictedDecision),
    policyDigest: () => "digest-1",
    worktreeAttachmentIds: vi.fn().mockResolvedValue(["wt-1"]),
  } as unknown as SessionIsolationTurnGate & {
    resolveDecision: ReturnType<typeof vi.fn>;
  };
}

function makeEnv(): Env {
  return {
    SOULSTREAM_NODE_ID: "node-test",
    SOULSTREAM_UPSTREAM_URL: "ws://localhost:5200/ws/node",
    EVENT_OUTBOX_DIR: "/tmp/soulstream-event-outbox-test",
    CLAUDE_SESSION_RUNTIME_V2_ENABLED: false,
    CLAUDE_ACCOUNT_POOL_ENABLED: false,
    SESSION_ISOLATION_MODE: "enforce",
    SESSION_ISOLATION_PASTA_PATH: "/usr/bin/pasta",
    MCP_REQUIRE_AUTH: true,
    SOUL_RUNNER_STATE_DIR: "/runner",
    WORKTREE_PROJECTS_ROOT: "/projects",
    MCP_INTERNAL_PORT: 4308,
    MCP_PATH: "/mcp",
    AUTH_BEARER_TOKEN: "host-bearer",
  } as unknown as Env;
}

function makeMocks() {
  const persistenceDouble = makeEventPersistenceTestDouble(async () => undefined);
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  return { ...persistenceDouble, db, broadcaster };
}

function makeWorktreeService() {
  return {
    listSessionAttachments: vi.fn(async () => [{
      worktreeId: "wt-1",
      repoId: "repo-a",
      path: ATTACHED_WORKTREE,
      discoveryKind: "managed",
      dbState: "ready",
      ownerKind: "session",
      ownerId: "sess-1",
      activeSessionId: "sess-1",
    }]),
    listRepositoryIds: vi.fn(() => ["repo-a"]),
  };
}

function makeScheduleService() {
  return {
    makeToolHandler: vi.fn(() => vi.fn()),
    touchNodeHeartbeat: vi.fn().mockResolvedValue(undefined),
    repairExpiredClaims: vi.fn().mockResolvedValue([]),
    restoreOrphanSchedulesForLiveNodes: vi.fn().mockResolvedValue([]),
    markOrphanDueSchedules: vi.fn().mockResolvedValue([]),
    claimDueSchedules: vi.fn().mockResolvedValue([]),
    consumeClaimedSchedule: vi.fn(),
    confirmScheduleStillFiring: vi.fn(),
    deferDispatch: vi.fn(),
    finishDispatch: vi.fn(),
    failDispatch: vi.fn(),
  };
}

function userMessage(overrides: Partial<InterventionMessage> = {}): InterventionMessage {
  return {
    text: "next user turn",
    user: "user",
    deliveryId: "delivery-next",
    // A user message that survives to a later turn is a controlled delivery;
    // the ledger gate ignores intents outside DELIVERY_INTENTS.
    deliveryIntent: "human_live_steer",
    ...overrides,
  };
}

async function flushDrain(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("recovered isolated execution workspace", () => {
  it.each([
    { name: "user message", runtimeFollowup: false },
    { name: "runtime followup", runtimeFollowup: true },
  ])(
    "resumes a $name on the profile workspace and the attached worktree",
    async ({ runtimeFollowup }) => {
      vi.clearAllMocks();
      const turns: EngineExecuteParams[] = [];
      const engine = makeEngine(turns);
      const mocks = makeMocks();
      const gate = makeGate();
      const message = userMessage(runtimeFollowup
        ? { text: "runtime followup", deliveryIntent: "runtime_followup" }
        : {});
      const task = makeTask({
        worktreeId: "wt-1",
        interventionQueue: runtimeFollowup ? [message] : [],
      });
      prepareRecoveredTask(task, makeRegistration());

      const isolation = composeSessionIsolation({
        env: makeEnv(),
        worktreeService: makeWorktreeService() as never,
        mcpConfigService: { resolveMcpProfile: vi.fn(() => null) } as never,
      });
      expect(isolation).toBeDefined();
      const preparations: Array<Promise<unknown>> = [];
      const factoryCalls: Array<{
        profileWorkspaceDir: string | undefined;
        agentWorkspaceDir: string;
      }> = [];
      const factory = ((factoryTask: Task, factoryAgent: AgentProfile) => {
        factoryCalls.push({
          profileWorkspaceDir: factoryTask.profileWorkspaceDir,
          agentWorkspaceDir: factoryAgent.workspace_dir,
        });
        const preparation = isolation!.host.prepare({
          task: factoryTask,
          agent: factoryAgent,
          backend: "opencode",
        });
        void preparation.catch(() => undefined);
        preparations.push(preparation);
        const base = createInProcessTaskRunnerRuntime(engine);
        return createTaskRunnerRuntime(
          base.engine,
          base.dispatcher,
          "host",
          {
            tier: "restricted",
            policyDigest: "digest-1",
            attachedWorktreeIds: ["wt-1"],
          },
        );
      }) as unknown as RunnerProcessRuntimeFactory;
      factory.isolationSupported = true;
      const worktreeResolver = {
        resolveExecutionWorkspace: vi.fn(async () => ATTACHED_WORKTREE),
      };
      const taskManager = {
        resolveExecutionSecurity: vi.fn().mockResolvedValue(restrictedDecision),
        resumeQueuedAfterTerminal: vi.fn().mockResolvedValue(false),
        getDeliveryConsumptionRecorder: vi.fn(),
        persistentSessions: {},
      } as unknown as TaskManager;
      const composition = composeTaskRuntime({
        env: makeEnv(),
        db: mocks.db,
        logger: silentLogger,
        agentRegistry: {
          get: vi.fn((id: string) => id === profileAgent.id ? profileAgent : undefined),
        } as never,
        taskManager,
        engineFactory: (() => engine) as never,
        modelCatalog: { resolve: vi.fn(() => undefined) } as never,
        contextBuilder: undefined as never,
        persistence: mocks.persistence,
        broadcaster: mocks.broadcaster,
        scheduleService: makeScheduleService() as never,
        orchProxyConfig: { baseUrl: "http://localhost:5200", headers: {} },
        runnerProcessFactory: factory,
        worktreeResolver: worktreeResolver as never,
        transientEventLogAggregator: new TransientEventLogAggregator(silentLogger),
        sessionIsolation: isolation,
      });
      const transition = new AutoResumeTransition({
        logger: silentLogger,
        persistence: mocks.persistence,
      });

      try {
        if (runtimeFollowup) {
          await expect(
            transition.resumeQueuedAfterTerminal(task, composition.onResume),
          ).resolves.toBe(true);
        } else {
          await transition.resume(task, message, composition.onResume);
        }
        await task.executionPromise;
        await flushDrain();
        await preparations[0];
      } finally {
        composition.scheduleDispatcher.stop();
      }

      expect(turns).toHaveLength(1);
      expect(turns[0]?.prompt).toBe(message.text);
      expect(worktreeResolver.resolveExecutionWorkspace)
        .toHaveBeenCalledWith("wt-1");
      expect(factoryCalls).toEqual([{
        profileWorkspaceDir: PROFILE_WORKSPACE,
        agentWorkspaceDir: ATTACHED_WORKTREE,
      }]);
      expect(task.profileWorkspaceDir).toBe(PROFILE_WORKSPACE);
      expect(task.resolvedWorkspaceDir).toBe(ATTACHED_WORKTREE);
      // The restored snapshot stays the worktree agent; only the host root comes
      // from the registry profile.
      expect(task.agentProfileSnapshot).toBe(restoredAgent);
      expect(task.agentProfileSnapshot?.env).toEqual(profileAgent.env);
      expect(task.status).toBe("completed");

      const planInput = isolationModuleMocks.prepareIsolationPlan
        .mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(planInput.hostWorkspaceRoot).toBe(PROFILE_WORKSPACE);
      expect(planInput.workspaceDir).toBe(ATTACHED_WORKTREE);
      expect(planInput.scratchWorkspaceDir).toBe(ATTACHED_WORKTREE);
      expect(planInput.decision).toBe(restrictedDecision);
    },
  );
});

describe("execution preparation failure", () => {
  /**
   * The real ledger gate over a recording repository, so the executor must go
   * through the actual controlled-delivery filter and markUncertain path.
   */
  function makeLedger() {
    const repository = {
      get: vi.fn(),
      markUncertain: vi.fn().mockResolvedValue({}),
      markConsumed: vi.fn().mockResolvedValue(true),
      markConsumedByRelation: vi.fn(),
      recordRelationConsumed: vi.fn(),
      markPendingSuperseded: vi.fn(),
    };
    const gate = new TaskDeliveryLedgerGate(true, repository as never);
    return { gate, repository };
  }

  /**
   * A real in-process dispatcher whose identity proof fails exactly like a
   * restricted runner whose isolation preparation rejected before spawn.
   */
  function makeFailureExecutor(options: {
    failure: unknown;
    ledger: ReturnType<typeof makeLedger>;
    queuedTerminalResume?: ReturnType<typeof vi.fn>;
    failOnceOnly?: boolean;
  }) {
    const mocks = makeMocks();
    const turns: EngineExecuteParams[] = [];
    const engine = makeEngine(turns);
    const base = createInProcessTaskRunnerRuntime(engine);
    const prepareExecutionIdentity = vi.spyOn(
      base.dispatcher as unknown as { prepareExecutionIdentity(): Promise<unknown> },
      "prepareExecutionIdentity",
    );
    const identity = {
      registrationId: "registration-retry",
      pid: process.pid,
      startIdentity: "start-retry",
      executionCommandId: "exec-retry",
    };
    if (options.failOnceOnly) {
      prepareExecutionIdentity
        .mockRejectedValueOnce(options.failure)
        .mockResolvedValue(identity);
    } else {
      prepareExecutionIdentity.mockRejectedValue(options.failure);
    }
    const gate = makeGate();
    const factory = (() => ({
      engine: base.engine,
      dispatcher: base.dispatcher,
      eventPersistence: "host",
    })) as unknown as RunnerProcessRuntimeFactory;
    factory.isolationSupported = true;
    const executor = new TaskExecutor(
      () => engine,
      mocks.db,
      mocks.persistence,
      mocks.broadcaster,
      silentLogger,
      undefined,
      undefined,
      undefined,
      undefined,
      options.ledger.gate,
      undefined,
      factory,
      undefined,
      options.queuedTerminalResume,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      gate,
      { resolveProfileWorkspace: () => PROFILE_WORKSPACE },
    );
    return { executor, turns, mocks, gate, prepareExecutionIdentity };
  }

  it("closes a deterministic preparation failure as one error terminal", async () => {
    const failure = new IsolationPreparationPolicyError("policy unavailable");
    const ledger = makeLedger();
    const queuedTerminalResume = vi.fn();
    const { executor, turns, mocks, prepareExecutionIdentity } = makeFailureExecutor({
      failure,
      ledger,
      queuedTerminalResume,
    });
    const task = makeTask({ interventionQueue: [userMessage({ deliveryId: "delivery-other" })] });
    prepareRecoveredTask(task, makeRegistration());
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: mocks.persistence,
    });
    const message = userMessage({ deliveryId: "delivery-failed" });
    let activation: ReturnType<typeof createExecutionActivation> | undefined;
    const onResume = (resumed: Task, resumedActivation?: typeof activation) => {
      activation = resumedActivation;
      return executor.startNewExecution(resumed, restoredAgent, resumedActivation);
    };

    await transition.resume(task, message, onResume);
    await expect(activation!.promise).rejects.toThrow("policy unavailable");
    await flushDrain();

    expect(turns).toHaveLength(0);
    expect(prepareExecutionIdentity).toHaveBeenCalledOnce();
    // Never consumed: the delivery was admitted but no turn ran, so the ledger
    // records it as uncertain under its own id.
    expect(ledger.repository.markConsumed).not.toHaveBeenCalled();
    expect(ledger.repository.markUncertain).toHaveBeenCalledOnce();
    expect(ledger.repository.markUncertain).toHaveBeenCalledWith(
      "delivery-failed",
      undefined,
      "ISOLATION_POLICY_UNAVAILABLE: policy unavailable",
    );
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    const terminalEffect = mocks.enqueueTerminalTransitionAndWaitForApplication
      .mock.calls[0]?.[2];
    expect(terminalEffect).toMatchObject({
      status: "error",
      termination_reason: "error_aborted",
      termination_detail: "ISOLATION_POLICY_UNAVAILABLE: policy unavailable",
    });
    expect(task.status).toBe("error");
    expect(task.error).toBe("ISOLATION_POLICY_UNAVAILABLE: policy unavailable");
    expect(task.interventionQueue.map((queued) => queued.deliveryId))
      .toEqual(["delivery-other"]);
    expect(task.queuedTerminalResumeBlocked).toBe(true);
    expect(queuedTerminalResume).not.toHaveBeenCalled();
  });

  it("restores the previous terminal when an ordinary failure rolls back the admission", async () => {
    const failure = new Error("admission race lost");
    const ledger = makeLedger();
    const queuedTerminalResume = vi.fn();
    const { executor, turns, mocks } = makeFailureExecutor({
      failure,
      ledger,
      queuedTerminalResume,
    });
    const task = makeTask();
    prepareRecoveredTask(task, makeRegistration());
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: mocks.persistence,
    });
    const message = userMessage({ deliveryId: "delivery-race" });
    let activation: ReturnType<typeof createExecutionActivation> | undefined;
    const onResume = (resumed: Task, resumedActivation?: typeof activation) => {
      activation = resumedActivation;
      return executor.startNewExecution(resumed, restoredAgent, resumedActivation);
    };

    await transition.resume(task, message, onResume);
    await expect(activation!.promise).rejects.toThrow("admission race lost");
    await flushDrain();

    expect(turns).toHaveLength(0);
    // An ordinary admission race keeps the delivery queued for its retry.
    expect(ledger.repository.markUncertain).not.toHaveBeenCalled();
    expect(ledger.repository.markConsumed).not.toHaveBeenCalled();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication).toHaveBeenCalledOnce();
    expect(mocks.enqueueTerminalTransitionAndWaitForApplication.mock.calls[0]?.[2])
      .toMatchObject({ status: "completed", termination_reason: "completed_ok" });
    expect(task.status).toBe("completed");
    expect(task.interventionQueue.map((queued) => queued.deliveryId))
      .toEqual(["delivery-race"]);
    expect(task.queuedTerminalResumeBlocked).toBeUndefined();
  });

  it("reopens the drain on an explicit retry", async () => {
    const failure = new IsolationPreparationPolicyError("policy unavailable");
    const ledger = makeLedger();
    const queuedTerminalResume = vi.fn();
    const { executor, turns, mocks, gate } = makeFailureExecutor({
      failure,
      ledger,
      queuedTerminalResume,
      failOnceOnly: true,
    });
    const task = makeTask({ interventionQueue: [userMessage({ deliveryId: "delivery-other" })] });
    prepareRecoveredTask(task, makeRegistration());
    const transition = new AutoResumeTransition({
      logger: silentLogger,
      persistence: mocks.persistence,
    });
    const message = userMessage({ deliveryId: "delivery-failed" });
    let activation: ReturnType<typeof createExecutionActivation> | undefined;
    await transition.resume(task, message, (resumed, resumedActivation) => {
      activation = resumedActivation;
      return executor.startNewExecution(resumed, restoredAgent, resumedActivation);
    });
    await expect(activation!.promise).rejects.toThrow("policy unavailable");
    await flushDrain();
    expect(task.queuedTerminalResumeBlocked).toBe(true);

    gate.resolveDecision.mockResolvedValue({
      sessionId: "sess-1",
      tier: "full",
      policyVersion: 1,
      reason: "trusted",
      presetId: null,
    });
    const retryActivation = createExecutionActivation();
    await executor.startNewExecution(task, restoredAgent, retryActivation);
    await retryActivation.promise;
    await flushDrain();

    expect(turns).toHaveLength(1);
    // The explicit start cleared the block; the input that survived the failure
    // is the one the retry turn consumes, and it is consumed, not replayed.
    expect(turns[0]?.prompt).toContain("next user turn");
    expect(task.queuedTerminalResumeBlocked).toBeUndefined();
    expect(task.status).toBe("completed");
    expect(task.interventionQueue).toEqual([]);
    expect(ledger.repository.markConsumed.mock.calls[0]?.[0]).toBe("delivery-other");
    expect(queuedTerminalResume).not.toHaveBeenCalled();
  });
});
