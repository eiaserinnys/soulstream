import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile, AgentRegistry } from "../../src/agent_registry.js";
import { SessionDataHostClient } from "../../src/control_plane/session_data_host_client.js";
import type { SessionDB, SessionRow } from "../../src/db/session_db.js";
import type { EngineExecuteParams, EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import { engineEventFrame } from "../../src/runner/frame_protocol.js";
import type { TaskRunnerRuntime } from "../../src/runner/task_runner_runtime.js";
import { TaskExecutor, type RunnerProcessRuntimeFactory } from "../../src/task/task_executor.js";
import { TaskManager } from "../../src/task/task_manager.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";

import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";
import { MemoryDeliveryRepository } from "./terminal_fence_intervention_dedupe_harness.js";

const logger = pino({ level: "silent" });

const SESSION_ID = "892c0435-7e36-453a-98e3-6adf54c26535";
const OLD_NATIVE_ID = "8583c0ee-cf1c-483c-a06b-9840d790d484";

const AGENT: AgentProfile = {
  id: "seosoyoung-lite",
  name: "Seosoyoung Lite",
  backend: "claude",
  workspace_dir: "/tmp/persistent-generation-flow",
};

/**
 * The completed test session as production stored it after a P7-only server
 * accepted the rollover request (no execution registration, runner retired).
 */
function productionSessionRow(): SessionRow {
  return {
    session_id: SESSION_ID,
    folder_id: "claude",
    display_name: null,
    session_type: "claude",
    status: "completed",
    prompt: "persistent session probe",
    client_id: null,
    claude_session_id: OLD_NATIVE_ID,
    last_message: null,
    metadata: [
      { type: "caller_info", value: { source: "browser" } },
      { type: "persistent_session", value: { enabled: true, updated_at: "2026-10-05T12:19:50.569Z" } },
      {
        type: "persistent_generation",
        value: {
          number: 1,
          pending: {
            number: 2,
            reason: "manual",
            requested_at: "2026-10-05T13:51:56.916Z",
            applying_from: null,
            target_model_preset: "claude-opus",
            target_reasoning_effort: "xhigh",
          },
          first_call: null,
          started_at: null,
          backend_session_id: null,
        },
      },
      { type: "session_cost", value: { usd: 0.546736, partial: false } },
    ],
    was_running_at_shutdown: false,
    last_event_id: 65,
    last_read_event_id: 0,
    node_id: "eiaserinnys",
    created_at: new Date("2026-10-05T12:18:01.309Z"),
    updated_at: new Date("2026-10-05T12:21:09.517Z"),
    agent_id: AGENT.id,
    caller_session_id: null,
    away_summary: null,
    termination_reason: "completed_ok",
    termination_detail: null,
    notify_completion: true,
    review_required: false,
    review_state: "acknowledged",
    predecessor_session_id: null,
    model_preset: "claude-opus",
    model: "opus",
    termination_event_id: 64,
    last_assistant_text: "done",
    execution_registration_id: null,
    execution_command_id: null,
    reasoning_effort: "xhigh",
    worktree_id: null,
    card_id: null,
  } as unknown as SessionRow;
}

function makeFixture(
  row = productionSessionRow(),
  capabilityProfile:
    | "legacy_transition_only"
    | "execution_registration" = "execution_registration",
) {
  const repository = new MemoryDeliveryRepository();
  const persistenceDouble = makeEventPersistenceTestDouble(
    undefined,
    undefined,
    { capabilityProfile },
  );
  // Production reads the row through the orch host transport, which JSON-decodes
  // it and revives `*_at` strings. Reading it any other way skips that layer.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(row), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  const sessionData = new SessionDataHostClient({
    orch: { baseUrl: "http://orch.invalid", headers: {} },
    logger,
  } as never);
  const db = {
    getFolderById: vi.fn(async () => null),
    getBoardItems: vi.fn(async () => []),
    getSession: vi.fn((sessionId: string) => sessionData.getSession(sessionId)),
    sessionDeliveries: vi.fn(() => repository),
    claudeBackgroundTasks: vi.fn(() => ({ resolveGeneration: vi.fn() })),
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitSessionCreated: vi.fn(async () => undefined),
    emitSessionDeleted: vi.fn(async () => undefined),
    emitCatalogUpdated: vi.fn(async () => undefined),
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const sessionMutations = {
    registerSession: vi.fn(async () => undefined),
    transitionSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    acknowledgeReview: vi.fn(async () => "not_required" as const),
    setModelSelection: vi.fn(async () => undefined),
  };
  const modelCatalog = {
    resolve: vi.fn((id: string) => ({
      id,
      label: id,
      backend: id === "gemini-4-argon"
        ? "antigravity" as const
        : id.startsWith("codex") ? "codex" as const : "claude" as const,
      model: id === "gemini-4-argon"
        ? "gemini-4-argon"
        : id.startsWith("codex") ? "gpt-6.1" : "opus",
      env: undefined,
      supported_efforts: ["low" as const, "medium" as const, "high" as const, "xhigh" as const],
      default_effort: "xhigh" as const,
    })),
  };
  const agentRegistry = { get: vi.fn(() => AGENT) } as unknown as AgentRegistry;
  const contextBuilder = {
    buildGenerationContext: vi.fn(async () => ({
      effectiveSystemPrompt: "generation system instructions",
      combinedContextItems: [{ key: "persistent_checkpoint", label: "Checkpoint", content: "checkpoint data" }],
      assembledPrompt: "unused",
      checkpointStats: {
        estimatedTokens: 10,
        chars: 20,
        sections: { state: 1, story: 2, summaries: 3, recent: 4 },
        summarizedThroughTurn: 1,
        recentFromEventId: 1,
        recentToEventId: 2,
      },
    })),
    buildFollowupContext: vi.fn(async () => undefined),
    buildAssignedCardContext: vi.fn(async () => ({ key: "assigned_cards", label: "cards", content: "none" })),
    build: vi.fn(async () => undefined),
  };

  const executed: EngineExecuteParams[] = [];
  const runnerEvents: SSEEventPayload[] = [
    { type: "session", session_id: "native-new" } as SSEEventPayload,
    { type: "assistant_message", content: "ok", timestamp: 1 } as SSEEventPayload,
    { type: "complete", usage: {}, timestamp: 2 } as SSEEventPayload,
  ];
  const runnerFailure: { error?: Error } = {};
  const dispatcher = {
    dispatch: vi.fn(),
    executeFrames: vi.fn((params: EngineExecuteParams) => {
      executed.push(params);
      return (async function* () {
        for (const event of runnerEvents) yield engineEventFrame(event);
        if (runnerFailure.error) throw runnerFailure.error;
      })();
    }),
    recoverFrames: vi.fn(),
    registrationId: vi.fn(() => "registration-1"),
    prepareExecutionIdentity: vi.fn(async () => ({
      registrationId: "registration-1",
      pid: 321,
      startIdentity: "start-1",
      executionCommandId: "execute-1",
    })),
    prepareSession: vi.fn(async () => {}),
    interrupt: vi.fn(async () => true),
    close: vi.fn(async () => {}),
    detachHost: vi.fn(async () => {}),
    releaseEventStreamRegistration: vi.fn(async () => {}),
    sendControlFrame: vi.fn(async () => true),
    requestContext: vi.fn(),
    waitForSessionAck: vi.fn(async () => 12),
    invoke: vi.fn(),
  };
  const engine: EnginePort = {
    backendId: "claude",
    workspaceDir: AGENT.workspace_dir,
    async *execute(): AsyncIterable<SSEEventPayload> {},
    async interrupt() { return true; },
    async close() {},
  };
  const runner: TaskRunnerRuntime = {
    engine,
    dispatcher: dispatcher as never,
    eventPersistence: "runner",
  };
  const runnerProcessFactorySpy = vi.fn(
    (_task: Task, _agent: AgentProfile, _backend: string) => runner,
  );
  const runnerProcessFactory = runnerProcessFactorySpy as unknown as RunnerProcessRuntimeFactory;

  const taskManager = new TaskManager(
    "eiaserinnys",
    db,
    broadcaster,
    logger,
    persistenceDouble.persistence,
    contextBuilder as never,
    agentRegistry,
    undefined,
    undefined,
    true,
    undefined,
    modelCatalog,
    sessionMutations as never,
  );
  const executor = new TaskExecutor(
    () => engine,
    db,
    persistenceDouble.persistence,
    broadcaster,
    logger,
    contextBuilder as never,
    undefined,
    undefined,
    undefined,
    taskManager.getDeliveryConsumptionRecorder(),
    modelCatalog,
    runnerProcessFactory,
    undefined,
    undefined,
    undefined,
    sessionMutations,
  );
  const onResume = (task: Task, activation?: Task["executionActivation"]) =>
    activation
      ? executor.startNewExecution(task, AGENT, activation)
      : executor.startNewExecution(task, AGENT);
  return {
    taskManager,
    executor,
    onResume,
    persistenceDouble,
    sessionMutations,
    contextBuilder,
    executed,
    dispatcher,
    runnerEvents,
    runnerFailure,
    runner,
    engine,
    runnerProcessFactorySpy,
  };
}

