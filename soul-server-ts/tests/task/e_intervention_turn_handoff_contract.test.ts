import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import {
  ClaudeEngineAdapter,
  ClaudeSdkClient,
} from "../../src/engine/claude_adapter.js";
import { ClaudeSessionClientRegistry } from
  "../../src/engine/claude_session_client_registry.js";
import type { SSEEventPayload } from "../../src/engine/protocol.js";
import {
  engineEventFrame,
  runnerCommandResultFrame,
  type RunnerCommandFrame,
} from "../../src/runner/frame_protocol.js";
import { RunnerProcessDispatcher } from
  "../../src/runner/runner_process_dispatcher.js";
import { RunnerProcessEngineProxy } from
  "../../src/runner/runner_process_engine_proxy.js";
import {
  RunnerRecoveryCoordinator,
  type RunnerRecoveryCoordinatorOptions,
} from "../../src/runner/runner_recovery_coordinator.js";
import type { RunnerRegistration } from
  "../../src/runner/runner_process_registry.js";
import { createTaskRunnerRuntime } from
  "../../src/runner/task_runner_runtime.js";
import { RunningInterventionTransition } from
  "../../src/task/task_running_intervention_transition.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import {
  makeHarness,
  sdkInit,
  sdkInterruptedResult,
  sdkResult,
  sdkTaskNotificationResult,
} from "../engine/claude_sdk_persistent_test_harness.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const silentLogger = pino({ level: "silent" });

const agent: AgentProfile = {
  id: "claude-lane-e",
  name: "Claude Lane E",
  backend: "claude",
  workspace_dir: "/tmp/claude-lane-e",
};

