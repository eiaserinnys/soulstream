import pino from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import type { ProviderLimits, ProviderUsageCommandHandler } from "../../src/auth/provider_usage.js";
import {
  rememberProviderUsageObservation,
  resetProviderUsageObservationMemo,
} from "../../src/auth/provider_usage_observation.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";
import { buildInterventionSentEvent } from "../../src/task/task_intervention_events.js";
import { buildUserMessageEvent } from "../../src/task/task_user_message_events.js";
import {
  TaskExecutor,
} from "../../src/task/task_executor.js";
import type { Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const logger = pino({ level: "silent" });
const agent: AgentProfile = {
  id: "claude-default",
  name: "Claude Default",
  backend: "claude",
  workspace_dir: "/tmp/claude-default",
};

function makeTask(): Task {
  return {
    agentSessionId: "persistent-1",
    prompt: "hello",
    status: "running",
    profileId: agent.id,
    persistent: true,
    modelPreset: "claude-opus",
    model: "claude-model",
    modelPresetBackend: "claude",
    modelPresetEnv: {},
    reasoningEffort: "high",
    codexThreadId: "native-old",
    persistentGeneration: {
      number: 1,
      backendSessionId: "native-old",
      firstCall: {
        generation: 1,
        inputTokens: 33_000,
        cachedInputTokens: 0,
        modelPreset: "claude-opus",
        model: "claude-model",
        measuredAt: new Date().toISOString(),
      },
    },
    metadata: [{
      type: "persistent_settings",
      value: {
        default_model: { model_preset: "codex-6.1-sol", reasoning_effort: "high" },
        fallback_model: { model_preset: "claude-opus", reasoning_effort: "high" },
      },
    }],
    claudeContextUsage: { usedTokens: 1_000, maxTokens: 200_000 },
    createdAt: new Date(),
    lastEventId: 2,
    lastReadEventId: 0,
    interventionQueue: [],
  };
}

function makeModelCatalog(): Pick<ModelCatalog, "resolve"> {
  return {
    resolve: vi.fn((id: string) => ({
      id,
      label: id,
      backend: id.startsWith("claude") ? "claude" as const : "codex" as const,
      model: `${id}-model`,
      env: {},
      supported_efforts: ["high" as const],
    })),
  };
}

function makeUsage(): ProviderLimits {
  return {
    status: "auto",
    source: "test",
    observedAt: new Date().toISOString(),
    weeklyTokens: null,
    monthlyTokens: null,
    sessionTokens: null,
    weeklyUsedPercent: 20,
    weeklyResetAt: Date.now() / 1_000 + 7 * 24 * 60 * 60,
    shortUsedPercent: 10,
    shortWindowMinutes: 300,
    shortResetAt: Date.now() / 1_000 + 5 * 60 * 60,
    planType: null,
    quotas: [],
  };
}

function makeEngine(events: SSEEventPayload[]): EnginePort {
  return {
    backendId: "codex",
    workspaceDir: "/tmp/codex-default",
    async *execute(): AsyncIterable<SSEEventPayload> {
      for (const event of events) yield event;
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeContextBuilder() {
  return {
    buildGenerationContext: vi.fn(async () => ({
      effectiveSystemPrompt: "generation instructions",
      combinedContextItems: [{ key: "persistent_checkpoint", label: "Checkpoint", content: "state" }],
      assembledPrompt: "unused",
      checkpointStats: {
        estimatedTokens: 1,
        chars: 1,
        sections: { state: 1, story: 0, summaries: 0, recent: 0 },
        summarizedThroughTurn: 0,
        recentFromEventId: 1,
        recentToEventId: 2,
      },
    })),
  };
}

function makeRuntime(task: Task, events: Array<{
  id: number;
  session_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  searchable_text: string;
  created_at: Date;
}>) {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const modelCatalog = makeModelCatalog();
  const db = {
    readEvents: vi.fn(async () => events),
    getSession: vi.fn(async () => null),
    updateSession: vi.fn(async () => undefined),
    setClaudeSessionId: vi.fn(async () => undefined),
  } as unknown as SessionDB;
  const broadcaster = {
    emitEventEnvelope: vi.fn(async () => undefined),
    emitSessionUpdated: vi.fn(async () => undefined),
  } as unknown as SessionBroadcaster;
  const persistentSessions = new PersistentSessionControl({
    getTask: (sessionId) => sessionId === task.agentSessionId ? task : undefined,
    loadEvictedTask: async () => null,
    rememberTask: () => undefined,
    persistence: persistenceDouble.persistence,
    modelCatalog,
    resolveCurrentBackend: () => task.modelPresetBackend,
  });
  const providerUsage = {
    fetchUsage: vi.fn(async () => ({ success: false })),
  } as unknown as ProviderUsageCommandHandler;
  const scheduleService = {
    deleteCacheKeepaliveSchedules: vi.fn(async () => undefined),
    scheduleCacheKeepalive: vi.fn(async () => undefined),
  };
  return {
    persistenceDouble,
    db,
    broadcaster,
    modelCatalog,
    persistentSessions,
    providerUsage,
    scheduleService,
  };
}

function taskExecutor(
  task: Task,
  runtime: ReturnType<typeof makeRuntime>,
  engineFactory: (profile: AgentProfile, backend?: string) => EnginePort,
  contextBuilder?: ReturnType<typeof makeContextBuilder>,
  sessionMutations?: { setModelSelection: ReturnType<typeof vi.fn> },
) {
  return new TaskExecutor(
    engineFactory,
    runtime.db,
    runtime.persistenceDouble.persistence,
    runtime.broadcaster,
    logger,
    contextBuilder as never,
    undefined,
    undefined,
    undefined,
    undefined,
    runtime.modelCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    sessionMutations,
    {
      persistentSessions: runtime.persistentSessions,
      providerUsage: runtime.providerUsage,
      scheduleService: runtime.scheduleService,
    },
  );
}

describe("TaskExecutor persistent decision wiring", () => {
  beforeEach(() => resetProviderUsageObservationMemo());

  it("persists the keepalive purpose marker on both intervention and resumed input events", () => {
    const intervention = {
      text: "cache keepalive",
      user: "Soulstream Scheduler",
      callerInfo: { source: "system", display_name: "Soulstream Scheduler" },
      purpose: "cache_keepalive" as const,
    };

    expect(buildInterventionSentEvent(intervention)).toMatchObject({
      type: "intervention_sent",
      purpose: "cache_keepalive",
    });
    expect(buildUserMessageEvent({
      text: intervention.text,
      callerInfo: intervention.callerInfo,
      purpose: intervention.purpose,
    })).toMatchObject({
      type: "user_message",
      purpose: "cache_keepalive",
    });
  });

  it("requests a new generation at arrival and consumes it in the same execution start", async () => {
    const task = makeTask();
    task.claudeContextUsage = { usedTokens: 130_001, maxTokens: 200_000 };
    task.interventionQueue.push({ text: "continue", user: "Alice" });
    const now = Date.now();
    const events = [
      {
        id: 1,
        session_id: task.agentSessionId,
        event_type: "complete",
        payload: {},
        searchable_text: "",
        created_at: new Date(now - 60_000),
      },
      {
        id: 2,
        session_id: task.agentSessionId,
        event_type: "context_usage",
        payload: { used_tokens: 130_001, estimated: false },
        searchable_text: "",
        created_at: new Date(now - 60_000),
      },
    ];
    const runtime = makeRuntime(task, events);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const persistentSessions = vi.spyOn(runtime.persistentSessions, "requestGenerationRollover");
    const contextBuilder = makeContextBuilder();
    const sessionMutations = { setModelSelection: vi.fn(async () => undefined) };
    let backendAtEngineStart: string | undefined;
    const engine = makeEngine([
      { type: "session", session_id: "native-new" } as SSEEventPayload,
      {
        type: "complete",
        usage: {},
        timestamp: Date.now() / 1_000,
        first_call: { input_tokens: 40_000, cached_input_tokens: 0 },
      } as unknown as SSEEventPayload,
    ]);
    const executor = taskExecutor(
      task,
      runtime,
      (_profile, backend) => {
        backendAtEngineStart = backend;
        return engine;
      },
      contextBuilder,
      sessionMutations,
    );

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(persistentSessions).toHaveBeenCalledWith(task.agentSessionId, {
      modelPreset: "codex-6.1-sol",
      reasoningEffort: "high",
      reason: "auto:arrival.warm.over_budget",
    });
    expect(backendAtEngineStart).toBe("codex");
    expect(contextBuilder.buildGenerationContext).toHaveBeenCalledOnce();
    expect(sessionMutations.setModelSelection).toHaveBeenCalledOnce();
    const decisions = runtime.persistenceDouble.enqueueEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((event) => event.kind === "persistent_decision");
    expect(decisions[0]).toMatchObject({
      type: "debug",
      trigger: "arrival",
      action: "new_generation",
      target_preset: "codex-6.1-sol",
      rule: "arrival.warm.over_budget",
      inputs_snapshot: expect.objectContaining({
        trigger: "arrival",
        context_tokens: 130_001,
        current_preset: "claude-opus",
      }),
    });
    expect(runtime.scheduleService.deleteCacheKeepaliveSchedules).toHaveBeenCalledOnce();
    expect(runtime.scheduleService.scheduleCacheKeepalive).not.toHaveBeenCalled();
  });

  it("records continue at arrival without creating a pending generation", async () => {
    const task = makeTask();
    task.claudeContextUsage = { usedTokens: 1_000, maxTokens: 200_000 };
    task.interventionQueue.push({ text: "continue", user: "Alice" });
    const now = Date.now();
    const runtime = makeRuntime(task, [{
      id: 1,
      session_id: task.agentSessionId,
      event_type: "complete",
      payload: {},
      searchable_text: "",
      created_at: new Date(now - 60_000),
    }]);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const requestRollover = vi.spyOn(runtime.persistentSessions, "requestGenerationRollover");
    const executor = taskExecutor(task, runtime, () => makeEngine([{
      type: "complete",
      usage: {},
      timestamp: Date.now() / 1_000,
      first_call: { input_tokens: 1_000, cached_input_tokens: 900 },
    } as unknown as SSEEventPayload]));

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(requestRollover).not.toHaveBeenCalled();
    expect(task.persistentGeneration?.pending).toBeUndefined();
    const arrival = runtime.persistenceDouble.enqueueEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .find((event) => event.kind === "persistent_decision" && event.trigger === "arrival");
    expect(arrival).toMatchObject({ action: "continue", rule: "arrival.warm.within_budget" });
  });

  it("skips the arrival decision when the first queued input is a cache keepalive", async () => {
    const task = makeTask();
    task.claudeContextUsage = { usedTokens: 130_001, maxTokens: 200_000 };
    task.interventionQueue.push({
      text: "cache keepalive",
      user: "Soulstream Scheduler",
      callerInfo: { source: "system", display_name: "Soulstream Scheduler" },
      purpose: "cache_keepalive",
    });
    const now = Date.now();
    const runtime = makeRuntime(task, [{
      id: 1,
      session_id: task.agentSessionId,
      event_type: "complete",
      payload: {},
      searchable_text: "",
      created_at: new Date(now - 60_000),
    }]);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const requestRollover = vi.spyOn(runtime.persistentSessions, "requestGenerationRollover");
    const executor = taskExecutor(task, runtime, () => makeEngine([{
      type: "complete",
      usage: {},
      timestamp: Date.now() / 1_000,
      first_call: { input_tokens: 1_000, cached_input_tokens: 900 },
    } as unknown as SSEEventPayload]));

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(requestRollover).not.toHaveBeenCalled();
    const arrival = runtime.persistenceDouble.enqueueEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .find((event) => event.kind === "persistent_decision" && event.trigger === "arrival");
    expect(arrival).toBeUndefined();
  });

  it("holds the execution slot while refreshing stale account observations", async () => {
    const task = makeTask();
    task.interventionQueue.push({ text: "continue", user: "Alice" });
    const now = Date.now();
    const runtime = makeRuntime(task, [{
      id: 1,
      session_id: task.agentSessionId,
      event_type: "complete",
      payload: {},
      searchable_text: "",
      created_at: new Date(now - 60_000),
    }]);
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetchUsage = vi.fn(async () => {
      await refreshGate;
      const usage = makeUsage();
      rememberProviderUsageObservation("claude", usage);
      rememberProviderUsageObservation("codex", usage);
      return { success: true } as never;
    });
    (runtime.providerUsage as unknown as { fetchUsage: typeof fetchUsage }).fetchUsage = fetchUsage;
    const executor = taskExecutor(task, runtime, () => makeEngine([{
      type: "complete",
      usage: {},
      timestamp: Date.now() / 1_000,
      first_call: { input_tokens: 1_000, cached_input_tokens: 900 },
    } as unknown as SSEEventPayload]));

    const firstExecution = executor.startNewExecution(task, agent);
    expect(() => executor.startNewExecution(task, agent)).toThrow(
      "already has an execution admission in flight",
    );
    releaseRefresh();
    await firstExecution;
    await task.executionPromise;

    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(task.status).toBe("completed");
  });

  it("skips the arrival decision when a manual generation request is already pending", async () => {
    const task = makeTask();
    task.persistentGeneration!.pending = {
      number: 2,
      reason: "manual",
      requestedAt: "2026-10-06T00:00:00.000Z",
      targetModelPreset: "codex-6.1-sol",
      targetReasoningEffort: "high",
    };
    task.claudeContextUsage = { usedTokens: 130_001, maxTokens: 200_000 };
    task.interventionQueue.push({ text: "continue", user: "Alice" });
    const now = Date.now();
    const runtime = makeRuntime(task, [{
      id: 1,
      session_id: task.agentSessionId,
      event_type: "context_usage",
      payload: { used_tokens: 130_001, estimated: false },
      searchable_text: "",
      created_at: new Date(now - 60_000),
    }]);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const requestRollover = vi.spyOn(runtime.persistentSessions, "requestGenerationRollover");
    const contextBuilder = makeContextBuilder();
    const sessionMutations = { setModelSelection: vi.fn(async () => undefined) };
    const executor = taskExecutor(
      task,
      runtime,
      () => makeEngine([
        { type: "session", session_id: "native-new" } as SSEEventPayload,
        {
          type: "complete",
          usage: {},
          timestamp: Date.now() / 1_000,
          first_call: { input_tokens: 40_000, cached_input_tokens: 0 },
        } as unknown as SSEEventPayload,
      ]),
      contextBuilder,
      sessionMutations,
    );

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(requestRollover).not.toHaveBeenCalled();
    expect(contextBuilder.buildGenerationContext).toHaveBeenCalledOnce();
    const triggers = runtime.persistenceDouble.enqueueEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((event) => event.kind === "persistent_decision")
      .map((event) => event.trigger);
    expect(triggers).toEqual(["turn_end"]);
  });

  it("records keepalive usage and schedules one wake after a successful marked turn", async () => {
    const task = makeTask();
    task.interventionQueue.push({
      text: "cache keepalive",
      user: "Soulstream Scheduler",
      callerInfo: { source: "system", display_name: "Soulstream Scheduler" },
      purpose: "cache_keepalive",
    });
    const completeTimestamp = Date.now() / 1_000;
    const events = [{
      id: 1,
      session_id: task.agentSessionId,
      event_type: "intervention_sent",
      payload: {
        caller_info: { source: "system" },
        purpose: "cache_keepalive",
      },
      searchable_text: "",
      created_at: new Date(),
    }];
    const runtime = makeRuntime(task, events);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const engine = makeEngine([{
      type: "complete",
      usage: {},
      timestamp: completeTimestamp,
      first_call: { input_tokens: 1_000, cached_input_tokens: 900 },
    } as unknown as SSEEventPayload]);
    const executor = taskExecutor(task, runtime, () => engine);

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(runtime.scheduleService.deleteCacheKeepaliveSchedules).toHaveBeenCalledOnce();
    expect(runtime.scheduleService.scheduleCacheKeepalive).toHaveBeenCalledOnce();
    expect(runtime.scheduleService.scheduleCacheKeepalive).toHaveBeenCalledWith(
      task.agentSessionId,
      new Date((completeTimestamp + 3_000) * 1_000).toISOString(),
      expect.any(Date),
    );
    const decisions = runtime.persistenceDouble.enqueueEvent.mock.calls
      .map((call) => call[1] as Record<string, unknown>)
      .filter((event) => event.kind === "persistent_decision");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      trigger: "turn_end",
      action: "schedule_keepalive",
      keepalive_result: {
        input_tokens: 1_000,
        cached_input_tokens: 900,
        cache_hit: true,
      },
    });
  });

  it("does not clear or record a keepalive reservation when the engine turn errors", async () => {
    const task = makeTask();
    task.interventionQueue.push({
      text: "cache keepalive",
      user: "Soulstream Scheduler",
      purpose: "cache_keepalive",
    });
    const runtime = makeRuntime(task, []);
    rememberProviderUsageObservation("claude", makeUsage());
    rememberProviderUsageObservation("codex", makeUsage());
    const engine: EnginePort = {
      ...makeEngine([]),
      async *execute(): AsyncIterable<SSEEventPayload> {
        throw new Error("engine failure");
      },
    };
    const executor = taskExecutor(task, runtime, () => engine);

    const execution = executor.startNewExecution(task, agent);
    await execution;
    await task.executionPromise;

    expect(task.status).toBe("error");
    expect(runtime.scheduleService.deleteCacheKeepaliveSchedules).not.toHaveBeenCalled();
    expect(runtime.scheduleService.scheduleCacheKeepalive).not.toHaveBeenCalled();
    expect(runtime.persistenceDouble.enqueueEvent.mock.calls.some(
      (call) => (call[1] as Record<string, unknown>).kind === "persistent_decision",
    )).toBe(false);
  });
});