describe("persistent generation rollover through the production resume path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a new backend session when a message resumes a completed session read through the host transport", async () => {
    const fixture = makeFixture();
    const deliveryId = "11111111-1111-4111-8111-111111111111";

    await fixture.taskManager.addIntervention(
      {
        agentSessionId: SESSION_ID,
        text: "continue",
        user: "seosoyoung",
        source: "user_message",
        deliveryId,
        deliveryIntent: "human_live_steer",
        completionId: `message:${deliveryId}`,
        relationKey: `user_message:${SESSION_ID}:${deliveryId}`,
        callerInfo: { source: "agent", agent_id: "seosoyoung" },
      },
      fixture.onResume,
    );
    const task = fixture.taskManager.getTask(SESSION_ID)!;
    await task.executionPromise;

    const stored = fixture.persistenceDouble.enqueueEvent.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(stored.some((event) => event.type === "generation_started")).toBe(true);
    expect(fixture.sessionMutations.setModelSelection).toHaveBeenCalledTimes(1);
    expect(fixture.executed).toHaveLength(1);
    expect(fixture.executed[0]).toMatchObject({ backendSessionRolloverFrom: OLD_NATIVE_ID });
    expect(fixture.executed[0]).not.toHaveProperty("resumeSessionId");
  });
});

