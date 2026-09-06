import { describe, expect, it } from "vitest";

import {
  buildAgentsEndpoint,
  buildCreateSessionRequest,
  buildModelPresetsEndpoint,
  buildSessionEndpoint,
  effortsForPreset,
  isReasoningEffort,
  mergeConfig,
  normalizeBodyCharLimit,
  resolveProfilePreset,
  truncateText,
} from "./schema.js";

describe("schema helpers", () => {
  it("normalizes config without inventing server defaults", () => {
    expect(mergeConfig({
      baseUrl: " https://soulstream.example.com/ ",
      nodeId: " node-a ",
      profile: " roselin_codex ",
      bodyCharLimit: "999999",
      reasoningEffort: "xhigh",
    })).toMatchObject({
      baseUrl: "https://soulstream.example.com/",
      nodeId: "node-a",
      profile: "roselin_codex",
      bodyCharLimit: 50_000,
      reasoningEffort: "xhigh",
    });
  });

  it("clamps body limits and preserves truncation metadata", () => {
    expect(normalizeBodyCharLimit(-1)).toBe(0);
    expect(normalizeBodyCharLimit(100_000)).toBe(50_000);
    expect(truncateText("abcdef", 3)).toEqual({ text: "abc", truncated: true });
    expect(truncateText("abc", 3)).toEqual({ text: "abc", truncated: false });
  });

  it("builds the existing Soulstream session endpoint", () => {
    expect(buildSessionEndpoint("https://soulstream.example.com///")).toBe(
      "https://soulstream.example.com/api/sessions",
    );
  });

  it("includes only explicitly configured session fields", () => {
    const request = buildCreateSessionRequest({
      baseUrl: "https://soulstream.example.com",
      bearerToken: "",
      nodeId: "node-a",
      profile: "",
      folderId: "folder-a",
      reasoningEffort: "",
      includeBody: true,
      bodyCharLimit: 12_000,
    }, "prompt");

    expect(request).toEqual({
      prompt: "prompt",
      nodeId: "node-a",
      folderId: "folder-a",
    });
  });
});

describe("catalog-driven reasoning effort", () => {
  it("offers only what the resolved preset advertises, ordered canonically", () => {
    const agents = [{ id: "roselin", name: "roselin", default_preset: "b" }];
    const presets = [
      { id: "a", label: "A", supported_efforts: ["high", "low"] as const },
      { id: "b", label: "B", supported_efforts: ["ultra", "low", "max"] as const },
    ];
    // Deliberately not the union across the node: the picker must never offer a
    // level the profile's own preset would reject at creation time.
    expect(
      effortsForPreset(resolveProfilePreset(agents, presets, "roselin")),
    ).toEqual(["low", "max", "ultra"]);
  });

  it("offers nothing when the preset advertises no efforts (auto state)", () => {
    expect(effortsForPreset({ id: "kimi-2", label: "Kimi - 2" })).toEqual([]);
    expect(effortsForPreset(undefined)).toEqual([]);
  });

  it("never invents minimal, which no model advertises", () => {
    expect(
      effortsForPreset({
        id: "a",
        label: "A",
        supported_efforts: ["low", "medium", "high", "xhigh"],
      }),
    ).not.toContain("minimal");
  });

  it("still reads a stored legacy minimal value", () => {
    // Read compatibility: the value stays parseable so the options page can show
    // it as unsupported instead of dropping it.
    expect(isReasoningEffort("minimal")).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(true);
    expect(isReasoningEffort("banana")).toBe(false);
  });

  it("builds the node model-presets endpoint", () => {
    expect(buildModelPresetsEndpoint("https://s.example.com/", "eiaserinnys")).toBe(
      "https://s.example.com/api/nodes/eiaserinnys/model-presets",
    );
  });
});

describe("profile-scoped reasoning effort", () => {
  const presets = [
    { id: "claude-opus", label: "Opus", supported_efforts: ["low", "high", "xhigh", "max"] },
    { id: "codex-6-astra", label: "Astra", supported_efforts: ["low", "medium", "ultra"] },
  ];
  const agents = [
    { id: "roselin", default_preset: "claude-opus" },
    { id: "cody", default_preset: "codex-6-astra" },
  ];

  it("offers only the efforts of the profile's own preset", () => {
    // The node-wide union would offer `ultra` to a Claude profile, which the
    // node then rejects at creation time.
    expect(effortsForPreset(resolveProfilePreset(agents, presets, "roselin")))
      .toEqual(["low", "high", "xhigh", "max"]);
    expect(effortsForPreset(resolveProfilePreset(agents, presets, "cody")))
      .toEqual(["low", "medium", "ultra"]);
  });

  it("offers nothing when the profile has no resolvable preset", () => {
    expect(resolveProfilePreset(agents, presets, "unknown")).toBeUndefined();
    expect(effortsForPreset(undefined)).toEqual([]);
  });

  it("builds the node agents endpoint", () => {
    expect(buildAgentsEndpoint("https://s.example.com/", "eiaserinnys")).toBe(
      "https://s.example.com/api/nodes/eiaserinnys/agents",
    );
  });
});
