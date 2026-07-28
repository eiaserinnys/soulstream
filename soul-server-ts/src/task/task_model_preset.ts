import type { AgentProfile } from "../agent_registry.js";
import type { ModelCatalog, ModelPreset } from "../model_catalog.js";

import type { CreateTaskParams } from "./task_creation.js";
import type { Task } from "./task_models.js";

export type ModelPresetResolver = Pick<ModelCatalog, "resolve">;

type ModelSelection = Pick<CreateTaskParams, "model" | "modelPreset">;

export function resolveModelPresetSelection(
  selection: ModelSelection,
  agent: AgentProfile,
  modelCatalog?: ModelPresetResolver,
): ModelPreset | undefined {
  const explicitPresetId = normalizeOptionalString(selection.modelPreset);
  const presetId = explicitPresetId
    ?? (normalizeOptionalString(selection.model) ? undefined : agent.default_preset);
  if (!presetId) return undefined;
  if (!modelCatalog) {
    throw new Error(`Model catalog is not configured; cannot resolve preset: ${presetId}`);
  }
  return modelCatalog.resolve(presetId);
}

/**
 * Rebuilds non-persisted preset runtime state for hydrated sessions.
 *
 * The resolved model stored with the session is authoritative across catalog
 * changes. Backend and env are deliberately reloaded from the node-local
 * catalog because they are runtime-only and secrets must never enter the DB.
 */
export function applyModelPresetRuntime(
  task: Task,
  agent: AgentProfile,
  modelCatalog?: ModelPresetResolver,
): void {
  if (task.modelPresetBackend) return;
  const preset = resolveModelPresetSelection(task, agent, modelCatalog);
  if (!preset) return;

  task.modelPreset = preset.id;
  task.model ??= preset.model;
  task.modelPresetBackend = preset.backend;
  task.modelPresetEnv = preset.env;
}

export function effectiveTaskBackend(
  task: Pick<Task, "modelPresetBackend">,
  agent: AgentProfile,
): AgentProfile["backend"] {
  return task.modelPresetBackend ?? agent.backend;
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