async function resume(
  fixture: ReturnType<typeof makeFixture>,
  text = "continue",
  onResume = fixture.onResume,
  waitForExecution = true,
) {
  const deliveryId = crypto.randomUUID();
  await fixture.taskManager.addIntervention({
    agentSessionId: SESSION_ID, text, user: "seosoyoung", source: "user_message",
    deliveryId, deliveryIntent: "human_live_steer", completionId: `message:${deliveryId}`,
    relationKey: `user_message:${SESSION_ID}:${deliveryId}`,
    callerInfo: { source: "agent", agent_id: "seosoyoung" },
  }, onResume);
  const task = fixture.taskManager.getTask(SESSION_ID)!;
  if (waitForExecution) await task.executionPromise;
  return task;
}

function retainRunnerForPreset(
  task: Task,
  runner: TaskRunnerRuntime,
  options: {
    nativeSessionId: string;
    applyingFrom: string;
    modelPreset: string;
    backend: "antigravity" | "claude";
    reasoningEffort: "high" | "xhigh";
  },
) {
  const generation = task.persistentGeneration!;
  task.codexThreadId = options.nativeSessionId;
  task.modelPreset = options.modelPreset;
  task.model = options.modelPreset === "gemini-4-argon" ? "gemini-4-argon" : "opus";
  task.modelPresetBackend = options.backend;
  task.modelPresetEnv = undefined;
  task.reasoningEffort = options.reasoningEffort;
  task.persistentGeneration = {
    ...generation,
    pending: {
      ...generation.pending!,
      applyingFrom: options.applyingFrom,
      previousModelPreset: "claude-opus",
      previousBackend: "claude",
      targetModelPreset: options.modelPreset,
      targetReasoningEffort: options.reasoningEffort,
    },
  };
  task.runner = runner;
  task.runnerRetainedForDetachedWork = true;
}

