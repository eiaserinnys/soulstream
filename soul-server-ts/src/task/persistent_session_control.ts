import type { EventPersistence } from "../db/event_persistence.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ReasoningEffort } from "../engine/protocol.js";
import type { Task } from "./task_models.js";
import {
  buildPersistentGenerationMetadataEntry,
  buildPersistentSessionMetadataEntry,
} from "./task_metadata.js";
import { resolveReasoningEffortForCreate } from "./task_reasoning_effort.js";

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

export class PersistentSessionControl {
  constructor(private readonly deps: PersistentSessionControlDeps) {}

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

    return { sessionId, persistent: enabled, generation: 1 };
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
          : { applyingFrom: generation.pending.applyingFrom }),
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
