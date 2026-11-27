import { isRecord } from "@soulstream/wire-schema/json-record";

export interface ModelPresetProjection {
  presetIds?: string[];
  detail: boolean;
}

const COMPACT_FIELDS = [
  "id", "label", "backend", "available", "reason", "reason_label",
  "resets_at", "usage_warning", "supported_efforts", "default_effort",
] as const;

function compactPreset(preset: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const field of COMPACT_FIELDS) {
    if (Object.hasOwn(preset, field)) compact[field] = preset[field];
  }
  if (Object.hasOwn(preset, "weekly_headroom")) {
    const headroom = preset.weekly_headroom;
    if (isRecord(headroom)) {
      const { observed_at: _observedAt, ...rest } = headroom;
      compact.weekly_headroom = rest;
    } else {
      compact.weekly_headroom = headroom;
    }
  }
  if (isRecord(preset.account_pool)) {
    const { available_count, total_count } = preset.account_pool;
    compact.account_pool = { available_count, total_count };
  }
  return compact;
}

export function projectModelPresets(body: unknown, { presetIds, detail }: ModelPresetProjection): unknown {
  if (!isRecord(body) || !Array.isArray(body.model_presets)) return body;
  const idOf = (preset: unknown) => isRecord(preset) && typeof preset.id === "string" ? preset.id : undefined;
  const wanted = presetIds === undefined ? undefined : new Set(presetIds);
  const selected = wanted === undefined
    ? body.model_presets
    : body.model_presets.filter((preset) => wanted.has(idOf(preset) ?? ""));
  const found = new Set(selected.map(idOf));
  const unknownPresetIds = (presetIds ?? []).filter((id) => !found.has(id));
  return {
    ...body,
    model_presets: detail ? selected : selected.map((preset) => isRecord(preset) ? compactPreset(preset) : preset),
    ...(unknownPresetIds.length > 0 ? { unknown_preset_ids: unknownPresetIds } : {}),
  };
}