function makeTask(sessionId: string): Task {
  return {
    agentSessionId: sessionId,
    prompt: "foreground work",
    status: "running",
    profileId: agent.id,
    createdAt: new Date("2026-08-29T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function assistantMessage(sessionId: string, text: string): SDKMessage {
  return {
    type: "assistant",
    uuid: `assistant-${sessionId}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `message-${sessionId}`,
      model: "claude",
      role: "assistant",
      content: [{ type: "text", text }],
    },
  } as unknown as SDKMessage;
}

function assistantToolUse(sessionId: string): SDKMessage {
  return {
    type: "assistant",
    uuid: `assistant-tool-${sessionId}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `message-tool-${sessionId}`,
      model: "claude",
      role: "assistant",
      content: [{
        type: "tool_use",
        id: `tool-${sessionId}`,
        name: "Inspect",
        input: { target: "foreground" },
      }],
    },
  } as unknown as SDKMessage;
}

function sdkToolUseInterruptedResult(sessionId: string): SDKMessage {
  return {
    ...(sdkInterruptedResult(sessionId, undefined) as unknown as Record<string, unknown>),
    stop_reason: "tool_use",
    errors: [
      "[ede_diagnostic] result_type=user last_content_type=n/a "
        + "stop_reason=tool_use (aborted_streaming)",
    ],
  } as unknown as SDKMessage;
}

function makeFullSlice(sessionId: string) {
  const sdk = makeHarness({ receipt: { still_queued: [] } });
  const client = new ClaudeSdkClient(
    {
      query: sdk.queryFn,
      detachedEventSink: sdk.detached,
      postResultDrainMs: 10,
    },
    silentLogger,
  );
  const registry = new ClaudeSessionClientRegistry(
    () => client,
    { idleTtlMs: 300_000, maxEntries: 4 },
  );
  const engine = new ClaudeEngineAdapter(
    {
      workspaceDir: agent.workspace_dir,
      client,
      persistentSessionRegistry: registry,
      processEnv: {},
    },
    silentLogger,
  );
  const persistence = makeEventPersistenceTestDouble();
  const db = {
    updateSession: vi.fn().mockResolvedValue(undefined),
    setClaudeSessionId: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn().mockResolvedValue(undefined),
    emitSessionUpdated: vi.fn().mockResolvedValue(undefined),
  } as unknown as SessionBroadcaster;
  const delivery = {
    discardIfConsumed: vi.fn().mockResolvedValue(false),
    recordTurnStarted: vi.fn().mockResolvedValue(undefined),
    recordConsumed: vi.fn().mockResolvedValue(undefined),
  };
  const executor = new TaskExecutor(
    () => engine,
    db,
    persistence.persistence,
    broadcaster,
    silentLogger,
    undefined,
    undefined,
    undefined,
    undefined,
    delivery,
  );
  const transition = new RunningInterventionTransition({
    broadcaster,
    logger: silentLogger,
    persistence: persistence.persistence,
  });
  const task = makeTask(sessionId);
  return {
    broadcaster,
    client,
    delivery,
    engine,
    executor,
    persistence,
    registry,
    sdk,
    task,
    transition,
  };
}

function persistedEvents(
  slice: ReturnType<typeof makeFullSlice>,
): SSEEventPayload[] {
  return slice.persistence.enqueueEvent.mock.calls.map(
    (call) => call[1] as SSEEventPayload,
  );
}

describe("Lane E running intervention turn handoff", () => {
  it("keeps the successor coherent when terminal cleanup wins the callback order", async () => {
    const slice = makeFullSlice("lane-e-causal-order");
    const cleanupCompleted = deferred<void>();
    const successorWaiting = deferred<void>();
    const callbackOrder: string[] = [];
    const intervention: InterventionMessage = {
      text: "apply the accepted successor",
      user: "operator",
      deliveryId: "delivery-lane-e-causal",
      runnerInterventionId: "delivery-lane-e-causal",
      deliveryIntent: "human_live_steer",
    };
    const probe = makeCausalDispatcherProbe({
      task: slice.task,
      intervention,
      successorWaiting,
      callbackOrder,
      reconcileGate: cleanupCompleted.promise,
    });
    const runner = createTaskRunnerRuntime(
      new RunnerProcessEngineProxy(
        "claude",
        agent.workspace_dir,
        probe.dispatcher,
        { retainDetachedRuntime: false },
      ),
      probe.dispatcher,
      "runner",
    );
    const coordinator = makeTerminalCleanupCoordinator(
      slice.task,
      terminalRegistration(slice.task.agentSessionId),
    );

    slice.executor.startExecutionWithRunner(slice.task, agent, runner);
    const execution = slice.task.executionPromise;
    if (!execution) throw new Error("causal fixture did not start the execution");
    await successorWaiting.promise;

    await coordinator.scanOnce();
    await coordinator.waitForSettled();
    callbackOrder.push("callback_a_current_cleanup_complete");
    cleanupCompleted.resolve();
    await execution;
    await slice.registry.shutdown();

    expect(observeCausalOutcome(slice, probe, callbackOrder)).toEqual({
      callbackOrder: [
        "callback_a_current_cleanup_complete",
        "callback_b_successor_reconcile",
      ],
      pendingStateReadFailures: 0,
      pendingStateFailure: null,
      finalStatus: "completed",
      successorExecuteRecordsBeforeExplicitRetry: 1,
      successorTurnRecordsBeforeExplicitRetry: 1,
    });
  });

  it("keeps the successor coherent when reconciliation wins the callback order", async () => {
    const slice = makeFullSlice("lane-e-causal-control");
    const cleanupCompleted = deferred<void>();
    const successorWaiting = deferred<void>();
    const callbackOrder: string[] = [];
    const intervention: InterventionMessage = {
      text: "apply the accepted successor",
      user: "operator",
      deliveryId: "delivery-lane-e-control",
      runnerInterventionId: "delivery-lane-e-control",
      deliveryIntent: "human_live_steer",
    };
    const probe = makeCausalDispatcherProbe({
      task: slice.task,
      intervention,
      successorWaiting,
      callbackOrder,
      reconcileGate: Promise.resolve(),
    });
    const runner = createTaskRunnerRuntime(
      new RunnerProcessEngineProxy(
        "claude",
        agent.workspace_dir,
        probe.dispatcher,
        { retainDetachedRuntime: false },
      ),
      probe.dispatcher,
      "runner",
    );
    const coordinator = makeTerminalCleanupCoordinator(
      slice.task,
      terminalRegistration(slice.task.agentSessionId),
    );

    slice.executor.startExecutionWithRunner(slice.task, agent, runner);
    const execution = slice.task.executionPromise;
    if (!execution) throw new Error("control fixture did not start the execution");
    await successorWaiting.promise;
    await execution;

    await coordinator.scanOnce();
    await coordinator.waitForSettled();
    callbackOrder.push("callback_a_current_cleanup_complete");
    cleanupCompleted.resolve();
    await slice.registry.shutdown();

    expect(observeCausalOutcome(slice, probe, callbackOrder)).toEqual({
      callbackOrder: [
        "callback_b_successor_reconcile",
        "callback_a_current_cleanup_complete",
      ],
      pendingStateReadFailures: 0,
      pendingStateFailure: null,
      finalStatus: "completed",
      successorExecuteRecordsBeforeExplicitRetry: 1,
      successorTurnRecordsBeforeExplicitRetry: 1,
    });
  });

  it("interrupts one owner, consumes one successor, and never projects the EDE as session error", async () => {
    const slice = makeFullSlice("lane-e-intervention");
    const execution = slice.executor.startExecution(slice.task, agent);
    const foregroundInput = await slice.sdk.nextInput();
    slice.sdk.push(sdkInit("claude-lane-e"));
    slice.sdk.push(assistantToolUse("claude-lane-e"));

    const intervention: InterventionMessage = {
      text: "apply the intervention now",
      user: "operator",
      deliveryId: "delivery-lane-e",
      deliveryIntent: "human_live_steer",
    };
    await expect(slice.transition.deliver(slice.task, intervention)).resolves.toMatchObject({
      delivered: false,
      queued: true,
      consumeWhen: "next_turn",
    });
    expect(slice.sdk.interrupt).toHaveBeenCalledTimes(1);

    slice.sdk.push(sdkToolUseInterruptedResult("claude-lane-e"));
    const successorInput = await slice.sdk.nextInput();
    expect(successorInput.message.content).toContain(intervention.text);
    expect(slice.task.status).toBe("running");
    expect(persistedEvents(slice).filter((event) => event.type === "session_ended")).toEqual([]);

    // A delayed SDK-owned background completion has no foreground ownership.
    slice.sdk.push(sdkTaskNotificationResult("claude-lane-e"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(slice.task.status).toBe("running");
    expect(persistedEvents(slice).filter((event) => event.type === "session_ended")).toEqual([]);

    slice.sdk.push(assistantMessage("claude-lane-e", "successor answer"));
    slice.sdk.push(sdkResult("claude-lane-e", successorInput.uuid, "successor terminal"));
    await execution;

    const events = persistedEvents(slice);
    expect(foregroundInput.uuid).not.toBe(successorInput.uuid);
    expect(events.filter((event) => event.type === "intervention_sent")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(slice.delivery.recordTurnStarted).toHaveBeenCalledTimes(1);
    expect(slice.delivery.recordConsumed).toHaveBeenCalledTimes(1);
    expect(slice.task.status).toBe("completed");
    expect(slice.task.error).toBeUndefined();
    expect(slice.task.pendingTerminationHint).toBeUndefined();
    expect(slice.persistence.acquireExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledTimes(1);
    expect(slice.persistence.releaseExecutionOwnershipAndWaitForApplication)
      .toHaveBeenCalledTimes(1);

    await slice.registry.shutdown();
  });

  it("keeps ordinary completion unchanged when no intervention arrives", async () => {
    const slice = makeFullSlice("lane-e-control");
    const execution = slice.executor.startExecution(slice.task, agent);
    const input = await slice.sdk.nextInput();
    slice.sdk.push(sdkInit("claude-lane-e-control"));
    slice.sdk.push(assistantMessage("claude-lane-e-control", "ordinary answer"));
    slice.sdk.push(sdkResult("claude-lane-e-control", input.uuid, "ordinary terminal"));
    await execution;

    const events = persistedEvents(slice);
    expect(slice.sdk.interrupt).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === "assistant_message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "complete")).toHaveLength(1);
    expect(events.filter((event) => event.type === "session_ended")).toHaveLength(1);
    expect(events.filter((event) => event.type === "error")).toEqual([]);
    expect(slice.delivery.recordTurnStarted).not.toHaveBeenCalled();
    expect(slice.delivery.recordConsumed).not.toHaveBeenCalled();
    expect(slice.task.status).toBe("completed");

    await slice.registry.shutdown();
  });
});

function observeCausalOutcome(
  slice: ReturnType<typeof makeFullSlice>,
  probe: ReturnType<typeof makeCausalDispatcherProbe>,
  callbackOrder: string[],
) {
  return {
    callbackOrder,
    pendingStateReadFailures: probe.pendingStateReadFailures(),
    pendingStateFailure: slice.task.error ?? null,
    finalStatus: slice.task.status,
    successorExecuteRecordsBeforeExplicitRetry: probe.executeCommands.slice(1).length,
    successorTurnRecordsBeforeExplicitRetry:
      slice.delivery.recordTurnStarted.mock.calls.length,
  };
}

function makeCausalDispatcherProbe(input: {
  task: Task;
  intervention: InterventionMessage;
  successorWaiting: ReturnType<typeof deferred<void>>;
  callbackOrder: string[];
  reconcileGate: Promise<void>;
}) {
  const executeCommands: Array<Extract<RunnerCommandFrame, { kind: "execute" }>> = [];
  let pendingStateReadFailures = 0;
  const outbox = {
    close: vi.fn(),
    inspectPendingInterventions: vi.fn(async () => ({
      interventions: [],
      childInterventionIds: [],
      shadowedFallbackIds: [],
    })),
    readInterventionFallback: vi.fn(() => null),
    readPendingIpcFrames: vi.fn(async () => []),
  };
  const dispatcher = Object.create(RunnerProcessDispatcher.prototype) as
    RunnerProcessDispatcher;
  Object.assign(dispatcher, {
    activeExecuteCommandId: undefined,
    activeStream: undefined,
    closed: false,
    connection: undefined,
    eventStreamReleased: false,
    inFlightFrameHandlers: new Set(),
    instanceId: "lane-e-causal",
    options: { logger: silentLogger },
    outbox,
    pump: {},
    pumpInitialization: undefined,
    recentHostResponses: new Map(),
    requestLifetimes: new Map(),
    spawnedProcess: { registrationId: "registration-lane-e-causal" },
    stoppedRunnerWriter: undefined,
    stoppedRunnerWriterLock: undefined,
    unregisterPump: undefined,
  });

  let readyReadCount = 0;
  Object.defineProperty(dispatcher, "ready", {
    configurable: true,
    get: () => {
      readyReadCount += 1;
      if (readyReadCount === 1) return Promise.resolve();
      if (readyReadCount === 2) {
        input.successorWaiting.resolve();
        return input.reconcileGate.then(() => {
          input.callbackOrder.push("callback_b_successor_reconcile");
        });
      }
      return input.reconcileGate;
    },
  });

  const reconcilePendingInterventions = (
    RunnerProcessDispatcher.prototype as unknown as {
      reconcilePendingInterventions(): Promise<{
        interventions: unknown[];
        childInterventionIds: string[];
        shadowedFallbackIds: string[];
      }>;
    }
  ).reconcilePendingInterventions;
  Object.assign(dispatcher, {
    reconcilePendingInterventions: vi.fn(async () => {
      try {
        return await reconcilePendingInterventions.call(dispatcher);
      } catch (error) {
        pendingStateReadFailures += 1;
        throw error;
      }
    }),
  });

  const dispatch = vi.fn(async (frame: RunnerCommandFrame) => {
    if (frame.kind !== "execute") {
      return runnerCommandResultFrame(frame.commandId, { status: "ok" });
    }
    executeCommands.push(frame);
    const stream = (dispatcher as unknown as {
      activeStream?: {
        fail(error: Error): void;
        finish(): void;
        push(frame: ReturnType<typeof engineEventFrame>): boolean;
      };
    }).activeStream;
    if (!stream) throw new Error("causal fixture has no active stream");
    if (executeCommands.length === 1) {
      input.task.interventionQueue.push(input.intervention);
      stream.fail(new Error("current tool-use owner interrupted"));
    } else {
      stream.push(engineEventFrame({
        type: "complete",
        result: "successor terminal",
        timestamp: 1,
      }));
      stream.finish();
    }
    return runnerCommandResultFrame(frame.commandId, { status: "ok" });
  });
  Object.assign(dispatcher, { dispatch });
  return {
    dispatcher,
    executeCommands,
    pendingStateReadFailures: () => pendingStateReadFailures,
  };
}

function makeTerminalCleanupCoordinator(
  task: Task,
  registration: RunnerRegistration,
): RunnerRecoveryCoordinator {
  const options = {
    nodeId: "node-lane-e",
    stateDirectory: "/runner",
    leaseTimeoutMs: 120_000,
    scanIntervalMs: 15_000,
    taskManager: {
      hydrateRunnerRecoveryTask: vi.fn(async () => task),
      markRunnerFailureAndResume: vi.fn(),
      listOwnerNullRunningInventory: vi.fn(async () => []),
      projectClosedRunner: vi.fn(async () => true),
      reconcileExecutionOwnershipObservations: vi.fn(async () => false),
    },
    taskExecutor: {
      recoverRegisteredRunner: vi.fn(async () => undefined),
      restartRegisteredRunner: vi.fn(async () => undefined),
    },
    closedTailDrainer: { drain: vi.fn(async () => undefined) },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    spawner: {
      terminate: vi.fn(async () => undefined),
      invalidateRegistration: vi.fn(async () => undefined),
      retireTerminalRegistration: vi.fn(async () => undefined),
    },
    scan: async () => ({ registrations: [registration], errors: [] }),
    hydrate: async (candidate: RunnerRegistration) => candidate,
    now: () => Date.parse("2026-08-29T00:00:10.000Z"),
    markReaped: vi.fn(async () => undefined),
  } as unknown as RunnerRecoveryCoordinatorOptions;
  return new RunnerRecoveryCoordinator(options);
}

function terminalRegistration(sessionId: string): RunnerRegistration {
  return {
    config: {
      schemaVersion: 1,
      sessionId,
      backend: "claude",
      agent,
      paths: {
        sessionDirectory: `/runner/${sessionId}`,
        databasePath: `/runner/${sessionId}/runner.sqlite`,
        socketPath: `/runner/${sessionId}/runner.sock`,
        pidPath: `/runner/${sessionId}/runner.pid`,
        lockPath: `/runner/${sessionId}/runner.lock`,
        configPath: `/runner/${sessionId}/runner-config.json`,
      },
      codeSha: "sha-lane-e",
      snapshotPath: "/release/sha-lane-e/soul-server-ts",
      codexAdapterMode: "sdk",
      claudeRuntimeV2Enabled: true,
      claudeRuntimeIdleTtlMs: 300_000,
      claudeRuntimeMaxEntries: 16,
      claudeRuntimeTurnTimeoutMs: 600_000,
      internalMcpUrl: "http://127.0.0.1:4206/mcp/internal",
      codexHome: "/home/test/.codex",
      rolloutRoot: "/home/test/.codex/sessions",
    },
    pid: 260829,
    registrationId: "registration-lane-e-causal",
    pidStartIdentity: "start-260829",
    pidAlive: false,
    registeredAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
    bootstrap: {
      stream_id: "stream-lane-e",
      source_seq: 1,
      session_id: sessionId,
      event_type: "runner_bootstrap",
      payload: {
        schema_version: 1,
        backend_session_id: "claude-lane-e",
        cwd: agent.workspace_dir,
        codex_home: "/home/test/.codex",
        rollout_root: "/home/test/.codex/sessions",
        code_sha: "sha-lane-e",
        snapshot_path: "/release/sha-lane-e/soul-server-ts",
      },
      searchable_text: null,
      created_at: "2026-08-29T00:00:00.000Z",
      semantic_dedupe_key: null,
      session_effect: null,
      payload_hash: "0".repeat(64),
    },
    lifecycle: {
      session_id: sessionId,
      runner_pid: 260829,
      execution_command_id: "execute-current",
      execution_state: "completed",
      progress_seq: 3,
      progress_at: "2026-08-29T00:00:09.000Z",
      liveness_at: "2026-08-29T00:00:09.000Z",
      in_flight_tools: [],
      terminal_error: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
