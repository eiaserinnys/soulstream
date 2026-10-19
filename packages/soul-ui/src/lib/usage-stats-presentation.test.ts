import { describe, expect, it } from "vitest";
import type {
  UsageStatsInputMaterial,
  UsageStatsOptions,
} from "../../../wire-schema/src/session_statistics";
import { formatUsageStatsApproximateTokens, formatUsageStatsInputCategoryLabel } from "./usage-stats-format";
import {
  buildUsageStatsModelOptions,
  groupUsageStatsInputMaterial,
  usageStatsFilterKey,
  usageStatsSeriesKey,
} from "./usage-stats-presentation";

function inputMaterial(
  parts: UsageStatsInputMaterial["parts"],
  observedApproximateTokens: number | null,
): UsageStatsInputMaterial {
  return {
    basis: "observed_input_material",
    unit: "approximate_tokens",
    estimate_method: "utf16_chars_div4_ceil_v1",
    method: "combined_visible",
    observed_approximate_tokens: observedApproximateTokens,
    parts,
    calibration: {
      status: "not_comparable",
      sample_count: 0,
      factor: null,
      reasons: ["missing_source_token_breakdown"],
    },
    coverage: {
      complete_samples: 0,
      partial_samples: 0,
      manifest_only_samples: 0,
      missing_samples: 0,
    },
  };
}

