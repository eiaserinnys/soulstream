import { describe, expect, it, vi } from "vitest";

import type { EventPersistence } from "../../src/db/event_persistence.js";
import type { ModelCatalog } from "../../src/model_catalog.js";
import type { Task } from "../../src/task/task_models.js";
import { PersistentSessionControl } from "../../src/task/persistent_session_control.js";

const firstCall = {
  generation: 1,
  inputTokens: 246708,
  cachedInputTokens: 245563,
  modelPreset: "claude-preset",
  model: "claude-opus-4-6",
  measuredAt: "2026-10-05T09:00:00.000Z",
};

function makeRolloverControl(
  task: Task,
  options: { persistent?: EventPersistence; presets?: Record<string, Record<string, unknown>> } = {},
) {
  const persistedEntries: Array<Record<string, unknown>> = [];
  const enqueueMetadataEffect = vi.fn(async (_sessionId: string, entry: Record<string, unknown>) => {
    persistedEntries.push(entry);
    return 42;
  });
  const presets = options.presets ?? {
    "claude-preset": {
      id: "claude-preset",
      model: "claude-opus-4-6",
      backend: "claude",
      env: {},
      supported_efforts: ["low", "medium", "high"],
      default_effort: "medium",
    },
    "codex-preset": {
      id: "codex-preset",
      model: "gpt-5-codex",
      backend: "codex",
      env: {},
      supported_efforts: ["low", "medium", "high"],
      default_effort: "medium",
    },
    "agents-preset": {
      id: "agents-preset",
      model: "gpt-5",
      backend: "openai-agents",
      env: {},
      supported_efforts: ["low", "medium", "high"],
      default_effort: "medium",
    },
  };
  const modelCatalog = {
    resolve: vi.fn((presetId: string) => presets[presetId]),
  } as unknown as Pick<ModelCatalog, "resolve">;
  const persistence = options.persistent ?? { enqueueMetadataEffect } as unknown as EventPersistence;
  const control = new PersistentSessionControl({
    getTask: vi.fn((sessionId) => sessionId === task.agentSessionId ? task : undefined),
    loadEvictedTask: vi.fn(),
    rememberTask: vi.fn(),
    persistence,
    modelCatalog,
    resolveCurrentBackend: (candidate) => candidate.modelPresetBackend
      ?? (candidate.modelPreset ? modelCatalog.resolve(candidate.modelPreset).backend : undefined),
  });
  return { control, enqueueMetadataEffect, persistedEntries, modelCatalog };
}

function makeRolloverTask(overrides: Partial<Task> = {}): Task {
  return {
    agentSessionId: "session-generation",
    sessionType: "claude",
    status: "running",
    persistent: true,
    metadata: [{ type: "persistent_session", value: { enabled: true } }],
    modelPreset: "claude-preset",
    modelPresetBackend: "claude",
    model: "claude-opus-4-6",
    reasoningEffort: "medium",
    codexThreadId: "native-current",
    persistentGeneration: { number: 1, firstCall },
    ...overrides,
  } as Task;
}

