import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type {
  EngineExecuteParams,
  EnginePort,
  SSEEventPayload,
} from "../../src/engine/protocol.js";
import type { SessionIsolationTurnGate } from "../../src/security/session_isolation_turn.js";
import {
  createInProcessTaskRunnerRuntime,
  createTaskRunnerRuntime,
  type TaskRunnerRuntime,
} from "../../src/runner/task_runner_runtime.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import { IsolationPreparationPolicyError } from "../../src/runner/session_filesystem_errors.js";
import { RunnerProcessDispatcher } from "../../src/runner/runner_process_dispatcher.js";
import type { RunnerRegistration } from "../../src/runner/runner_process_registry.js";
import { createRunnerProcessRuntimeFactory } from "../../src/runner/runner_process_runtime_factory.js";
import type { RunnerIsolationChildConfig } from "../../src/runner/runner_isolation_config.js";
import type { RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const claudeAgent: AgentProfile = {
  id: "claude-roselin",
  name: "Roselin",
  backend: "claude",
  workspace_dir: "/tmp/claude-roselin",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "sess-1",
    prompt: "initial prompt",
    status: "running",
    profileId: claudeAgent.id,
    createdAt: new Date("2026-11-09T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
    ...overrides,
  };
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

function makeEngine(turns: EngineExecuteParams[]): EnginePort {
  return {
    backendId: "claude",
    workspaceDir: "/tmp/claude-roselin",
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

function makeExecutor(
  engine: EnginePort,
  gate?: SessionIsolationTurnGate,
  runnerProcessFactory?: RunnerProcessRuntimeFactory,
): TaskExecutor {
  const mocks = makeMocks();
  return new TaskExecutor(
    () => engine, // 1 engineFactory
    mocks.db, // 2
    mocks.persistence, // 3
    mocks.broadcaster, // 4
    silentLogger, // 5
    undefined, // 6 contextBuilder
    undefined, // 7 completionNotifier
    undefined, // 8 scheduleToolHandler
    undefined, // 9 claudeRuntimeTaskFollowup
    undefined, // 10 deliveryConsumptionRecorder
    undefined, // 11 modelCatalog
    runnerProcessFactory, // 12 runnerProcessFactory
    undefined, // 13 transientEventLogAggregator
    undefined, // 14 queuedTerminalResume
    undefined, // 15 worktreeResolver
    undefined, // 16 sessionMutations
    undefined, // 17 persistentDecisionRuntime
    undefined, // 18 waitForAttachmentRefs
    undefined, // 19 prepareAttachmentInput
    false, // 20 claudeAccountPoolEnabled
    gate, // 21 sessionIsolation
  );
}

function makeGate(
  decision: Awaited<ReturnType<SessionIsolationTurnGate["resolveDecision"]>>,
  attachedWorktreeIds: readonly string[] = [],
): SessionIsolationTurnGate & {
  resolveDecision: ReturnType<typeof vi.fn>;
  worktreeAttachmentIds: ReturnType<typeof vi.fn>;
} {
  return {
    resolveDecision: vi.fn().mockResolvedValue(decision),
    policyDigest: () => "digest-1",
    worktreeAttachmentIds: vi.fn().mockResolvedValue(attachedWorktreeIds),
  } as unknown as SessionIsolationTurnGate & {
    resolveDecision: ReturnType<typeof vi.fn>;
    worktreeAttachmentIds: ReturnType<typeof vi.fn>;
  };
}

function makeRestrictedRunner(
  engine: EnginePort,
  attachedWorktreeIds: readonly string[],
): TaskRunnerRuntime {
  const base = createInProcessTaskRunnerRuntime(engine);
  return createTaskRunnerRuntime(base.engine, base.dispatcher, "host", {
    tier: "restricted",
    policyDigest: "digest-1",
    attachedWorktreeIds,
  });
}

function makeRecoveredRunner(engine: EnginePort, restricted: boolean): TaskRunnerRuntime {
  const isolation = {
    spec: { policyDigest: "digest-1" },
    attachedWorktreeIds: ["wt-b", "wt-a"],
  } as unknown as RunnerIsolationChildConfig;
  const config = {
    sessionId: "sess-1", agent: claudeAgent, backend: "claude",
    codeSha: "release-test", snapshotPath: "/release/test",
    ...(restricted ? { isolation } : {}),
  };
  const factory = createRunnerProcessRuntimeFactory({
    env: { SOUL_RUNNER_STATE_DIR: "/runner", CLAUDE_ACCOUNT_POOL_ENABLED: false,
      SOUL_RUNNER_LEASE_TIMEOUT_MS: 90000 } as never,
    logger: silentLogger, pumpMux: {} as never, sessionStore: {} as never,
    mcpConfigService: {} as never,
    releasePool: {
      resolveCurrentRelease: vi.fn(), ensureRelease: vi.fn(),
      describe: vi.fn(() => ({ releaseId: "release-test", releaseRoot: "/release",
        runnerModuleRoot: "/release/test" })),
    } as never,
    buildChildProcessEnv: () => ({}),
    spawner: { spawn: vi.fn(), adopt: vi.fn(async () => ({})) } as never,
  });
  // 실제 IPC·파일·프로세스 정리는 호출하지 않는다.
  const initialize = vi.spyOn(
    RunnerProcessDispatcher.prototype as unknown as { initialize(): Promise<void> },
    "initialize",
  ).mockResolvedValue(undefined);
  const recovered = factory.recover!(makeTask(), { config } as never, {
    persistRunState: vi.fn(), persistSessionItems: vi.fn(),
  }, "adopt");
  initialize.mockRestore();
  const fake = createInProcessTaskRunnerRuntime(engine);
  return { ...recovered, engine: fake.engine, dispatcher: fake.dispatcher, eventPersistence: "host" };
}

function makeRestrictedRegistration(): RunnerRegistration {
  return {
    config: {
      sessionId: "sess-1",
      agent: claudeAgent,
      backend: "claude",
      codeSha: "release-test",
      snapshotPath: "/release/test",
      isolation: {
        spec: { policyDigest: "digest-1" },
        attachedWorktreeIds: ["wt-a"],
      } as unknown as RunnerIsolationChildConfig,
    },
  } as unknown as RunnerRegistration;
}

function makeRecoveredProcessRunner(engine: EnginePort) {
  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn(),
    recoverFrames: vi.fn(() => (async function* () {
      yield engineEventFrame({ type: "complete", result: "recovered", timestamp: 1 });
    })()),
    registrationId: vi.fn(() => "registration-1"),
    prepareSession: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    detachHost: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(),
    waitForSessionAck: vi.fn(async () => null),
    recoverPendingInterventions: vi.fn(async () => []),
  };
  const runner: TaskRunnerRuntime = {
    engine,
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
    isolation: {
      tier: "restricted",
      policyDigest: "digest-1",
      attachedWorktreeIds: ["wt-a"],
    },
  };
  return { runner, dispatcher };
}

describe("TaskExecutor turn isolation gate", () => {
  it.each([
    { name: "no gate (mode off)", decision: undefined },
    {
      name: "the turn now decides full",
      decision: {
        sessionId: "sess-1",
        tier: "full",
        policyVersion: 1,
        reason: "trusted",
        presetId: null,
      } as const,
    },
  ])(
    "adopts a stored restricted runner when isolation changed since the turn started ($name)",
    async ({ decision }) => {
      const { runner, dispatcher } = makeRecoveredProcessRunner(makeEngine([]));
      const registration = makeRestrictedRegistration();
      const recover = vi.fn(
        (..._args: Parameters<NonNullable<RunnerProcessRuntimeFactory["recover"]>>) => runner,
      );
      const factory = vi.fn(() => {
        throw new Error("adoption must not spawn a fresh runner");
      }) as unknown as RunnerProcessRuntimeFactory;
      factory.recover = recover;
      factory.isolationSupported = true;
      const gate = decision === undefined ? undefined : makeGate(decision);
      const executor = makeExecutor(makeEngine([]), gate, factory);
      const task = makeTask();
      const attempts: TaskRunnerRuntime[] = [];

      const completion = executor.recoverRegisteredRunner(
        task,
        registration,
        "execute-old",
        "adopt",
        (attempt) => {
          attempts.push(attempt);
          return undefined;
        },
      );

      await expect(completion).resolves.toBeUndefined();

      expect(recover).toHaveBeenCalledOnce();
      expect(recover.mock.calls[0]?.[1]).toBe(registration);
      expect(recover.mock.calls[0]?.[3]).toBe("adopt");
      expect(dispatcher.recoverFrames).toHaveBeenCalledWith("execute-old", undefined);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.isolation?.tier).toBe("restricted");
      if (gate) expect(gate.resolveDecision).not.toHaveBeenCalled();
      expect(task.executionSecurity).toBeUndefined();
    },
  );

  it.each([
    { name: "reuses recovered restricted for the same restricted turn", stored: true, tier: "restricted", reused: true },
    { name: "replaces recovered restricted for a full turn", stored: true, tier: "full", reused: false },
    { name: "reuses recovered full for a full turn", stored: false, tier: "full", reused: true },
  ] as const)("$name", async ({ stored, tier, reused }) => {
    const retainedTurns: EngineExecuteParams[] = [];
    const freshTurns: EngineExecuteParams[] = [];
    const retained = makeRecoveredRunner(makeEngine(retainedTurns), stored);
    if (stored) expect(retained.isolation).toEqual({
      tier: "restricted", policyDigest: "digest-1", attachedWorktreeIds: ["wt-a", "wt-b"],
    });
    else expect(retained.isolation?.tier ?? "full").toBe("full");
    const gate = makeGate({
      sessionId: "sess-1", tier, policyVersion: 1,
      reason: tier === "restricted" ? "untrusted-preset" : "trusted", presetId: null,
    }, ["wt-b", "wt-a"]);
    const factory = vi.fn(() => createInProcessTaskRunnerRuntime(makeEngine(freshTurns))) as unknown as RunnerProcessRuntimeFactory;
    factory.isolationSupported = true;
    const executor = makeExecutor(makeEngine([]), gate, factory);
    const task = makeTask({ runner: retained, runnerRetainedForDetachedWork: true });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(retainedTurns).toHaveLength(reused ? 1 : 0);
    expect(freshTurns).toHaveLength(reused ? 0 : 1);
    expect(factory).toHaveBeenCalledTimes(reused ? 0 : 1);
  });
  it("does not resolve isolation when no gate is wired (mode off)", async () => {
    const turns: EngineExecuteParams[] = [];
    const executor = makeExecutor(makeEngine(turns));
    const task = makeTask();

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turns).toHaveLength(1);
    expect(task.executionSecurity).toBeUndefined();
    expect(task.status).toBe("completed");
  });

  it("resolves exactly once with the effective preset for a CLI session", async () => {
    const turns: EngineExecuteParams[] = [];
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "full",
      policyVersion: 1,
      reason: "trusted",
      presetId: "claude-opus",
    });
    const executor = makeExecutor(makeEngine(turns), gate);
    const task = makeTask({ modelPreset: "claude-opus", modelPresetBackend: "claude" });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(gate.resolveDecision).toHaveBeenCalledTimes(1);
    expect(gate.resolveDecision).toHaveBeenCalledWith("sess-1", "claude-opus");
    expect(task.executionSecurity).toMatchObject({ tier: "full" });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.executionSecurity).toMatchObject({ tier: "full" });
  });

  it("never resolves isolation for an LLM proxy session", async () => {
    const turns: EngineExecuteParams[] = [];
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: null,
    });
    const executor = makeExecutor(makeEngine(turns), gate);
    const task = makeTask({ sessionType: "llm" });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(gate.resolveDecision).not.toHaveBeenCalled();
    expect(task.executionSecurity).toBeUndefined();
    expect(turns).toHaveLength(1);
  });

  it("fails the turn with the isolation code instead of falling back to full", async () => {
    const turns: EngineExecuteParams[] = [];
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    });
    const executor = makeExecutor(makeEngine(turns), gate);
    const task = makeTask({ modelPreset: "deepseek-flash-4.1", modelPresetBackend: "claude" });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(gate.resolveDecision).toHaveBeenCalledTimes(1);
    expect(turns).toHaveLength(0);
    expect(task.executionSecurity).toMatchObject({ tier: "restricted" });
    const errorText = `${task.error ?? ""}`;
    expect(errorText).toContain("SESSION_ISOLATION_UNAVAILABLE");
  });

  it("surfaces the isolation code when the decision itself is unavailable", async () => {
    const turns: EngineExecuteParams[] = [];
    const gate = {
      resolveDecision: vi.fn().mockRejectedValue(
        new IsolationPreparationPolicyError("policy file is missing"),
      ),
      policyDigest: () => "digest-1",
      worktreeAttachmentIds: vi.fn().mockResolvedValue([]),
    } as unknown as SessionIsolationTurnGate;
    const executor = makeExecutor(makeEngine(turns), gate);
    const task = makeTask({ modelPreset: "claude-opus", modelPresetBackend: "claude" });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(turns).toHaveLength(0);
    expect(`${task.error ?? ""}`).toContain("ISOLATION_POLICY_UNAVAILABLE");
  });

  it("never creates a full runner for a restricted turn when the factory cannot isolate", async () => {
    const turns: EngineExecuteParams[] = [];
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    });
    let factoryCalls = 0;
    const factory = (() => {
      factoryCalls += 1;
      return createInProcessTaskRunnerRuntime(makeEngine(turns));
    }) as RunnerProcessRuntimeFactory;
    const executor = makeExecutor(makeEngine(turns), gate, factory);
    const task = makeTask({ modelPreset: "deepseek-flash-4.1", modelPresetBackend: "claude" });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(factoryCalls).toBe(0);
    expect(turns).toHaveLength(0);
    expect(`${task.error ?? ""}`).toContain("SESSION_ISOLATION_UNAVAILABLE");
  });

  it("reuses a retained restricted runner when the mount set is unchanged", async () => {
    const retainedTurns: EngineExecuteParams[] = [];
    const retained = makeRestrictedRunner(makeEngine(retainedTurns), ["wt-a"]);
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    }, ["wt-a"]);
    let factoryCalls = 0;
    const factory = (() => {
      factoryCalls += 1;
      return createInProcessTaskRunnerRuntime(makeEngine([]));
    }) as RunnerProcessRuntimeFactory;
    factory.isolationSupported = true;
    const executor = makeExecutor(makeEngine([]), gate, factory);
    const task = makeTask({
      modelPreset: "deepseek-flash-4.1",
      modelPresetBackend: "claude",
      runner: retained,
      runnerRetainedForDetachedWork: true,
    });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(gate.worktreeAttachmentIds).toHaveBeenCalledWith("sess-1", undefined);
    expect(factoryCalls).toBe(0);
    expect(retainedTurns).toHaveLength(1);
  });

  it("drops a retained restricted runner when the mount set changed", async () => {
    const retainedTurns: EngineExecuteParams[] = [];
    const retained = makeRestrictedRunner(makeEngine(retainedTurns), ["wt-a"]);
    const freshTurns: EngineExecuteParams[] = [];
    const gate = makeGate({
      sessionId: "sess-1",
      tier: "restricted",
      policyVersion: 1,
      reason: "untrusted-preset",
      presetId: "deepseek-flash-4.1",
    }, ["wt-a", "wt-b"]);
    let factoryCalls = 0;
    const factory = (() => {
      factoryCalls += 1;
      return createInProcessTaskRunnerRuntime(makeEngine(freshTurns));
    }) as RunnerProcessRuntimeFactory;
    factory.isolationSupported = true;
    const executor = makeExecutor(makeEngine([]), gate, factory);
    const task = makeTask({
      modelPreset: "deepseek-flash-4.1",
      modelPresetBackend: "claude",
      runner: retained,
      runnerRetainedForDetachedWork: true,
    });

    executor.startNewExecution(task, claudeAgent);
    await task.executionPromise;

    expect(factoryCalls).toBe(1);
    expect(retainedTurns).toHaveLength(0);
    expect(freshTurns).toHaveLength(1);
  });
});
