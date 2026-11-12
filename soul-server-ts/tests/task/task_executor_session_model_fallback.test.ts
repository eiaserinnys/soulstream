/**
 * 일반 세션이 실행 중 한도에 걸렸을 때 서버가 같은 세션에서 다음 모델로 이어 가는
 * 흐름을 TaskExecutor부터 재개 예약, ScheduleDispatcher 깨우기, 다음 세대 실행까지
 * 한 번에 재현한다(카드 #1161).
 */
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_MODEL_FALLBACK_REASON,
  buildModelPresetFallbackMetadataEntry,
} from "@soulstream/wire-schema/model-preset-fallbacks";

import type { AgentProfile } from "../../src/agent_registry.js";
import type { SessionDB } from "../../src/db/session_db.js";
import { AntigravityEventMapper } from "../../src/engine/antigravity/events.js";
import type { EnginePort, SSEEventPayload } from "../../src/engine/protocol.js";
import type { OrchProxyConfig } from "../../src/mcp/runtime.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import { ScheduleDispatcher } from "../../src/schedule/schedule_dispatcher.js";
import type { ScheduleCreateInput, SoulstreamSchedule } from "../../src/schedule/schedule_models.js";
import { SoulstreamScheduleService } from "../../src/schedule/schedule_service.js";
import type { CompletionNotifier } from "../../src/task/completion_notifier.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";
import { prepareTaskForAutoResume } from "../../src/task/task_auto_resume_transition.js";
import {
  SESSION_MODEL_FALLBACK_RESUME_PROMPT,
  chooseSessionModelFallbackTarget,
} from "../../src/task/session_model_fallback.js";
import { TaskExecutor } from "../../src/task/task_executor.js";
import type { InterventionMessage, Task } from "../../src/task/task_models.js";
import type { SessionBroadcaster } from "../../src/upstream/session_broadcaster.js";
import { makeEventPersistenceTestDouble } from "./event_persistence_test_double.js";

const logger = pino({ level: "silent" });
const agent: AgentProfile = {
  id: "claude-default",
  name: "Claude Default",
  backend: "claude",
  workspace_dir: "/tmp/claude-default",
};
const orch: OrchProxyConfig = {
  baseUrl: "https://orch.example.test",
  headers: { authorization: "Bearer test-token" },
};

function makeTask(modelPreset = "gemini-4-argon"): Task {
  const backend = modelPreset === "gemini-4-argon"
    ? "antigravity"
    : modelPreset.startsWith("claude") ? "claude" : "codex";
  return {
    agentSessionId: "clip-session",
    prompt: "다이제스트를 만들어 주세요",
    status: "running",
    profileId: agent.id,
    persistent: false,
    callerSessionId: "caller-session",
    modelPreset,
    model: `${modelPreset}-model`,
    modelPresetBackend: backend,
    modelPresetEnv: {},
    metadata: [
      buildModelPresetFallbackMetadataEntry("gemini-4-argon", ["claude-opus", "codex-6.1-sol"]),
    ],
    createdAt: new Date(),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [],
  } as unknown as Task;
}

function makeModelCatalog(): Pick<ModelCatalog, "resolve" | "snapshot"> {
  return {
    resolve: vi.fn((id: string) => ({
      id,
      label: id,
      backend: id === "gemini-4-argon"
        ? "antigravity" as const
        : id.startsWith("claude") ? "claude" as const : "codex" as const,
      model: `${id}-model`,
      env: {},
      supported_efforts: ["low" as const, "medium" as const, "high" as const],
    })),
    snapshot: () => ({
      presets: [],
      models: [],
      persistent_defaults: { fallback_models: [] },
    }),
  } as unknown as Pick<ModelCatalog, "resolve" | "snapshot">;
}

