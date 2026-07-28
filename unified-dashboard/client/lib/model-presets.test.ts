import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchNodeModelPresets,
  modelPresetOptionLabel,
  modelPresetSelectionState,
} from "./model-presets";

const availablePreset = {
  id: "preset-available",
  label: "프리셋 A",
  backend: "backend-a",
  available: true,
  reason: null,
  reason_label: null,
  resets_at: null,
  usage_warning: false,
};

describe("model preset presentation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders only server labels plus a locally formatted reset time", () => {
    expect(modelPresetOptionLabel({
      ...availablePreset,
      id: "preset-limited",
      label: "프리셋 B",
      available: false,
      reason: "quota_exhausted",
      reason_label: "주간 사용량 제한",
      resets_at: "2026-07-28T03:20:00.000Z",
    }, () => "12:20")).toBe("프리셋 B (주간 사용량 제한) · 12:20 해제");
  });

  it("keeps a usage-warning preset selectable", () => {
    const warningPreset = {
      ...availablePreset,
      id: "preset-warning",
      usage_warning: true,
    };
    expect(modelPresetOptionLabel(warningPreset))
      .toBe("프리셋 A (사용량 확인 지연)");
    expect(modelPresetSelectionState("preset-warning", [warningPreset], true)).toEqual({
      preset: expect.objectContaining({ id: "preset-warning", usage_warning: true }),
      valid: true,
      warning: null,
    });
  });

  it("does not replace missing or unavailable inherited values", () => {
    expect(modelPresetSelectionState("preset-missing", [availablePreset], true)).toEqual({
      preset: null,
      valid: false,
      warning: "선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.",
    });
    expect(modelPresetSelectionState("preset-limited", [{
      ...availablePreset,
      id: "preset-limited",
      available: false,
    }], true)).toEqual({
      preset: expect.objectContaining({ id: "preset-limited" }),
      valid: false,
      warning: "선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.",
    });
  });

  it("does not block submission before availability is resolved", () => {
    expect(modelPresetSelectionState("preset-inherited", [], false)).toEqual({
      preset: null,
      valid: true,
      warning: null,
    });
  });

  it("loads the wrapped node preset response", async () => {
    const fetchImplementation = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ model_presets: [availablePreset] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(fetchNodeModelPresets("node/a", fetchImplementation))
      .resolves.toEqual([availablePreset]);
    expect(fetchImplementation).toHaveBeenCalledWith("/api/nodes/node%2Fa/model-presets", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  });
});
