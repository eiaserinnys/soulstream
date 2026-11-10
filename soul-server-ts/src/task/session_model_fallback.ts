/**
 * 일반 세션이 한도(`limit_hit`)로 끝날 때 다음 모델 preset을 고른다.
 *
 * 세션 생성 시 metadata에 선언한 `model_preset_fallbacks` 순서에서 현재
 * preset 뒤의 남은 후보만 쓰고, 노드가 광고한 가용성으로 고른다. 고른 후보가
 * 실제로 available이 아니면 전환하지 않는다(선택 함수는 아무것도 없을 때
 * 첫 후보를 돌려주므로 호출측 재확인이 필요하다).
 */

import { chooseUsablePresetId } from "@soulstream/model-catalog";
import {
  readModelPresetFallbackPolicy,
  remainingModelPresetFallbacks,
} from "@soulstream/wire-schema/model-preset-fallbacks";
import type { Logger } from "pino";

import type { OrchProxyConfig } from "../mcp/runtime.js";
import {
  loadAdvertisedPresets,
  normalizeAdvertisedPresets,
} from "../mcp/tools/model_preset_preflight.js";
import type { ModelCatalog } from "../model_catalog.js";
import type { ReasoningEffort } from "../engine/protocol.js";
import { resolveReasoningEffortForCreate } from "./task_reasoning_effort.js";
import type { Task } from "./task_models.js";

/** 같은 세션의 다음 세대에 보낼 이어가기 문구. */
export const SESSION_MODEL_FALLBACK_RESUME_PROMPT =
  "사용 가능한 대체 모델로 이전 지시와 미완료 작업을 이어서 진행해주세요. 이미 만든 카드와 저장 결과를 먼저 확인하고 미완료 부분만 진행하세요.";

export interface SessionModelFallbackTarget {
  modelPreset: string;
  reasoningEffort?: ReasoningEffort;
}

export interface SessionModelFallbackLookup {
  /** 현재 워커 노드 id(가용성 조회 대상). */
  nodeId: string;
  orch: OrchProxyConfig | undefined;
  modelCatalog: Pick<ModelCatalog, "resolve">;
  logger?: Pick<Logger, "warn">;
}

/**
 * 전환할 다음 모델을 고른다. 전환 조건(일반 세션, 한도, 정책, 남은 후보,
 * 가용성)을 하나라도 못 채우면 null.
 */
export async function chooseSessionModelFallbackTarget(
  task: Task,
  lookup: SessionModelFallbackLookup,
): Promise<SessionModelFallbackTarget | null> {
  if (task.persistent === true) return null;
  // pending 저장은 finalize(terminationReason 확정)보다 먼저 일어난다. 그 시점에
  // 한도 판정의 정본은 event publisher가 기록한 pendingTerminationHint다.
  if (task.terminationReason !== "limit_hit"
    && task.pendingTerminationHint !== "limit_hit") return null;
  const policy = readModelPresetFallbackPolicy(task.metadata);
  if (policy === null) return null;
  const remaining = remainingModelPresetFallbacks(policy, task.modelPreset?.trim());
  if (remaining.length === 0) return null;

  const presets = await loadAdvertisedPresets({
    nodeId: lookup.nodeId,
    orch: lookup.orch,
  });
  if (presets === null) return null;
  const advertised = normalizeAdvertisedPresets(presets);
  const chosenPresetId = chooseUsablePresetId(remaining, advertised);
  const chosen = advertised.find((preset) => preset.id === chosenPresetId);
  if (chosen === undefined || chosen.available !== true) return null;

  try {
    const targetPreset = lookup.modelCatalog.resolve(chosenPresetId);
    const reasoningEffort = resolveReasoningEffortForCreate(targetPreset, undefined);
    return {
      modelPreset: targetPreset.id,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    };
  } catch (err) {
    lookup.logger?.warn(
      { err, presetId: chosenPresetId },
      "session model fallback target preset is not resolvable",
    );
    return null;
  }
}
