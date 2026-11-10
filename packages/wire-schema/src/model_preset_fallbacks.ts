/**
 * 세션 생성 시 선언한 모델 preset 대체 순서(metadata `model_preset_fallbacks`).
 *
 * 값은 만들 때의 1차 preset과 대체 목록을 그대로 보존한다. 실행 중 한도 전환은
 * 이 순서를 읽어 남은 후보를 계산한다. 생성 시점 선택은 이 순서의 앞에서부터
 * 사용 가능한 preset을 고른다.
 */

export const MODEL_PRESET_FALLBACKS_METADATA_TYPE = "model_preset_fallbacks";

export interface ModelPresetFallbackPolicy {
  /** 요청한 1차 model preset(가용성 선택 전 값). */
  initialModelPreset: string;
  /** 1차 preset 뒤에 차례로 쓸 대체 preset id 목록. */
  modelPresetFallbacks: string[];
}

/** metadata에서 마지막 `model_preset_fallbacks` 항목을 읽는다. 없거나 깨졌으면 null. */
export function readModelPresetFallbackPolicy(
  metadata: unknown,
): ModelPresetFallbackPolicy | null {
  if (!Array.isArray(metadata)) return null;
  for (let index = metadata.length - 1; index >= 0; index--) {
    const entry = metadata[index];
    if (!isRecord(entry) || entry.type !== MODEL_PRESET_FALLBACKS_METADATA_TYPE) continue;
    const value = entry.value;
    if (!isRecord(value)) return null;
    const initialModelPreset = nonBlankString(value.initial_model_preset);
    const fallbackValue = value.model_preset_fallbacks;
    if (initialModelPreset === undefined || !Array.isArray(fallbackValue)) return null;
    const modelPresetFallbacks: string[] = [];
    for (const item of fallbackValue) {
      const presetId = nonBlankString(item);
      if (presetId === undefined) return null;
      modelPresetFallbacks.push(presetId);
    }
    return { initialModelPreset, modelPresetFallbacks };
  }
  return null;
}

/** 1차 preset과 대체 목록을 순서 보존으로 중복 제거한 후보 순서. */
export function modelPresetFallbackOrder(policy: ModelPresetFallbackPolicy): string[] {
  return dedupe([policy.initialModelPreset, ...policy.modelPresetFallbacks]);
}

/** 현재 preset 뒤에 남은 대체 후보. 현재 preset이 순서에 없으면 빈 배열. */
export function remainingModelPresetFallbacks(
  policy: ModelPresetFallbackPolicy,
  currentPreset: string | null | undefined,
): string[] {
  if (typeof currentPreset !== "string") return [];
  const order = modelPresetFallbackOrder(policy);
  const index = order.indexOf(currentPreset);
  return index === -1 ? [] : order.slice(index + 1);
}

/** 세션 metadata에 저장할 `model_preset_fallbacks` 항목. */
export function buildModelPresetFallbackMetadataEntry(
  initialModelPreset: string,
  modelPresetFallbacks: readonly string[],
): Record<string, unknown> {
  return {
    type: MODEL_PRESET_FALLBACKS_METADATA_TYPE,
    value: {
      initial_model_preset: initialModelPreset,
      model_preset_fallbacks: dedupe(modelPresetFallbacks),
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
