import type { McpRuntime, OrchProxyConfig } from "../runtime.js";
import { fetchOrchResponse } from "../../control_plane/persistence_host_transport.js";

const MODEL_PRESET_PREFLIGHT_TIMEOUT_MS = 2_000;

type ModelPresetPreflightInput = {
  nodeId: string;
  orch: OrchProxyConfig | undefined;
  logger: McpRuntime["logger"];
  selectedPresetId: string | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (!orch) return warnAndContinue();

  let responseBody: unknown;
  try {
    const response = await fetchOrchResponse(
      orch,
      "GET",
      `/api/nodes/${encodeURIComponent(nodeId)}/model-presets`,
      undefined,
      { timeoutMs: MODEL_PRESET_PREFLIGHT_TIMEOUT_MS },
    );
    if (!response.ok) return warnAndContinue();
    responseBody = await response.json();
  } catch {
    return warnAndContinue();
  }

  if (!isRecord(responseBody) || !Array.isArray(responseBody.model_presets)) {
    return warnAndContinue();
  }

  const preset = responseBody.model_presets.find(
    (candidate) => isRecord(candidate) && candidate.id === selectedPresetId,
  );
  if (!isRecord(preset)) return warnAndContinue();

  if (
    typeof preset.available !== "boolean" ||
    !(preset.reason === null || typeof preset.reason === "string") ||
    !(
      preset.reason_label === undefined ||
      preset.reason_label === null ||
      typeof preset.reason_label === "string"
    ) ||
    !(
      preset.resets_at === undefined ||
      preset.resets_at === null ||
      typeof preset.resets_at === "string"
    )
  ) {
    return warnAndContinue();
  }

  if (preset.available || preset.reason !== "limit_rejected") return null;

  const reasonLabel =
    typeof preset.reason_label === "string" && preset.reason_label.trim() !== ""
      ? preset.reason_label
      : "한도 거부 중";
  const resetLabel =
    typeof preset.resets_at === "string" && preset.resets_at !== ""
      ? ` (resets_at: ${preset.resets_at})`
      : "";

  return `Model preset '${selectedPresetId}' is unavailable on node ${nodeId}: ${reasonLabel}${resetLabel}`;
}
