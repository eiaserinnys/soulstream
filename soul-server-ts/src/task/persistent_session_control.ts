import {
  PERSISTENT_SETTINGS_DEFAULTS,
  buildPersistentSettingsMetadataEntry,
  readStoredPersistentSettings,
  type PersistentModelSelection,
  type PersistentSessionSettings,
  type PersistentSettingsPatch,
  type StoredPersistentSettings,
} from "@soulstream/wire-schema/persistent-session-settings";

import type { EventPersistence } from "../db/event_persistence.js";
import { UnknownModelPresetError, type ModelCatalog } from "../model_catalog.js";
import { isReasoningEffort, type ReasoningEffort } from "../engine/protocol.js";
import type { Task } from "./task_models.js";
import {
  buildPersistentGenerationMetadataEntry,
  buildPersistentSessionMetadataEntry,
} from "./task_metadata.js";
import {
  UnsupportedReasoningEffortError,
  resolveReasoningEffortForCreate,
} from "./task_reasoning_effort.js";

export interface PersistentSessionControlDeps {
  getTask(sessionId: string): Task | undefined;
  loadEvictedTask(sessionId: string): Promise<Task | null>;
  rememberTask(task: Task): void;
  persistence?: EventPersistence;
  modelCatalog?: Pick<ModelCatalog, "resolve">;
  resolveCurrentBackend?(task: Task): string | undefined;
}

export interface SetSessionPersistentResult {
  sessionId: string;
  persistent: boolean;
  generation: number;
}

export interface RequestGenerationRolloverResult {
  sessionId: string;
  generation: number;
  pendingGeneration: number;
  sessionStatus: Task["status"];
  applies: "next_execution_start";
}

export interface ApplyPersistentSettingsInput {
  enabled?: boolean;
  settings?: PersistentSettingsPatch;
}

export interface ApplyPersistentSettingsResult {
  sessionId: string;
  persistent: boolean;
  modelChange: "none" | "next_execution_start";
}

/** Input-class failure carrying the wire code orch maps to a 4xx. */
export class PersistentSessionControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PersistentSessionControlError";
  }
}

export class PersistentSessionControl {
  constructor(private readonly deps: PersistentSessionControlDeps) {}

  /**
   * One PUT-sized step of the PAS settings flow: `enabled=false` only clears the
   * persistent marker; otherwise the merged `persistent_settings` entry is saved
   * (acknowledged), the marker is set when registering, and a generation rollover
   * is requested when the default model differs from the running one and no
   * rollover to that target is pending. Later saves win; nothing is serialized.
   */
  async applySettings(
    sessionId: string,
    input: ApplyPersistentSettingsInput,
  ): Promise<ApplyPersistentSettingsResult> {
    let task = this.deps.getTask(sessionId);
    if (!task) {
      task = await this.deps.loadEvictedTask(sessionId) ?? undefined;
      if (!task) throw new PersistentSessionControlError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      this.deps.rememberTask(task);
    }
    if (task.sessionType === "llm") {
      throw new PersistentSessionControlError("INVALID_REQUEST", `LLM sessions cannot be persistent: ${sessionId}`);
    }

    if (input.enabled === false) {
      await this.setSessionPersistent(sessionId, false);
      return { sessionId, persistent: false, modelChange: "none" };
    }
    if (input.enabled === undefined && !task.persistent) {
      throw new PersistentSessionControlError("NOT_PERSISTENT", `Session is not persistent: ${sessionId}`);
    }
    if (!this.deps.persistence) {
      throw new Error("Persistent session metadata persistence unavailable");
    }

    const merged = this.mergeSettings(task, input);
    const entry = buildPersistentSettingsMetadataEntry(merged);
    await this.deps.persistence.enqueueMetadataEffect(sessionId, entry, {
      replaceExistingType: "persistent_settings",
      waitForAck: true,
    });
    task.metadata = [
      ...(task.metadata ?? []).filter((item) => item.type !== "persistent_settings"),
      entry,
    ];
    if (input.enabled === true) await this.setSessionPersistent(sessionId, true);

    const target = merged.default_model;
    const current = currentModelOf(task);
    const pending = task.persistentGeneration?.pending;
    const alreadyRunning = current !== null
      && current.model_preset === target.model_preset
      && current.reasoning_effort === target.reasoning_effort;
    const alreadyPending = pending !== undefined
      && pending.targetModelPreset === target.model_preset
      && (pending.targetReasoningEffort ?? null) === target.reasoning_effort;
    if (alreadyRunning || alreadyPending) {
      return { sessionId, persistent: true, modelChange: "none" };
    }
    await this.requestGenerationRollover(sessionId, {
      modelPreset: target.model_preset,
      ...(target.reasoning_effort === null
        ? {}
        : { reasoningEffort: target.reasoning_effort as ReasoningEffort }),
      reason: "settings",
    });
    return { sessionId, persistent: true, modelChange: "next_execution_start" };
  }