function startWithRetainedRunner(
  fixture: ReturnType<typeof makeFixture>,
  options: Parameters<typeof retainRunnerForPreset>[2],
) {
  return (task: Task, activation?: Task["executionActivation"]) => {
    retainRunnerForPreset(task, fixture.runner, options);
    return activation
      ? fixture.executor.startNewExecution(task, AGENT, activation)
      : fixture.executor.startNewExecution(task, AGENT);
  };
}

function makeReplacementRunner(
  fixture: ReturnType<typeof makeFixture>,
  backend: string,
  order: string[],
): TaskRunnerRuntime {
  const dispatcher = {
    ...fixture.dispatcher,
    close: vi.fn(async () => { order.push("new-close"); }),
    executeFrames: vi.fn((params: EngineExecuteParams) => {
      order.push("execute");
      fixture.executed.push(params);
      return (async function* () {
        for (const event of fixture.runnerEvents) yield engineEventFrame(event);
      })();
    }),
  };
  return {
    ...fixture.runner,
    engine: { ...fixture.engine, backendId: backend as EnginePort["backendId"] },
    dispatcher: dispatcher as never,
  };
}

function useReplacementRunnerFactory(
  fixture: ReturnType<typeof makeFixture>,
  order: string[],
) {
  fixture.runnerProcessFactorySpy.mockImplementation((_task, _agent, backend) => {
    order.push(`factory:${backend}`);
    return makeReplacementRunner(fixture, backend, order);
  });
}

