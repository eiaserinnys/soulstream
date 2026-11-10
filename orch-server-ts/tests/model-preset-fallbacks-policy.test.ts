import { describe, expect, it } from "vitest";

import {
  buildModelPresetFallbackMetadataEntry,
  modelPresetFallbackOrder,
  readModelPresetFallbackPolicy,
  remainingModelPresetFallbacks,
} from "@soulstream/wire-schema/model-preset-fallbacks";

function entry(initial: string, fallbacks: unknown) {
  return {
    type: "model_preset_fallbacks",
    value: { initial_model_preset: initial, model_preset_fallbacks: fallbacks },
  };
}

describe("model preset fallback policy metadata", () => {
  it("reads the last matching entry and ignores other metadata types", () => {
    expect(readModelPresetFallbackPolicy([
      entry("gemini-4-argon", ["claude-opus"]),
      { type: "caller_info", value: { source: "browser" } },
      entry("codex-6-luna", ["codex-6.1-sol"]),
    ])).toEqual({
      initialModelPreset: "codex-6-luna",
      modelPresetFallbacks: ["codex-6.1-sol"],
    });
  });

  it.each([
    ["metadata is not an array", {}],
    ["metadata is empty", []],
    ["no matching entry", [{ type: "caller_info", value: { source: "browser" } }]],
    ["value is null", [{ type: "model_preset_fallbacks", value: null }]],
    ["initial preset is missing", [{
      type: "model_preset_fallbacks",
      value: { model_preset_fallbacks: ["claude-opus"] },
    }]],
    ["initial preset is blank", [entry(" ", ["claude-opus"])]],
    ["fallbacks are missing", [{
      type: "model_preset_fallbacks",
      value: { initial_model_preset: "gemini-4-argon" },
    }]],
    ["fallbacks are not an array", [entry("gemini-4-argon", "claude-opus")]],
    ["a fallback is blank", [entry("gemini-4-argon", ["claude-opus", " "])]],
    ["a fallback is not a string", [entry("gemini-4-argon", ["claude-opus", 7])]],
  ])("returns null when %s", (_label, metadata) => {
    expect(readModelPresetFallbackPolicy(metadata)).toBeNull();
  });

  it("builds the order-preserving dedupe of the initial preset and fallbacks", () => {
    expect(modelPresetFallbackOrder({
      initialModelPreset: "gemini-4-argon",
      modelPresetFallbacks: ["claude-opus", "codex-6.1-sol", "claude-opus", "gemini-4-argon"],
    })).toEqual(["gemini-4-argon", "claude-opus", "codex-6.1-sol"]);
  });

  it("returns the suffix after the current preset", () => {
    const policy = {
      initialModelPreset: "gemini-4-argon",
      modelPresetFallbacks: ["claude-opus", "codex-6.1-sol"],
    };
    expect(remainingModelPresetFallbacks(policy, "gemini-4-argon"))
      .toEqual(["claude-opus", "codex-6.1-sol"]);
    expect(remainingModelPresetFallbacks(policy, "claude-opus"))
      .toEqual(["codex-6.1-sol"]);
    expect(remainingModelPresetFallbacks(policy, "codex-6.1-sol")).toEqual([]);
    expect(remainingModelPresetFallbacks(policy, "kimi-2")).toEqual([]);
    expect(remainingModelPresetFallbacks(policy, null)).toEqual([]);
    expect(remainingModelPresetFallbacks(policy, undefined)).toEqual([]);
  });

  it("builds a deduped metadata entry", () => {
    expect(buildModelPresetFallbackMetadataEntry(
      "gemini-4-argon",
      ["claude-opus", "claude-opus", "codex-6.1-sol"],
    )).toEqual({
      type: "model_preset_fallbacks",
      value: {
        initial_model_preset: "gemini-4-argon",
        model_preset_fallbacks: ["claude-opus", "codex-6.1-sol"],
      },
    });
  });
});
