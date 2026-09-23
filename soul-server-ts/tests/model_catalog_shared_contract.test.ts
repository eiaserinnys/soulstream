import { describe, expect, it } from "vitest";

import {
  parseModelCatalogYaml,
  resolveModelPreset,
  UnknownModelPresetError,
} from "@soulstream/model-catalog";

describe("shared model catalog contract", () => {
  it("parses a catalog and resolves the backend model without changing the preset id", () => {
    const catalog = parseModelCatalogYaml(`
presets:
  - id: search-codex
    label: Search Codex
    backend: codex
    model: model-from-catalog
    supported_efforts: [high, max]
    default_effort: high
`);

    expect(resolveModelPreset(catalog, "search-codex")).toEqual({
      id: "search-codex",
      label: "Search Codex",
      backend: "codex",
      model: "model-from-catalog",
      supported_efforts: ["high", "max"],
      default_effort: "high",
    });
  });

  it("fails explicitly when a configured preset is missing", () => {
    const catalog = parseModelCatalogYaml("presets: []\n");

    expect(() => resolveModelPreset(catalog, "missing")).toThrow(
      UnknownModelPresetError,
    );
  });
});
