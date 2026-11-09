import type { AgentProfile } from "../agent_registry.js";
import {
  UnknownModelPresetError,
  type ModelCatalog,
  type ModelPreset,
} from "../model_catalog.js";

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

export interface EffectiveTurnPresetInput {
  /** 이번 턴 요청이 지정한 모델·프리셋. */
  request?: ModelSelection | null;
  /** 세션에 저장된 모델·프리셋. */
  stored?: ModelSelection | null;
}

/**
 * 이번 턴이 실제로 실행될 프리셋을 기존 실행 경로와 같은 순서로 고른다.
 *
 * 요청 프리셋 → 요청 raw 모델(프리셋 없음) → 저장 프리셋 → 저장 raw 모델
 * (프리셋 없음) → 에이전트 프로필 기본 프리셋 → 없음.
 *
 * `sessions.model_preset`이 null이라는 사실만으로 미선택이라고 단정하지 않는다.
 * 저장 프리셋이 카탈로그에서 사라졌으면 `preset_unavailable`과 같이 미선택으로
 * 본다. 명시 요청의 미지 프리셋은 기존 경로처럼 오류로 남긴다.
 */
export function resolveEffectiveTurnPreset(
  input: EffectiveTurnPresetInput,
  agent: Pick<AgentProfile, "default_preset">,
  modelCatalog?: ModelPresetResolver,
): ModelPreset | undefined {
  const requestPresetId = normalizeOptionalString(input.request?.modelPreset);
  if (requestPresetId) return resolveRequiredPreset(requestPresetId, modelCatalog);
  if (normalizeOptionalString(input.request?.model)) return undefined;

  const storedPresetId = normalizeOptionalString(input.stored?.modelPreset);
  if (storedPresetId) {
    try {
      return resolveRequiredPreset(storedPresetId, modelCatalog);
    } catch (error) {
      if (error instanceof UnknownModelPresetError) return undefined;
      throw error;
    }
  }
  if (normalizeOptionalString(input.stored?.model)) return undefined;

  const defaultPresetId = normalizeOptionalString(agent.default_preset);
  if (!defaultPresetId) return undefined;
  return resolveRequiredPreset(defaultPresetId, modelCatalog);
}

function resolveRequiredPreset(
  presetId: string,
  modelCatalog?: ModelPresetResolver,
): ModelPreset {
  if (!modelCatalog) {
    throw new Error(`Model catalog is not configured; cannot resolve preset: ${presetId}`);
  }
  return modelCatalog.resolve(presetId);
}

export function resolveOpenCodeMcpToolAllowlist(
  task: Pick<Task, "model" | "modelPreset" | "modelPresetBackend">,
  agent: AgentProfile,
  modelCatalog?: ModelPresetResolver,
): Record<string, string[]> | undefined {
  if (effectiveTaskBackend(task, agent) !== "opencode") return undefined;
  const preset = resolveModelPresetSelection(task, agent, modelCatalog);
  return preset?.mcp_tool_allowlist?.[agent.id];
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
): "applied" | "not_selected" | "preset_unavailable" {
  if (task.modelPresetBackend) return "applied";
  let preset: ModelPreset | undefined;
  try {
    preset = resolveModelPresetSelection(task, agent, modelCatalog);
  } catch (error) {
    if (error instanceof UnknownModelPresetError && task.modelPreset) {
      return "preset_unavailable";
    }
    throw error;
  }
  if (!preset) return "not_selected";

  task.modelPreset = preset.id;
  task.model ??= preset.model;
  task.modelPresetBackend = preset.backend;
  task.modelPresetEnv = preset.env;
  return "applied";
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