describe("usage statistics presentation helpers", () => {
  it("uses tuple identities and keeps provider/model selections as raw values", () => {
    const model = "vendor/team:model:v2";
    const modelKey = usageStatsFilterKey("model", "open/code", model);
    expect(usageStatsFilterKey("all", null, null)).toBe(JSON.stringify(["all", null, null]));
    expect(modelKey).toBe(JSON.stringify(["model", "open/code", model]));
    expect(usageStatsFilterKey("model", "a:b", "c"))
      .not.toBe(usageStatsFilterKey("model", "a", "b:c"));
    expect(usageStatsSeriesKey("open/code", model, true)).toBe(modelKey);
    expect(usageStatsSeriesKey("open/code", model, false))
      .toBe(JSON.stringify(["provider", "open/code"]));

    const options: UsageStatsOptions = {
      providers: [
        { provider: "codex", label: "Codex" },
        { provider: "unknown", label: "공급자 미확인" },
      ],
      models: [
        { provider: "unknown", model, backend: "first", label: "첫 모델" },
        { provider: "unknown", model, backend: "second", label: "첫 모델" },
        { provider: "codex", model: null, backend: "codex", label: "모델 미확인" },
        { provider: "codex", model: "null", backend: "codex", label: "null" },
      ],
      projects: [],
      project_roster: [],
      model_rosters: [],
    };
    const modelOptions = buildUsageStatsModelOptions(options);
    expect(modelOptions.map(option => option.label)).toEqual([
      "전체", "Codex", "공급자 미확인", "Codex · null", "공급자 미확인 · 첫 모델",
    ]);
    expect(modelOptions[4]).toEqual({
      id: usageStatsFilterKey("model", "unknown", model),
      label: "공급자 미확인 · 첫 모델",
      provider: "unknown",
      model,
    });
    expect(modelOptions.some(option => option.model === null)).toBe(true);
    expect(modelOptions.some(option => option.id === usageStatsFilterKey("model", "codex", null))).toBe(false);
    expect(modelOptions.some(option => option.model === "null")).toBe(true);
  });

  it("groups source parts once by fixed category, preserving partial values and the original denominator", () => {
    const material = inputMaterial([
      { category: "harness_internal", source_key: "hidden-a", approximate_tokens: null, share: null, measurement: "unobserved" },
      { category: "tool_result", source_key: "same", approximate_tokens: 4, share: 0.2, measurement: "reported" },
      { category: "system_prompt", source_key: "same", approximate_tokens: 5, share: 0.25, measurement: "estimate" },
      { category: "soulstream_injection", source_key: "known-zero", approximate_tokens: 0, share: 0, measurement: "estimate" },
      { category: "system_prompt", source_key: "same", approximate_tokens: 3, share: 0.15, measurement: "estimate" },
      { category: "future_category_a", source_key: "future-a", approximate_tokens: 2, share: 0.1, measurement: "estimate" },
      { category: "system_prompt", source_key: "missing", approximate_tokens: null, share: null, measurement: "unobserved" },
      { category: "tool_result", source_key: "same", approximate_tokens: 6, share: 0.3, measurement: "calibrated_estimate" },
      { category: "future_category_b", source_key: "future-b", approximate_tokens: 3, share: 0.15, measurement: "estimate" },
      { category: "harness_internal", source_key: "hidden-b", approximate_tokens: null, share: null, measurement: "unobserved" },
      { category: "soulstream_injection", source_key: "missing-zero", approximate_tokens: null, share: null, measurement: "unobserved" },
      { category: "framing", source_key: "not-measured", approximate_tokens: null, share: null, measurement: "unobserved" },
    ], 20);

    const sourceKeysBeforeGrouping = material.parts.map(part => part.source_key);
    const rows = groupUsageStatsInputMaterial(material);
    expect(rows.map(row => row.category)).toEqual([
      "system_prompt", "soulstream_injection", "tool_result", "framing", "unknown", "harness_internal",
    ]);
    expect(rows.find(row => row.category === "system_prompt")).toMatchObject({
      label: "시스템 프롬프트", approximate_tokens: 8, share: 0.4, measurement: "estimate", partial: true,
    });
    expect(rows.find(row => row.category === "soulstream_injection")).toMatchObject({
      label: "소울스트림 주입", approximate_tokens: 0, share: null, partial: true,
    });
    expect(formatUsageStatsApproximateTokens(
      rows.find(row => row.category === "system_prompt")?.approximate_tokens ?? null,
      false,
      rows.find(row => row.category === "system_prompt")?.partial ?? false,
    )).toBe("약 8+ 토큰");
    expect(formatUsageStatsApproximateTokens(
      rows.find(row => row.category === "soulstream_injection")?.approximate_tokens ?? null,
      false,
      rows.find(row => row.category === "soulstream_injection")?.partial ?? false,
    )).toBe("미기록");
    expect(rows.find(row => row.category === "tool_result")).toMatchObject({
      approximate_tokens: 10, share: 0.5, measurement: "calibrated_estimate", partial: false,
    });
    expect(rows.find(row => row.category === "unknown")).toMatchObject({
      label: "분류 미확인", approximate_tokens: 5, share: 0.25, measurement: "estimate", partial: false,
    });
    expect(rows.filter(row => row.category === "harness_internal")).toHaveLength(1);
    expect(rows[rows.length - 1]).toMatchObject({
      label: "하네스 내부 입력", approximate_tokens: null, share: null, measurement: "unobserved", partial: false,
    });
    expect(rows.some(row => row.category === "tool_definition")).toBe(false);
    expect(material.observed_approximate_tokens).toBe(20);
    expect(material.parts).toHaveLength(12);
    expect(material.parts.map(part => part.source_key)).toEqual(sourceKeysBeforeGrouping);
    expect(material.calibration).toEqual({
      status: "not_comparable", sample_count: 0, factor: null, reasons: ["missing_source_token_breakdown"],
    });
  });

  it("shows 49 source parts as one row per fixed category", () => {
    const categories = [
      "system_prompt", "soulstream_injection", "user_prompt", "tool_result", "history_replay",
      "tool_definition", "framing", "combined_visible", "future_category_a", "future_category_b",
    ];
    const parts: UsageStatsInputMaterial["parts"] = [];
    for (let index = 0; index < 49; index += 1) {
      parts.push({
        category: categories[index % categories.length],
        source_key: `source-${index}`,
        approximate_tokens: 1,
        share: 1 / 49,
        measurement: "estimate",
      });
    }
    parts.push({ category: "harness_internal", source_key: null, approximate_tokens: null, share: null, measurement: "unobserved" });
    const material = inputMaterial(parts, 49);
    const rows = groupUsageStatsInputMaterial(material);
    expect(rows.map(row => row.category)).toEqual([
      "system_prompt", "soulstream_injection", "user_prompt", "tool_result", "history_replay",
      "tool_definition", "framing", "combined_visible", "unknown", "harness_internal",
    ]);
    expect(rows.filter(row => row.category !== "harness_internal")
      .reduce((sum, row) => sum + (row.approximate_tokens ?? 0), 0)).toBe(49);
    expect(material.parts).toHaveLength(50);
  });

  it("keeps the complete category labels and order", () => {
    expect([
      "system_prompt", "soulstream_injection", "user_prompt", "tool_result", "history_replay",
      "tool_definition", "framing", "combined_visible", "unknown", "harness_internal",
    ].map(formatUsageStatsInputCategoryLabel)).toEqual([
      "시스템 프롬프트", "소울스트림 주입", "사용자 프롬프트", "툴 결과", "이전 대화 재전달",
      "툴 정의", "구분자·형식", "합쳐진 입력 자료", "분류 미확인", "하네스 내부 입력",
    ]);
  });
});