describe("PersistentSessionControl", () => {
  it("durably replaces the marker before updating the in-memory Task", async () => {
    const task = {
      agentSessionId: "session-persistent",
      sessionType: "claude",
      metadata: [
        { type: "other_metadata", value: { retained: true } },
        { type: "persistent_session", value: { enabled: false, updated_at: "old" } },
      ],
    } as Task;
    const enqueueMetadataEffect = vi.fn().mockResolvedValue(42);
    const control = new PersistentSessionControl({
      getTask: vi.fn((sessionId) => sessionId === task.agentSessionId ? task : undefined),
      loadEvictedTask: vi.fn(),
      rememberTask: vi.fn(),
      persistence: { enqueueMetadataEffect } as unknown as EventPersistence,
    });

    await expect(control.setSessionPersistent(task.agentSessionId, true)).resolves.toEqual({
      sessionId: task.agentSessionId,
      persistent: true,
      generation: 1,
    });

    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "persistent_session",
        value: expect.objectContaining({
          enabled: true,
          updated_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        }),
      }),
      { replaceExistingType: "persistent_session", waitForAck: true },
    );
    expect(task.metadata).toHaveLength(2);
    expect(task.metadata?.filter((entry) => entry.type === "persistent_session")).toHaveLength(1);
    expect(task.persistent).toBe(true);

    await control.setSessionPersistent(task.agentSessionId, false);
    expect(task.persistent).toBe(false);
    expect(task.metadata?.filter((entry) => entry.type === "persistent_session")).toHaveLength(1);
  });

  it("records a pending generation and keeps the last first-call measurement", async () => {
    const task = makeRolloverTask();
    const { control, enqueueMetadataEffect, persistedEntries } = makeRolloverControl(task);

    await expect(control.requestGenerationRollover(task.agentSessionId, {
      modelPreset: "codex-preset",
      reasoningEffort: "high",
      reason: "manual",
    })).resolves.toMatchObject({
      sessionId: task.agentSessionId,
      generation: 1,
      pendingGeneration: 2,
      sessionStatus: "running",
      applies: "next_execution_start",
    });

    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({
        type: "persistent_generation",
        value: expect.objectContaining({
          number: 1,
          first_call: {
            generation: 1,
            input_tokens: 246708,
            cached_input_tokens: 245563,
            model_preset: "claude-preset",
            model: "claude-opus-4-6",
            measured_at: "2026-10-05T09:00:00.000Z",
          },
          pending: expect.objectContaining({
            number: 2,
            reason: "manual",
            target_model_preset: "codex-preset",
            target_reasoning_effort: "high",
          }),
        }),
      }),
      { replaceExistingType: "persistent_generation", waitForAck: true },
    );
    expect(persistedEntries).toHaveLength(1);
    expect(task.persistentGeneration).toMatchObject({
      number: 1,
      firstCall,
      pending: {
        number: 2,
        targetModelPreset: "codex-preset",
        targetReasoningEffort: "high",
      },
    });
    expect(task.metadata?.some((entry) => entry.type === "persistent_session")).toBe(true);
  });

  it("overwrites a queued target with the newest request", async () => {
    const task = makeRolloverTask({
      persistentGeneration: {
        number: 3,
        firstCall,
        pending: {
          number: 4,
          reason: "old request",
          requestedAt: "2026-10-04T09:00:00.000Z",
          targetModelPreset: "claude-preset",
          targetReasoningEffort: "low",
        },
      },
    } as Partial<Task>);
    const { control } = makeRolloverControl(task);

    await control.requestGenerationRollover(task.agentSessionId, {
      modelPreset: "codex-preset",
      reasoningEffort: "high",
      reason: "replacement request",
    });

    expect(task.persistentGeneration).toMatchObject({
      number: 3,
      firstCall,
      pending: {
        number: 4,
        reason: "replacement request",
        targetModelPreset: "codex-preset",
        targetReasoningEffort: "high",
      },
    });
  });

  it("preserves applying_from while replacing an in-flight target", async () => {
    const task = makeRolloverTask({
      persistentGeneration: {
        number: 3,
        firstCall,
        pending: {
          number: 4,
          reason: "old request",
          requestedAt: "2026-10-04T09:00:00.000Z",
          targetModelPreset: "claude-preset",
          targetReasoningEffort: "low",
          applyingFrom: "native-current",
          previousModelPreset: "codex-source",
          previousBackend: "codex",
        },
      },
    } as Partial<Task>);
    const { control, persistedEntries } = makeRolloverControl(task);

    await control.requestGenerationRollover(task.agentSessionId, {
      modelPreset: "codex-preset",
      reasoningEffort: "high",
      reason: "replacement request",
    });

    expect(task.persistentGeneration?.pending).toMatchObject({
      number: 4,
      targetModelPreset: "codex-preset",
      targetReasoningEffort: "high",
      applyingFrom: "native-current",
      previousModelPreset: "codex-source",
      previousBackend: "codex",
    });
    expect(task.persistentGeneration?.pending?.requestedAt)
      .not.toBe("2026-10-04T09:00:00.000Z");
    expect(persistedEntries[0]?.value).toMatchObject({
      pending: {
        applying_from: "native-current",
        previous_model_preset: "codex-source",
        previous_backend: "codex",
      },
    });
  });

  it.each([
    ["current", "claude-preset", "openai-agents"],
    ["target", "agents-preset", "claude"],
  ] as const)("rejects an unsupported %s backend before writing metadata", async (_where, targetPreset, currentBackend) => {
    const task = makeRolloverTask({ modelPresetBackend: currentBackend as never });
    const { control, enqueueMetadataEffect } = makeRolloverControl(task);

    await expect(control.requestGenerationRollover(task.agentSessionId, {
      modelPreset: targetPreset,
      reason: "manual",
    })).rejects.toThrow();
    expect(enqueueMetadataEffect).not.toHaveBeenCalled();
  });
});

