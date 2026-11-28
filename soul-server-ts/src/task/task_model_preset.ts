import type { AgentProfile } from "@soulstream/agent-profile-contract";
import type {
  ModelCatalog,
} from "../model_catalog.js";
import { UnknownModelPresetError, type ModelPreset } from "@soulstream/model-catalog";

import type { CreateTaskParams } from "./task_creation.js";
import type { Task } from "./task_models.js";

export type ModelPresetResolver = Pick<ModelCatalog, "resolve">;

export class UntrustedExecutionPresetError extends Error {
  constructor(agentId: string, untrustedIds: string[], trustedIds: string[]) {
    super(`${agentId} 프로필은 상자 밖 프리셋으로만 띄울 수 있습니다. 상자 안 프리셋: ${untrustedIds.join(", ")}. 상자 밖 프리셋: ${trustedIds.join(", ")}`);
    this.name = "UntrustedExecutionPresetError";
  }
}

export function assertTrustedExecutionPresets({
  agent,
  presetId,
  fallbackPresetIds,
  platform,
  modelCatalog,
}: {
  agent?: Pick<AgentProfile, "id" | "requires_trusted_execution">;
  presetId: string | null;
  fallbackPresetIds: readonly string[];
  platform: NodeJS.Platform;
  modelCatalog?: Pick<ModelCatalog, "resolve" | "snapshot">;
}): void {
  if (agent?.requires_trusted_execution !== true || platform === "win32") return;

  const untrustedIds = [presetId, ...fallbackPresetIds].filter((id) => {
    if (!id || !modelCatalog) return true;
    try {
      return modelCatalog.resolve(id).trusted_execution !== true;
    } catch (error) {
      if (error instanceof UnknownModelPresetError) return true;
      throw error;
    }
  }).map((id) => id ?? "프리셋 없음");
  if (untrustedIds.length === 0) return;

  const trustedIds = modelCatalog?.snapshot().presets
    .filter((preset) => preset.trusted_execution === true)
    .map((preset) => preset.id) ?? [];
  throw new UntrustedExecutionPresetError(agent.id, untrustedIds, trustedIds);
}

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
  task: Pick<Task, "model" | "modelPreset" | "modelPresetBackend" | "recordedModelBackend">,
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
 * changes. The runtime backend and env are reloaded from the node-local catalog;
 * only the backend is also recorded, never the env.
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
  task: Pick<Task, "modelPresetBackend" | "recordedModelBackend">,
  agent: AgentProfile,
): AgentProfile["backend"] {
  return (task.modelPresetBackend ?? task.recordedModelBackend ?? agent.backend) as AgentProfile["backend"];
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
