import { describe, expect, it, vi } from "vitest";

import type { AgentProfile } from "../../src/agent_registry.js";
import { UnknownModelPresetError } from "../../src/model_catalog.js";
import {
  beginGenerationRolloverIfPending,
  commitStart,
  complete,
  persistUnavailablePresetFailure,
  publishStarted,
} from "../../src/task/persistent_generation_rollover.js";
import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { PersistentCheckpointStats } from "../../src/context/persistent_checkpoint.js";
import type { Task } from "../../src/task/task_models.js";

const agent: AgentProfile = {
  id: "agent-1",
  name: "Agent",
  backend: "claude",
  workspace_dir: "/tmp/agent",
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-1",
    prompt: "unused initial prompt",
    status: "running",
    persistent: true,
    codexThreadId: "native-old",
    modelPreset: "claude-old",
    model: "claude-model-old",
    modelPresetBackend: "claude",
    modelPresetEnv: { CLAUDE_PROFILE: "old" },
    persistentGeneration: {
      number: 1,
      backendSessionId: "native-old",
      pending: {
        number: 2,
        reason: "context limit",
        requestedAt: "2026-10-05T00:00:00.000Z",
        targetModelPreset: "codex-new",
        targetReasoningEffort: "high",
      },
    },
    createdAt: new Date("2026-10-05T00:00:00.000Z"),
    lastEventId: 0,
    lastReadEventId: 0,
    interventionQueue: [{ text: "continue" }],
    ...overrides,
  };
}

function makeCatalog() {
  return {
    resolve: vi.fn((id: string) => {
      if (id === "codex-new") {
        return {
          id,
          label: "Codex New",
          backend: "codex" as const,
          model: "codex-model-new",
          env: { CODEX_PROFILE: "new" },
          supported_efforts: ["high" as const],
        };
      }
      throw new UnknownModelPresetError(id);
    }),
  };
}

