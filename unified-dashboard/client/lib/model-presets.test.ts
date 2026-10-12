import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchNodeModelPresets,
  modelPresetUnavailableReason,
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
  it("keeps an exhausted model selectable and renders its name alone", () => {
    const exhausted = { ...availablePreset, reason: "quota_exhausted",
      reason_label: "주간 사용량 제한", resets_at: "2030-01-02T03:04:00.000Z" };
    expect(modelPresetOptionLabel(exhausted)).toBe(exhausted.label);
    expect(modelPresetSelectionState(exhausted.id, [exhausted], true).valid).toBe(true);
  });

  it("shows and blocks an actually rejected model while keeping a 0% model selectable", () => {
    const rejected = {
      ...availablePreset,
      id: "preset-rejected",
      available: false,
      reason: "limit_rejected",
      reason_label: "5시간 한도 거부 중",
      resets_at: "2030-01-02T03:04:00.000Z",
    };
    const exhausted = {
      ...availablePreset,
      id: "preset-exhausted",
      reason: "quota_exhausted",
      reason_label: "7일 사용량 제한",
      resets_at: "2030-01-02T03:04:00.000Z",
    };

    expect(modelPresetOptionLabel(rejected, () => "12:20"))
      .toBe("프리셋 A (5시간 한도 거부 중) · 12:20 해제");
    expect(modelPresetSelectionState(rejected.id, [rejected], true).valid).toBe(false);
    expect(modelPresetOptionLabel(exhausted)).toBe(exhausted.label);
    expect(modelPresetSelectionState(exhausted.id, [exhausted], true).valid).toBe(true);
  });

  it("formats the unavailable reason for a picker row without repeating the model name", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 12, 8, 0));
    const rejected = {
      ...availablePreset,
      available: false,
      reason: "limit_rejected",
      reason_label: "7일 한도 거부 중",
      resets_at: new Date(2026, 9, 15, 13, 19).toISOString(),
    };

    expect(modelPresetUnavailableReason(rejected)).toBe("7일 한도 거부 중 · 10/15 13:19 해제");
    expect(modelPresetUnavailableReason({ ...rejected, resets_at: null }))
      .toBe("7일 한도 거부 중");
    expect(modelPresetUnavailableReason(availablePreset)).toBeNull();
    expect(modelPresetUnavailableReason({ ...rejected, reason_label: null })).toBeNull();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("formats reset dates in local time only when the reset day differs from today", () => {
    const now = new Date(2026, 9, 12, 8, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const resetLabel = (date: Date) => modelPresetOptionLabel({
      ...availablePreset,
      available: false,
      reason: "limit_rejected",
      reason_label: "7일 한도 거부 중",
      resets_at: date.toISOString(),
    });

    expect(resetLabel(new Date(2026, 9, 12, 13, 19)))
      .toBe("프리셋 A (7일 한도 거부 중) · 13:19 해제");
    expect(resetLabel(new Date(2026, 9, 13, 1, 30)))
      .toBe("프리셋 A (7일 한도 거부 중) · 10/13 01:30 해제");
    expect(resetLabel(new Date(2026, 9, 15, 13, 19)))
      .toBe("프리셋 A (7일 한도 거부 중) · 10/15 13:19 해제");
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
