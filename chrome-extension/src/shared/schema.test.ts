import { describe, expect, it } from "vitest";

import {
  buildCreateSessionRequest,
  buildModelPresetsEndpoint,
  buildSessionEndpoint,
  collectAdvertisedEfforts,
  isReasoningEffort,
  mergeConfig,
  normalizeBodyCharLimit,
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
  it("offers only what node presets advertise, ordered canonically", () => {
    expect(
      collectAdvertisedEfforts([
        { id: "a", label: "A", supported_efforts: ["high", "low"] },
        { id: "b", label: "B", supported_efforts: ["ultra", "low", "max"] },
      ]),
    ).toEqual(["low", "high", "max", "ultra"]);
  });

  it("offers nothing when no preset advertises efforts (auto state)", () => {
    expect(collectAdvertisedEfforts([{ id: "kimi-2", label: "Kimi - 2" }])).toEqual([]);
    expect(collectAdvertisedEfforts([])).toEqual([]);
  });

  it("never invents minimal, which no model advertises", () => {
    expect(
      collectAdvertisedEfforts([
        { id: "a", label: "A", supported_efforts: ["low", "medium", "high", "xhigh"] },
      ]),
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