describe("retained runner backend selection after persistent rollover", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { path: "execution registration", profile: "execution_registration" as const },
    { path: "legacy execution", profile: "legacy_transition_only" as const },
  ])("closes a retained Claude runner before starting the Argon runner on $path", async ({ profile }) => {
    const fixture = makeFixture(productionSessionRow(), profile);
    const order: string[] = [];
    let signalCloseStarted!: () => void;
    let releaseClose!: () => void;
    const closeStarted = new Promise<void>((resolve) => { signalCloseStarted = resolve; });
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    fixture.dispatcher.close.mockImplementation(async () => {
      order.push("old-close:start");
      signalCloseStarted();
      await closeGate;
      order.push("old-close:done");
    });
    useReplacementRunnerFactory(fixture, order);

    const start = startWithRetainedRunner(fixture, {
      nativeSessionId: OLD_NATIVE_ID,
      applyingFrom: OLD_NATIVE_ID,
      modelPreset: "gemini-4-argon",
      backend: "antigravity",
      reasoningEffort: "high",
    });
    const resuming = resume(fixture, "continue", start, false);
    await closeStarted;
    const task = fixture.taskManager.getTask(SESSION_ID)!;

    const whileClosing = {
      order: [...order],
      factoryCalls: fixture.runnerProcessFactorySpy.mock.calls.length,
      oldExecuteCalls: fixture.dispatcher.executeFrames.mock.calls.length,
      executions: fixture.executed.length,
      slotHeld: task.executionPromise !== undefined,
      activationHeld: task.executionActivation !== undefined,
    };

    releaseClose();
    await task.executionPromise;

    expect(task.status, task.error).toBe("completed");
    expect(whileClosing).toEqual({
      order: ["old-close:start"],
      factoryCalls: 0,
      oldExecuteCalls: 0,
      executions: 0,
      slotHeld: true,
      activationHeld: true,
    });
    expect(order.slice(0, 4)).toEqual([
      "old-close:start",
      "old-close:done",
      "factory:antigravity",
      "execute",
    ]);
    expect(fixture.runnerProcessFactorySpy).toHaveBeenCalledWith(
      task,
      AGENT,
      "antigravity",
      expect.anything(),
    );
    expect(fixture.dispatcher.executeFrames).not.toHaveBeenCalled();
    expect(fixture.executed).toHaveLength(1);
    await resuming;
  });

  it("does not reuse Claude after native-ID reconciliation clears the pending generation", async () => {
    const fixture = makeFixture();
    const order: string[] = [];
    useReplacementRunnerFactory(fixture, order);
    const start = startWithRetainedRunner(fixture, {
      nativeSessionId: "native-already-rotated",
      applyingFrom: OLD_NATIVE_ID,
      modelPreset: "gemini-4-argon",
      backend: "antigravity",
      reasoningEffort: "high",
    });

    const task = await resume(fixture, "continue", start);

    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(fixture.runnerProcessFactorySpy).toHaveBeenCalledWith(
      task,
      AGENT,
      "antigravity",
      expect.anything(),
    );
    expect(fixture.dispatcher.close).toHaveBeenCalledOnce();
    expect(fixture.dispatcher.executeFrames).not.toHaveBeenCalled();
    expect(order).toEqual(["factory:antigravity", "execute", "new-close"]);
  });

  it("reuses a retained runner when its backend already matches", async () => {
    const fixture = makeFixture();
    const order: string[] = [];
    fixture.dispatcher.executeFrames.mockImplementation((params: EngineExecuteParams) => {
      order.push("execute");
      fixture.executed.push(params);
      return (async function* () {
        for (const event of fixture.runnerEvents) yield engineEventFrame(event);
      })();
    });
    fixture.dispatcher.close.mockImplementation(async () => { order.push("close"); });
    const start = startWithRetainedRunner(fixture, {
      nativeSessionId: OLD_NATIVE_ID,
      applyingFrom: OLD_NATIVE_ID,
      modelPreset: "claude-opus",
      backend: "claude",
      reasoningEffort: "xhigh",
    });

    await resume(fixture, "continue", start);

    expect(fixture.runnerProcessFactorySpy).not.toHaveBeenCalled();
    expect(fixture.dispatcher.executeFrames).toHaveBeenCalledOnce();
    expect(fixture.executed).toHaveLength(1);
    expect(order).toEqual(["execute", "close"]);
  });

  it.each([
    { path: "execution registration", profile: "execution_registration" as const },
    { path: "legacy execution", profile: "legacy_transition_only" as const },
  ])(
    "does not start the target runner when close fails on $path",
    async ({ profile }) => {
      const fixture = makeFixture(productionSessionRow(), profile);
      fixture.dispatcher.close.mockRejectedValue(new Error("retained runner close failed"));
      const start = startWithRetainedRunner(fixture, {
        nativeSessionId: OLD_NATIVE_ID,
        applyingFrom: OLD_NATIVE_ID,
        modelPreset: "gemini-4-argon",
        backend: "antigravity",
        reasoningEffort: "high",
      });

      await expect(resume(fixture, "continue", start, false))
        .rejects.toThrow("retained runner close failed");
      expect(fixture.runnerProcessFactorySpy).not.toHaveBeenCalled();
      expect(fixture.dispatcher.executeFrames).not.toHaveBeenCalled();
    },
  );
});

function rejectAtLimit(fixture: ReturnType<typeof makeFixture>, nativeChanged: boolean) {
  fixture.runnerEvents.splice(0, fixture.runnerEvents.length,
    ...(nativeChanged ? [{ type: "session", session_id: "native-new" } as SSEEventPayload] : []),
    { type: "credential_alert", status: "rejected", rate_limit_type: "seven_day", timestamp: 1 } as SSEEventPayload,
    { type: "error", error_code: "claude_rate_limit_stop_failure", fatal: true,
      message: "Claude foreground turn stopped after a rate-limit rejection.", timestamp: 2 } as SSEEventPayload,
  );
  fixture.runnerFailure.error = new Error("Claude foreground turn stopped after a rate-limit rejection.");
}