function stubAdvertisedPresets(): void {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async () => new Response(
    JSON.stringify({
      model_presets: [
        { id: "gemini-4-argon", available: false, weekly_headroom: null },
        { id: "claude-opus", available: true, weekly_headroom: { remaining_percent: 60 } },
        { id: "codex-6.1-sol", available: true, weekly_headroom: { remaining_percent: 80 } },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
}

function limitEngine(backendId: string): EnginePort {
  return {
    backendId,
    workspaceDir: "/tmp/antigravity",
    async *execute(): AsyncIterable<SSEEventPayload> {
      const mapper = new AntigravityEventMapper("quota-turn");
      mapper.accept({ event: "result", result: {
        status: "ERROR",
        error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54h42m58s.",
      } });
      for (const event of mapper.terminal({ code: 1, signal: null }, false)) yield event;
      throw new Error("quota exhausted");
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function completingEngine(backendId: string, nativeSessionId: string): EnginePort {
  return {
    backendId,
    workspaceDir: "/tmp/workspace",
    async *execute(): AsyncIterable<SSEEventPayload> {
      yield { type: "session", session_id: nativeSessionId } as SSEEventPayload;
      yield {
        type: "complete",
        result: "다이제스트 완료",
        usage: {},
        timestamp: Date.now() / 1_000,
      } as unknown as SSEEventPayload;
    },
    async interrupt() { return true; },
    async close() {},
  };
}

function makeContextBuilder() {
  return {
    // 첫 턴은 일반 조립(여기서는 task.prompt 그대로), 이어 받은 세대는 세대 조립을 쓴다.
    build: vi.fn(async () => undefined),
    buildGenerationContext: vi.fn(async () => ({
      effectiveSystemPrompt: "generation instructions",
      combinedContextItems: [{ key: "original_request", label: "이어갈 원래 요청", content: "다이제스트를 만들어 주세요" }],
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

function makeResumeScheduleRuntime(
  persistence: ReturnType<typeof makeEventPersistenceTestDouble>["persistence"],
) {
  let schedule: SoulstreamSchedule | null = null;
  const db = {
    createScheduleIfAbsent: vi.fn(async (input: ScheduleCreateInput) => {
      if (schedule) return null;
      schedule = {
        scheduleId: input.scheduleId,
        sessionId: input.sessionId,
        kind: input.kind,
        status: "active",
        prompt: input.prompt,
        sourceTool: input.sourceTool,
        toolUseId: input.toolUseId ?? null,
        cronExpression: input.cronExpression ?? null,
        runOnceAt: input.runOnceAt?.toISOString() ?? null,
        timezone: input.timezone ?? "UTC",
        recurring: input.recurring,
        nextRunAt: input.nextRunAt.toISOString(),
        lastFiredAt: null,
        firedCount: 0,
        dispatchFailureCount: 0,
        lastError: null,
        claimToken: null,
        claimedUntil: null,
        createdAt: input.createdAt?.toISOString() ?? new Date().toISOString(),
        updatedAt: input.createdAt?.toISOString() ?? new Date().toISOString(),
      };
      return schedule;
    }),
    touchNodeHeartbeat: vi.fn(async () => undefined),
    repairExpiredClaims: vi.fn(async () => []),
    restoreOrphanSchedulesForLiveNodes: vi.fn(async () => []),
    markOrphanDueSchedules: vi.fn(async () => []),
    claimDueSchedules: vi.fn(async ({ now }: { now: Date }) =>
      schedule && Date.parse(schedule.nextRunAt ?? "") <= now.getTime()
        ? [{ schedule, claimToken: "resume-claim" }]
        : []),
    consumeClaimedSchedule: vi.fn(async () => {
      if (!schedule) return null;
      schedule = { ...schedule, status: "firing" };
      return schedule;
    }),
    confirmScheduleStillFiring: vi.fn(async () => schedule),
    hasContinuousLimitWindow: vi.fn(async (
      candidate: SoulstreamSchedule,
      currentTerminalEventId: number,
    ) => candidate.toolUseId === `ResumeAfterLimit:${currentTerminalEventId}`),
    finishScheduleDispatch: vi.fn(async ({ firedAt }: { firedAt: Date }) => {
      if (!schedule) return null;
      schedule = { ...schedule, status: "completed", nextRunAt: null, lastFiredAt: firedAt.toISOString() };
      return schedule;
    }),
  };
  const service = new SoulstreamScheduleService(
    db as never,
    { emitEventEnvelope: vi.fn(async () => undefined) } as never,
    persistence,
    logger,
  );
  return { db, service, getSchedule: () => schedule };
}

function makeHarness(task: Task) {
  const persistenceDouble = makeEventPersistenceTestDouble();
  const modelCatalog = makeModelCatalog();
  const db = {
    readEvents: vi.fn(async () => []),
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
  const resumeSchedule = makeResumeScheduleRuntime(persistenceDouble.persistence);
  const scheduleResumeAfterLimit = vi.fn((
    ...args: Parameters<SoulstreamScheduleService["scheduleResumeAfterLimit"]>
  ) => resumeSchedule.service.scheduleResumeAfterLimit(...args));
  const notify = vi.fn(async () => undefined);
  const contextBuilder = makeContextBuilder();
  const requestedBackends: Array<string | undefined> = [];
  // 첫 실행은 한도로 끝나고, 이어 받은 세대는 결과를 낸다.
  const executor = new TaskExecutor(
    (_profile, backend) => {
      requestedBackends.push(backend);
      return requestedBackends.length === 1
        ? limitEngine(backend ?? "antigravity")
        : completingEngine(backend ?? "claude", "native-next");
    },
    db,
    persistenceDouble.persistence,
    broadcaster,
    logger,
    contextBuilder as never,
    { notify } as unknown as CompletionNotifier,
    undefined,
    undefined,
    undefined,
    modelCatalog,
    undefined,
    undefined,
    undefined,
    undefined,
    { setModelSelection: vi.fn(async () => undefined) },
    undefined,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    {
      chooseTarget: (current) => chooseSessionModelFallbackTarget(current, {
        nodeId: "eiaserinnys",
        orch,
        modelCatalog,
        logger,
      }),
      persistentSessions,
      scheduleService: { scheduleResumeAfterLimit },
    },
  );
  return {
    executor,
    persistenceDouble,
    persistentSessions,
    resumeSchedule,
    scheduleResumeAfterLimit,
    notify,
    contextBuilder,
    requestedBackends,
  };
}

function enqueuedEvents(harness: ReturnType<typeof makeHarness>): Record<string, unknown>[] {
  return harness.persistenceDouble.enqueueEvent.mock.calls
    .map((call) => call[1] as Record<string, unknown>);
}

async function run(harness: ReturnType<typeof makeHarness>, task: Task): Promise<void> {
  await harness.executor.startNewExecution(task, agent);
  await task.executionPromise;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskExecutor session model fallback flow", () => {
  it("continues an Argon limit stop on Opus in the same session and reports once", async () => {
    stubAdvertisedPresets();
    const task = makeTask();
    const harness = makeHarness(task);

    await run(harness, task);

    // 1세대: Argon 한도로 끝나되, terminal 저장 전에 Opus pending이 남는다.
    expect(task.terminationReason).toBe("limit_hit");
    expect(task.persistentGeneration?.pending).toMatchObject({
      reason: SESSION_MODEL_FALLBACK_REASON,
      targetModelPreset: "claude-opus",
    });
    const metadataCalls = harness.persistenceDouble.enqueueMetadataEffect.mock;
    const pendingCallIndex = metadataCalls.calls.findIndex((call) =>
      (call[1] as Record<string, unknown>).type === "persistent_generation");
    expect(pendingCallIndex).toBeGreaterThanOrEqual(0);
    const terminalCalls = harness.persistenceDouble.enqueueTerminalTransitionAndWaitForApplication.mock;
    expect(terminalCalls.invocationCallOrder.length).toBeGreaterThan(0);
    expect(metadataCalls.invocationCallOrder[pendingCallIndex])
      .toBeLessThan(terminalCalls.invocationCallOrder[0]!);
    expect(harness.scheduleResumeAfterLimit).toHaveBeenCalledWith(
      task.agentSessionId,
      task.terminalEventId,
      expect.any(Date),
      expect.any(Date),
      SESSION_MODEL_FALLBACK_RESUME_PROMPT,
    );
    // 중간 종료는 부른 쪽에 완료로 알리지 않는다.
    expect(harness.notify).not.toHaveBeenCalled();

    // 재개 예약이 바로 깨어나 같은 세션에 이어가기 입력을 넣는다.
    const addIntervention = vi.fn(async () => ({ autoResumed: true }));
    const dispatcher = new ScheduleDispatcher(
      { nodeId: "eiaserinnys", startedAt: new Date(0) },
      harness.resumeSchedule.service,
      {
        getScheduleResumeState: vi.fn(async () => ({
          status: "error" as const,
          terminationReason: "limit_hit" as const,
          terminalEventId: task.terminalEventId!,
        })),
        addIntervention,
      } as never,
      vi.fn(),
      logger,
    );
    await dispatcher.runOnce(new Date(Date.now() + 1_000));
    expect(addIntervention).toHaveBeenCalledWith(expect.objectContaining({
      agentSessionId: task.agentSessionId,
      text: `[Scheduled wakeup]\n\n${SESSION_MODEL_FALLBACK_RESUME_PROMPT}`,
    }), expect.any(Function));

    // 2세대: 깨운 입력을 실제 자동 재개 준비에 넣어 다시 시작하면 pending이 적용되어
    // Opus가 결과를 낸다.
    const wakeup = (addIntervention.mock.calls[0] as unknown[])[0] as InterventionMessage;
    prepareTaskForAutoResume(task, wakeup, "running");
    await run(harness, task);

    expect(harness.requestedBackends).toEqual(["antigravity", "claude"]);
    expect(task.modelPreset).toBe("claude-opus");
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(harness.contextBuilder.buildGenerationContext).toHaveBeenCalledOnce();
    expect(enqueuedEvents(harness)).toContainEqual(
      expect.objectContaining({ type: "generation_started" }),
    );
    expect(task.status).toBe("completed");
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it("ends normally when no fallback candidate remains after the current preset", async () => {
    stubAdvertisedPresets();
    // 마지막 후보(Sol)에서 한도가 나면 이어 갈 모델이 없다.
    const task = makeTask("codex-6.1-sol");
    const harness = makeHarness(task);

    await run(harness, task);

    expect(task.terminationReason).toBe("limit_hit");
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(harness.scheduleResumeAfterLimit).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledOnce();
  });

  it("clears the pending and reports the stop when the resume cannot be scheduled", async () => {
    stubAdvertisedPresets();
    const task = makeTask();
    const harness = makeHarness(task);
    harness.scheduleResumeAfterLimit.mockRejectedValueOnce(new Error("schedule store down"));

    await run(harness, task);

    expect(task.terminationReason).toBe("limit_hit");
    expect(harness.scheduleResumeAfterLimit).toHaveBeenCalledOnce();
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(harness.notify).toHaveBeenCalledOnce();
  });
});
