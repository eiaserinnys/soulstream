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
import { createInProcessTaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
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
): SessionIsolationTurnGate & { resolveDecision: ReturnType<typeof vi.fn> } {
  return {
    resolveDecision: vi.fn().mockResolvedValue(decision),
    policyDigest: () => "digest-1",
  } as unknown as SessionIsolationTurnGate & { resolveDecision: ReturnType<typeof vi.fn> };
}

describe("TaskExecutor turn isolation gate", () => {
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
});