describe("persistent generation recovery after a rejected first turn", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("completes the rotated generation after a limit exception and resumes its new native ID", async () => {
    const fixture = makeFixture();
    rejectAtLimit(fixture, true);
    const task = await resume(fixture);
    expect(task.terminationReason).toBe("limit_hit");
    expect(task.persistentGeneration).toMatchObject({ number: 2, backendSessionId: "native-new" });
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(task.persistentGeneration?.firstCall).toBeUndefined();
    expect(fixture.persistenceDouble.enqueueMetadataEffect).toHaveBeenCalledWith(
      SESSION_ID, expect.objectContaining({ value: expect.objectContaining({ number: 2, pending: null }) }),
      expect.objectContaining({ replaceExistingType: "persistent_generation", waitForAck: true }),
    );
    fixture.runnerFailure.error = undefined;
    fixture.runnerEvents.splice(0, fixture.runnerEvents.length,
      { type: "complete", usage: {}, timestamp: 3 } as SSEEventPayload);
    await resume(fixture, "after quota reset");
    expect(fixture.executed[1]).toMatchObject({ resumeSessionId: "native-new" });
    expect(fixture.executed[1]).not.toHaveProperty("backendSessionRolloverFrom");
  });

  it("retries the pending generation when the rejected turn has not changed native ID", async () => {
    const fixture = makeFixture();
    rejectAtLimit(fixture, false);
    const task = await resume(fixture);
    expect(task.persistentGeneration?.number).toBe(1);
    expect(task.persistentGeneration?.pending?.applyingFrom).toBe(OLD_NATIVE_ID);
    fixture.runnerFailure.error = undefined;
    fixture.runnerEvents.splice(0, fixture.runnerEvents.length,
      { type: "session", session_id: "native-new" } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 3 } as SSEEventPayload);
    await resume(fixture);
    expect(fixture.executed[1]).toMatchObject({ backendSessionRolloverFrom: OLD_NATIVE_ID });
    expect(task.persistentGeneration?.number).toBe(2);
  });

  it("reconciles an in-memory applying generation and preserves a later model request on the same input", async () => {
    const fixture = makeFixture();
    rejectAtLimit(fixture, false);
    const task = await resume(fixture);
    // Stored shape of bad1b464: the backend rotated before the failed turn,
    // but generation completion was missed and a later setting request merged.
    task.codexThreadId = "native-new";
    task.modelPreset = "claude-sonnet";
    task.reasoningEffort = "medium";
    task.persistentGeneration!.pending = {
      ...task.persistentGeneration!.pending!, reason: "model change",
      targetModelPreset: "codex-6.1-sol", targetReasoningEffort: "high",
      resetContext: true, keepInstructions: false,
    };
    fixture.runnerFailure.error = undefined;
    fixture.runnerEvents.splice(0, fixture.runnerEvents.length,
      { type: "session", session_id: "native-third" } as SSEEventPayload,
      { type: "complete", usage: {}, timestamp: 3 } as SSEEventPayload);
    await resume(fixture);
    const reconciled = fixture.persistenceDouble.enqueueMetadataEffect.mock.calls
      .find((call) => (call[1].value as { number: number; pending?: { number: number } }).number === 2
        && (call[1].value as { pending?: { number: number } }).pending?.number === 3);
    expect(reconciled?.[1]).toMatchObject({ value: {
      number: 2, backend_session_id: "native-new", pending: {
        number: 3, reason: "model change", target_model_preset: "codex-6.1-sol",
        target_reasoning_effort: "high", applying_from: null,
        reset_context: true, keep_instructions: false,
      },
    } });
    const pending = (reconciled?.[1].value as { pending: Record<string, unknown> }).pending;
    expect(pending).not.toHaveProperty("previous_model_preset");
    expect(pending).not.toHaveProperty("previous_backend");
    expect(reconciled?.[2]).toMatchObject({ replaceExistingType: "persistent_generation", waitForAck: true });
    expect(fixture.executed[1]).toMatchObject({ backendSessionRolloverFrom: "native-new", reasoningEffort: "high" });
    expect(fixture.sessionMutations.setModelSelection).toHaveBeenLastCalledWith(
      SESSION_ID, expect.objectContaining({ modelPreset: "codex-6.1-sol", reasoningEffort: "high" }), expect.any(String));
    expect(task.persistentGeneration?.number).toBe(3);
  });
});
