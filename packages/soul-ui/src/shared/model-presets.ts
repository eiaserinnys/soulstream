import type { ModelPresetAvailability } from "./api-types";

export async function fetchNodeModelPresets(
  nodeId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<ModelPresetAvailability[]> {
  const response = await fetchImplementation(
    `/api/nodes/${encodeURIComponent(nodeId)}/model-presets`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );
  if (!response.ok) {
    throw new Error(`모델 목록을 불러오지 못했습니다 (${response.status})`);
  }
  const payload = await response.json() as {
    model_presets?: ModelPresetAvailability[];
  };
  return payload.model_presets ?? [];
}