describe("PersistentSessionControl.applySettings", () => {
  const sonnet = { model_preset: "codex-preset", reasoning_effort: "high" };

  it("returns the real generation number when the marker is switched", async () => {
    const task = makeRolloverTask({ persistentGeneration: { number: 4, firstCall } } as Partial<Task>);
    const { control } = makeRolloverControl(task);

    await expect(control.setSessionPersistent(task.agentSessionId, false)).resolves.toEqual({
      sessionId: task.agentSessionId,
      persistent: false,
      generation: 4,
    });
  });

  it("does not report success before the settings ACK, then requests the model change", async () => {
    const task = makeRolloverTask();
    let release!: (eventId: number) => void;
    const settingsAck = new Promise<number>((resolve) => { release = resolve; });
    const enqueueMetadataEffect = vi.fn()
      .mockReturnValueOnce(settingsAck)
      .mockResolvedValue(43);
    const { control } = makeRolloverControl(task, {
      persistent: { enqueueMetadataEffect } as unknown as EventPersistence,
    });

    let settled = false;
    const saving = control.applySettings(task.agentSessionId, {
      settings: {
        default_model: sonnet,
        show_character: false,
        show_turn_usage: false,
        animate_character: false,
      },
    }).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(enqueueMetadataEffect).toHaveBeenCalledTimes(1);
    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      {
        type: "persistent_settings",
        value: {
          default_model: sonnet,
          fallback_model: null,
          show_generation_separator: true,
          show_character: false,
          show_jev_candidates: true,
          show_turn_usage: false,
          animate_character: false,
        },
      },
      { replaceExistingType: "persistent_settings", waitForAck: true },
    );

    release(42);
    await expect(saving).resolves.toEqual({
      sessionId: task.agentSessionId,
      persistent: true,
      modelChange: "next_execution_start",
    });
    expect(enqueueMetadataEffect).toHaveBeenLastCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "persistent_generation" }),
      { replaceExistingType: "persistent_generation", waitForAck: true },
    );
    expect(task.persistentGeneration?.pending).toMatchObject({
      reason: "settings",
      targetModelPreset: "codex-preset",
      targetReasoningEffort: "high",
    });
  });

  it("does not request a second change for the same pending target or the running model", async () => {
    const task = makeRolloverTask();
    const { control, enqueueMetadataEffect } = makeRolloverControl(task);
    const input = { settings: { default_model: sonnet } };

    await control.applySettings(task.agentSessionId, input);
    enqueueMetadataEffect.mockClear();

    await expect(control.applySettings(task.agentSessionId, input)).resolves.toMatchObject({ modelChange: "none" });
    await expect(control.applySettings(task.agentSessionId, {
      settings: { default_model: { model_preset: "claude-preset", reasoning_effort: "medium" } },
    })).resolves.toMatchObject({ modelChange: "none" });
    expect(enqueueMetadataEffect.mock.calls.map(([, entry]) => entry.type))
      .toEqual(["persistent_settings", "persistent_settings"]);

    await expect(control.applySettings(task.agentSessionId, {
      settings: { default_model: { model_preset: "codex-preset", reasoning_effort: "low" } },
    })).resolves.toMatchObject({ modelChange: "next_execution_start" });
    expect(task.persistentGeneration?.pending).toMatchObject({ targetReasoningEffort: "low" });
  });

  it("keeps saved false toggles when a later partial save touches other keys", async () => {
    const task = makeRolloverTask();
    const { control, persistedEntries } = makeRolloverControl(task);

    await control.applySettings(task.agentSessionId, { settings: { show_jev_candidates: false } });
    await control.applySettings(task.agentSessionId, { settings: { show_turn_usage: false, animate_character: false } });
    await control.applySettings(task.agentSessionId, { settings: { show_character: false } });

    const saved = persistedEntries.filter((entry) => entry.type === "persistent_settings").at(-1)?.value;
    expect(saved).toMatchObject({
      show_jev_candidates: false,
      show_character: false,
      show_turn_usage: false,
      animate_character: false,
      show_generation_separator: true,
      default_model: { model_preset: "claude-preset", reasoning_effort: "medium" },
    });
  });

  it("only clears the marker when disabling and keeps settings", async () => {
    const task = makeRolloverTask();
    const { control, enqueueMetadataEffect } = makeRolloverControl(task);
    await control.applySettings(task.agentSessionId, { settings: { default_model: sonnet } });
    enqueueMetadataEffect.mockClear();

    await expect(control.applySettings(task.agentSessionId, { enabled: false })).resolves.toEqual({
      sessionId: task.agentSessionId,
      persistent: false,
      modelChange: "none",
    });
    expect(enqueueMetadataEffect).toHaveBeenCalledTimes(1);
    expect(enqueueMetadataEffect).toHaveBeenCalledWith(
      task.agentSessionId,
      expect.objectContaining({ type: "persistent_session", value: expect.objectContaining({ enabled: false }) }),
      { replaceExistingType: "persistent_session", waitForAck: true },
    );
    expect(task.metadata?.some((entry) => entry.type === "persistent_settings")).toBe(true);
  });
});
