import {
  fetchNodeModelPresets,
  type ModelPresetAvailability,
} from "@seosoyoung/soul-ui";

export { fetchNodeModelPresets };

const UNAVAILABLE_SELECTION_MESSAGE =
  "선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.";

export function modelPresetOptionLabel(
  preset: ModelPresetAvailability,
  formatResetTime: (value: string) => string | null = localResetTime,
  includeUsageWarning = true,
): string {
  if (preset.available) {
    return `${preset.label}${
      preset.usage_warning && includeUsageWarning ? " (사용량 확인 지연)" : ""
    }`;
  }
  const reason = preset.reason_label ? ` (${preset.reason_label})` : "";
  const resetTime = preset.resets_at ? formatResetTime(preset.resets_at) : null;
  return `${preset.label}${reason}${resetTime ? ` · ${resetTime} 해제` : ""}`;
}

export function modelPresetSelectionState(
  selectedId: string,
  presets: readonly ModelPresetAvailability[],
  loaded: boolean,
): {
  preset: ModelPresetAvailability | null;
  valid: boolean;
  warning: string | null;
} {
  if (!selectedId) return { preset: null, valid: true, warning: null };
  if (!loaded) return { preset: null, valid: true, warning: null };
  const preset = presets.find((candidate) => candidate.id === selectedId) ?? null;
  if (!preset) {
    return { preset: null, valid: false, warning: UNAVAILABLE_SELECTION_MESSAGE };
  }
  if (!preset.available) {
    return { preset, valid: false, warning: UNAVAILABLE_SELECTION_MESSAGE };
  }
  return { preset, valid: true, warning: null };
}

function localResetTime(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
