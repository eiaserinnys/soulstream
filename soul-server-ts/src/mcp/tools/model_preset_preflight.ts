import { chooseUsablePresetId } from "@soulstream/model-catalog";

import type { McpRuntime, OrchProxyConfig } from "../runtime.js";
import { fetchOrchResponse } from "../../control_plane/persistence_host_transport.js";

const MODEL_PRESET_PREFLIGHT_TIMEOUT_MS = 2_000;

type ModelPresetLookup = {
  nodeId: string;
  orch: OrchProxyConfig | undefined;
};

type ModelPresetPreflightInput = ModelPresetLookup & {
  logger: McpRuntime["logger"];
  selectedPresetId: string | undefined;
};

type ModelPresetFallbackPreflightInput = ModelPresetLookup & {
  logger: McpRuntime["logger"];
  initialPresetId: string | undefined;
  fallbackPresetIds: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 선택 계산에 필요한 advertised preset의 정규화 형태. */
export interface AdvertisedModelPreset {
  id: string;
  available: boolean;
  weekly_headroom: { remaining_percent: number | null } | null;
}

/** advertised preset 응답에서 id, available, 주간 여유가 온전한 항목만 남긴다. */
export function normalizeAdvertisedPresets(
  presets: readonly unknown[],
): AdvertisedModelPreset[] {
  return presets.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== "string") return [];
    if (typeof entry.available !== "boolean") return [];
    const headroom = entry.weekly_headroom;
    return [{
      id: entry.id,
      available: entry.available,
      weekly_headroom: isRecord(headroom)
        && (headroom.remaining_percent === null
          || typeof headroom.remaining_percent === "number")
        ? { remaining_percent: headroom.remaining_percent }
        : null,
    }];
  });
}

/** orch의 노드 preset 목록을 읽는다. 조회 실패는 null. */
export async function loadAdvertisedPresets({
  nodeId,
  orch,
}: ModelPresetLookup): Promise<unknown[] | null> {
  if (!orch) return null;
  try {
    const response = await fetchOrchResponse(
      orch,
      "GET",
      `/api/nodes/${encodeURIComponent(nodeId)}/model-presets`,
      undefined,
      { timeoutMs: MODEL_PRESET_PREFLIGHT_TIMEOUT_MS },
    );
    if (!response.ok) return null;
    const body: unknown = await response.json();
    return isRecord(body) && Array.isArray(body.model_presets)
      ? body.model_presets
      : null;
  } catch {
    return null;
  }
}

function isWellFormedPresetEntry(preset: Record<string, unknown>): boolean {
  return typeof preset.available === "boolean"
    && (preset.reason === null || typeof preset.reason === "string")
    && (
      preset.reason_label === undefined
      || preset.reason_label === null
      || typeof preset.reason_label === "string"
    )
    && (
      preset.resets_at === undefined
      || preset.resets_at === null
      || typeof preset.resets_at === "string"
    );
}

/** limit_rejected 항목이면 생성 전 차단 메시지를 돌려준다. */
function limitRejectionMessage(
  nodeId: string,
  presetId: string,
  preset: Record<string, unknown>,
): string | null {
  if (preset.available || preset.reason !== "limit_rejected") return null;
  const reasonLabel =
    typeof preset.reason_label === "string" && preset.reason_label.trim() !== ""
      ? preset.reason_label
      : "한도 거부 중";
  const resetLabel =
    typeof preset.resets_at === "string" && preset.resets_at !== ""
      ? ` (resets_at: ${preset.resets_at})`
      : "";
  return `Model preset '${presetId}' is unavailable on node ${nodeId}: ${reasonLabel}${resetLabel}`;
}

export async function preflightModelPreset({
  nodeId,
  orch,
  logger,
  selectedPresetId,
}: ModelPresetPreflightInput): Promise<string | null> {
  if (selectedPresetId === undefined) return null;

  const warnAndContinue = (): null => {
    logger.warn(
      { nodeId, presetId: selectedPresetId },
      "Model preset preflight failed; allowing session creation",
    );
    return null;
  };

  const presets = await loadAdvertisedPresets({ nodeId, orch });
  if (presets === null) return warnAndContinue();

  const preset = presets.find(
    (candidate) => isRecord(candidate) && candidate.id === selectedPresetId,
  );
  if (!isRecord(preset) || !isWellFormedPresetEntry(preset)) return warnAndContinue();

  return limitRejectionMessage(nodeId, selectedPresetId, preset);
}

/**
 * 선언한 대체 순서에서 지금 쓸 수 있는 preset을 골라 돌려준다. 목록을 읽지
 * 못하면 primary preset으로 fail-open하고, 고른 preset이 limit_rejected면
 * 기존 사전 확인과 같은 형식의 오류를 돌려준다.
 */
export async function preflightModelPresetFallbacks({
  nodeId,
  orch,
  logger,
  initialPresetId,
  fallbackPresetIds,
}: ModelPresetFallbackPreflightInput): Promise<{
  chosenPresetId: string | undefined;
  error: string | null;
}> {
  if (initialPresetId === undefined || fallbackPresetIds.length === 0) {
    return { chosenPresetId: initialPresetId, error: null };
  }

  const warnAndUseInitial = () => {
    logger.warn(
      { nodeId, presetId: initialPresetId },
      "Model preset preflight failed; allowing session creation",
    );
    return { chosenPresetId: initialPresetId, error: null };
  };

  const presets = await loadAdvertisedPresets({ nodeId, orch });
  if (presets === null) return warnAndUseInitial();

  const advertised = normalizeAdvertisedPresets(presets);
  const chosenPresetId = chooseUsablePresetId(
    [initialPresetId, ...fallbackPresetIds],
    advertised,
  );

  const chosen = presets.find(
    (candidate) => isRecord(candidate) && candidate.id === chosenPresetId,
  );
  if (!isRecord(chosen) || !isWellFormedPresetEntry(chosen)) {
    return warnAndUseInitial();
  }
  return {
    chosenPresetId,
    error: limitRejectionMessage(nodeId, chosenPresetId, chosen),
  };
}