  private mergeSettings(task: Task, input: ApplyPersistentSettingsInput): PersistentSessionSettings {
    const patch = input.settings ?? {};
    const stored = readStoredPersistentSettings(task.metadata);
    const base: StoredPersistentSettings = stored ?? {
      default_model: currentModelOf(task),
      fallback_model: input.enabled === true ? { ...PERSISTENT_SETTINGS_DEFAULTS.fallback_model } : null,
      show_generation_separator: PERSISTENT_SETTINGS_DEFAULTS.show_generation_separator,
      show_character: PERSISTENT_SETTINGS_DEFAULTS.show_character,
      show_jev_candidates: PERSISTENT_SETTINGS_DEFAULTS.show_jev_candidates,
      show_turn_usage: PERSISTENT_SETTINGS_DEFAULTS.show_turn_usage,
      animate_character: PERSISTENT_SETTINGS_DEFAULTS.animate_character,
    };
    const defaultModel = patch.default_model !== undefined
      ? this.normalizeDefaultModel(patch.default_model)
      : base.default_model;
    if (defaultModel === null) {
      throw new PersistentSessionControlError("INVALID_REQUEST", "A default model is required to save persistent settings");
    }
    return {
      default_model: defaultModel,
      fallback_model: patch.fallback_model !== undefined ? patch.fallback_model : base.fallback_model,
      show_generation_separator: patch.show_generation_separator ?? base.show_generation_separator,
      show_character: patch.show_character ?? base.show_character,
      show_jev_candidates: patch.show_jev_candidates ?? base.show_jev_candidates,
      show_turn_usage: patch.show_turn_usage ?? base.show_turn_usage,
      animate_character: patch.animate_character ?? base.animate_character,
    };
  }

  private normalizeDefaultModel(selection: PersistentModelSelection): PersistentModelSelection {
    if (!this.deps.modelCatalog) {
      throw new Error(`Model catalog is not configured; cannot resolve preset: ${selection.model_preset}`);
    }
    let preset: ReturnType<ModelCatalog["resolve"]>;
    try {
      preset = this.deps.modelCatalog.resolve(selection.model_preset);
    } catch (error) {
      if (error instanceof UnknownModelPresetError) {
        throw new PersistentSessionControlError("INVALID_MODEL_PRESET", error.message);
      }
      throw error;
    }
    const requested = selection.reasoning_effort;
    if (requested !== null && !isReasoningEffort(requested)) {
      throw new UnsupportedReasoningEffortError(requested, preset.id, preset.supported_efforts);
    }
    return {
      model_preset: preset.id,
      reasoning_effort: resolveReasoningEffortForCreate(preset, requested ?? undefined) ?? null,
    };
  }