describe("beginGenerationRolloverIfPending", () => {
  it("applies a requested generation to a persistent session with queued input", () => {
    const task = makeTask();
    const catalog = makeCatalog();

    const rollover = beginGenerationRolloverIfPending(task, agent, catalog);

    expect(rollover).toMatchObject({
      number: 2,
      reason: "context limit",
      fromBackendSessionId: "native-old",
      previousModelPreset: "claude-old",
      previousBackend: "claude",
    });
    expect(task.modelPreset).toBe("codex-new");
    expect(task.model).toBe("codex-model-new");
    expect(task.modelPresetBackend).toBe("codex");
    expect(task.modelPresetEnv).toEqual({ CODEX_PROFILE: "new" });
    expect(task.reasoningEffort).toBe("high");
    expect(task.claudeContextUsage).toBeUndefined();
  });

  it.each([
    ["persistent marker off", { persistent: false }],
    ["queue empty", { interventionQueue: [] }],
    ["native id absent", { codexThreadId: undefined }],
    ["retained runner", { runnerRetainedForDetachedWork: true }],
    ["runtime follow-up is first", {
      interventionQueue: [{ text: "background result", source: "claude_runtime_task_followup" }],
    }],
  ])("leaves a requested generation pending when %s", (_label, overrides) => {
    const task = makeTask(overrides);
    const catalog = makeCatalog();

    const rollover = beginGenerationRolloverIfPending(task, agent, catalog);

    expect(rollover).toBeUndefined();
    expect(task.persistentGeneration?.pending?.applyingFrom).toBeUndefined();
    expect(task.modelPreset).toBe("claude-old");
    expect(catalog.resolve).not.toHaveBeenCalled();
  });

  it("continues an applying generation despite a disabled marker and empty queue", () => {
    const task = makeTask({
      persistent: false,
      interventionQueue: [],
      persistentGeneration: {
        number: 1,
        pending: {
          number: 2,
          reason: "context limit",
          requestedAt: "2026-10-05T00:00:00.000Z",
          targetModelPreset: "codex-new",
          targetReasoningEffort: "high",
          applyingFrom: "native-old",
        },
      },
    });

    const rollover = beginGenerationRolloverIfPending(task, agent, makeCatalog());

    expect(rollover?.fromBackendSessionId).toBe("native-old");
    expect(task.modelPresetBackend).toBe("codex");
  });

  it("reuses the same separator dedupe key after hydrating an applying generation", async () => {
    const task = makeTask({
      modelPreset: "codex-new",
      model: "codex-model-new",
      modelPresetBackend: "codex",
      persistentGeneration: {
        number: 1,
        pending: {
          number: 2,
          reason: "context limit",
          requestedAt: "2026-10-05T00:00:00.000Z",
          targetModelPreset: "codex-new",
          targetReasoningEffort: "high",
          applyingFrom: "native-old",
        },
      },
    });
    beginGenerationRolloverIfPending(task, agent, makeCatalog());
    const checkpoint: PersistentCheckpointStats = {
      estimatedTokens: 321,
      chars: 987,
      sections: { state: 111, story: 222, summaries: 333, recent: 321 },
      summarizedThroughTurn: 4,
      recentFromEventId: 10,
      recentToEventId: 12,
    };
    const enqueueEventAndWaitForSessionAck = vi.fn(async () => ({
      record: {} as never,
      eventId: 26,
    }));

    await publishStarted(
      task,
      checkpoint,
      { enqueueEventAndWaitForSessionAck } as unknown as EventPersistence,
    );
    await publishStarted(
      task,
      checkpoint,
      { enqueueEventAndWaitForSessionAck } as unknown as EventPersistence,
    );

    const keys = enqueueEventAndWaitForSessionAck.mock.calls.map((call) => {
      const event = call[1] as unknown as Record<string, unknown>;
      return event._dedupe_key;
    });
    expect(task.activeGenerationRollover?.fromBackendSessionId).toBe("native-old");
    expect(keys).toEqual([
      "generation_started:session-1:2",
      "generation_started:session-1:2",
    ]);
  });

  it("clears and records a target preset that disappeared after the request", async () => {
    const task = makeTask({
      persistentGeneration: {
        number: 1,
        pending: {
          number: 2,
          reason: "context limit",
          requestedAt: "2026-10-05T00:00:00.000Z",
          targetModelPreset: "removed-preset",
        },
      },
    });
    const warn = vi.fn();

    const rollover = beginGenerationRolloverIfPending(task, agent, makeCatalog(), { warn });

    expect(rollover).toBeUndefined();
    expect(task.modelPreset).toBe("claude-old");
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(task.activeGenerationRollover).toBeUndefined();
    expect(task.metadata?.at(-1)?.value).toMatchObject({
      last_failure: {
        generation: 2,
        requested_at: "2026-10-05T00:00:00.000Z",
        target_model_preset: "removed-preset",
        reason: "target_model_preset_unavailable",
      },
    });
    expect(warn).toHaveBeenCalledOnce();

    const enqueueMetadataEffect = vi.fn(async () => 28);
    await persistUnavailablePresetFailure(
      task,
      { enqueueMetadataEffect } as unknown as EventPersistence,
    );
    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      "session-1",
      task.metadata?.at(-1),
      expect.objectContaining({
        replaceExistingType: "persistent_generation",
        waitForAck: true,
        semanticDedupeKey: "generation_failure:session-1:2:2026-10-05T00:00:00.000Z",
      }),
    );
    expect(task.pendingPersistentGenerationRolloverFailure).toBeUndefined();
    expect(task.lastEventId).toBe(28);
  });

  it("records applying metadata before the idempotent model selection update", async () => {
    const task = makeTask();
    beginGenerationRolloverIfPending(task, agent, makeCatalog());
    const calls: string[] = [];
    const persistence = {
      enqueueMetadataEffect: vi.fn(async () => {
        calls.push("metadata");
        return 25;
      }),
    } as unknown as EventPersistence;
    const sessionMutations = {
      setModelSelection: vi.fn(async (_sessionId, _fields, key) => {
        calls.push(`selection:${key}`);
      }),
    };

    await commitStart(task, persistence, sessionMutations);

    expect(calls).toEqual([
      "metadata",
      "selection:persistent_generation_model_selection:session-1:2",
    ]);
    expect(task.persistentGeneration?.pending?.applyingFrom).toBe("native-old");
    expect(task.metadata?.at(-1)).toMatchObject({
      type: "persistent_generation",
      value: { pending: { applying_from: "native-old" } },
    });
    expect(task.lastEventId).toBe(25);
  });

  it("publishes the generation separator with checkpoint statistics and stable dedupe", async () => {
    const task = makeTask();
    beginGenerationRolloverIfPending(task, agent, makeCatalog());
    const checkpoint: PersistentCheckpointStats = {
      estimatedTokens: 321,
      chars: 987,
      sections: { state: 111, story: 222, summaries: 333, recent: 321 },
      summarizedThroughTurn: 4,
      recentFromEventId: 10,
      recentToEventId: 12,
    };
    const enqueueEventAndWaitForSessionAck = vi.fn(async () => ({
      record: {} as never,
      eventId: 26,
    }));
    const persistence = { enqueueEventAndWaitForSessionAck } as unknown as EventPersistence;

    await publishStarted(task, checkpoint, persistence);

    const event = enqueueEventAndWaitForSessionAck.mock.calls[0]?.[1] as unknown as
      Record<string, unknown>;
    expect(event).toMatchObject({
      type: "generation_started",
      generation: 2,
      previous: { model_preset: "claude-old", backend: "claude" },
      current: { model_preset: "codex-new", backend: "codex", model: "codex-model-new" },
      checkpoint: {
        estimated_tokens: 321,
        chars: 987,
        summarized_through_turn: 4,
        recent_from_event_id: 10,
        recent_to_event_id: 12,
      },
      _dedupe_key: "generation_started:session-1:2",
    });
    expect(task.lastEventId).toBe(26);
  });

  it("records the new generation and measured first_call, preserving the previous measurement when absent", async () => {
    const task = makeTask();
    beginGenerationRolloverIfPending(task, agent, makeCatalog());
    task.codexThreadId = "native-new";
    task.activeGenerationRollover!.firstCall = {
      inputTokens: 246708,
      cachedInputTokens: 245563,
    };
    const enqueueMetadataEffect = vi.fn(async () => 27);
    const persistence = { enqueueMetadataEffect } as unknown as EventPersistence;

    expect(await complete(task, persistence)).toBe(true);
    expect(task.persistentGeneration).toMatchObject({
      number: 2,
      backendSessionId: "native-new",
      firstCall: {
        generation: 2,
        inputTokens: 246708,
        cachedInputTokens: 245563,
        modelPreset: "codex-new",
        model: "codex-model-new",
      },
    });
    expect(task.persistentGeneration?.pending).toBeUndefined();
    expect(task.activeGenerationRollover).toBeUndefined();

    const preserved = makeTask({
      persistentGeneration: {
        number: 1,
        firstCall: {
          generation: 1,
          inputTokens: 5,
          cachedInputTokens: 3,
          modelPreset: "claude-old",
          model: "claude-model-old",
          measuredAt: "2026-10-04T00:00:00.000Z",
        },
        pending: {
          number: 2,
          reason: "context limit",
          requestedAt: "2026-10-05T00:00:00.000Z",
          targetModelPreset: "codex-new",
        },
      },
    });
    beginGenerationRolloverIfPending(preserved, agent, makeCatalog());
    preserved.codexThreadId = "native-new";
    expect(await complete(preserved, persistence)).toBe(true);
    expect(preserved.persistentGeneration?.firstCall).toEqual({
      generation: 1,
      inputTokens: 5,
      cachedInputTokens: 3,
      modelPreset: "claude-old",
      model: "claude-model-old",
      measuredAt: "2026-10-04T00:00:00.000Z",
    });
  });
});