  async setSessionPersistent(
    sessionId: string,
    enabled: boolean,
  ): Promise<SetSessionPersistentResult> {
    let task = this.deps.getTask(sessionId);
    if (!task) {
      task = await this.deps.loadEvictedTask(sessionId) ?? undefined;
      if (!task) throw new Error(`Session not found: ${sessionId}`);
      this.deps.rememberTask(task);
    }

    if (task.sessionType === "llm") {
      throw new Error(`LLM sessions cannot be persistent: ${sessionId}`);
    }
    if (!this.deps.persistence) {
      throw new Error("Persistent session metadata persistence unavailable");
    }

    const entry = buildPersistentSessionMetadataEntry(enabled);
    await this.deps.persistence.enqueueMetadataEffect(sessionId, entry, {
      replaceExistingType: "persistent_session",
      waitForAck: true,
    });
    task.metadata = [
      ...(task.metadata ?? []).filter((item) => item.type !== "persistent_session"),
      entry,
    ];
    task.persistent = enabled;

    return { sessionId, persistent: enabled, generation: task.persistentGeneration?.number ?? 1 };
  }

  async requestGenerationRollover(
    sessionId: string,
    input: {
      modelPreset?: string;
      reasoningEffort?: ReasoningEffort;
      reason: string;
    },
  ): Promise<RequestGenerationRolloverResult> {
    let task = this.deps.getTask(sessionId);
    if (!task) {
      task = await this.deps.loadEvictedTask(sessionId) ?? undefined;
      if (!task) throw new Error(`Session not found: ${sessionId}`);
      this.deps.rememberTask(task);
    }

    if (!task.persistent) {
      throw new Error(`Session is not persistent: ${sessionId}`);
    }
    if (!this.deps.persistence) {
      throw new Error("Persistent session metadata persistence unavailable");
    }
    const currentBackend = this.deps.resolveCurrentBackend?.(task) ?? task.modelPresetBackend;
    if (currentBackend !== "claude" && currentBackend !== "codex") {
      throw new Error(`Persistent generation rollover does not support current backend: ${currentBackend ?? "unknown"}`);
    }

    const modelPresetId = input.modelPreset?.trim() || task.modelPreset?.trim();
    if (!modelPresetId) {
      throw new Error("A model preset is required to request persistent generation rollover");
    }
    if (!this.deps.modelCatalog) {
      throw new Error(`Model catalog is not configured; cannot resolve preset: ${modelPresetId}`);
    }
    const targetPreset = this.deps.modelCatalog.resolve(modelPresetId);
    if (targetPreset.backend !== "claude" && targetPreset.backend !== "codex") {
      throw new Error(`Persistent generation rollover does not support target backend: ${targetPreset.backend}`);
    }
    const reasoningEffort = resolveReasoningEffortForCreate(
      targetPreset,
      input.reasoningEffort,
    );

    const generation = task.persistentGeneration ?? { number: 1 };
    const pendingGeneration = generation.pending?.number ?? generation.number + 1;
    const nextGeneration = {
      ...generation,
      pending: {
        number: pendingGeneration,
        reason: input.reason,
        requestedAt: new Date().toISOString(),
        targetModelPreset: targetPreset.id,
        ...(reasoningEffort === undefined ? {} : { targetReasoningEffort: reasoningEffort }),
        ...(generation.pending?.applyingFrom === undefined
          ? {}
          : {
              applyingFrom: generation.pending.applyingFrom,
              ...(generation.pending.previousModelPreset === undefined
                ? {}
                : { previousModelPreset: generation.pending.previousModelPreset }),
              ...(generation.pending.previousBackend === undefined
                ? {}
                : { previousBackend: generation.pending.previousBackend }),
            }),
      },
    };
    const entry = buildPersistentGenerationMetadataEntry(nextGeneration);
    await this.deps.persistence.enqueueMetadataEffect(sessionId, entry, {
      replaceExistingType: "persistent_generation",
      waitForAck: true,
    });
    task.metadata = [
      ...(task.metadata ?? []).filter((item) => item.type !== "persistent_generation"),
      entry,
    ];
    task.persistentGeneration = nextGeneration;

    return {
      sessionId,
      generation: generation.number,
      pendingGeneration,
      sessionStatus: task.status,
      applies: "next_execution_start",
    };
  }
}

function currentModelOf(task: Task): PersistentModelSelection | null {
  const preset = task.modelPreset?.trim();
  return preset ? { model_preset: preset, reasoning_effort: task.reasoningEffort ?? null } : null;
}
