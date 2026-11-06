import { describe, expect, it } from "vitest";

import {
  parseModelCatalogYaml,
  resolveModelPreset,
  UnknownModelPresetError,
} from "@soulstream/model-catalog";
import { PRICE_SNAPSHOT_METADATA, priceInferenceUsage } from "@soulstream/model-catalog/inference-pricing";

describe("shared model catalog contract", () => {
  it("includes and prices the DeepSeek Go model in the fixed snapshot", () => {
    expect(PRICE_SNAPSHOT_METADATA.refreshed_model_rows.deepseek).toContain("deepseek-v4.1-flash");
    const usage = {
      provider: "deepseek", input_total: 1_000, cache_read: 100,
      cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 0, output_total: 1_000,
    };
    expect(priceInferenceUsage({ ...usage, model: "deepseek-v4.1-flash" }))
      .toEqual(priceInferenceUsage({ ...usage, model: "deepseek-flash" }));
  });

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

  it("preserves profile MCP allowlists, including a server explicitly disabled with an empty list", () => {
    const catalog = parseModelCatalogYaml(`
presets:
  - id: opencode-test
    label: OpenCode Test
    backend: opencode
    model: opencode/test
    mcp_tool_allowlist:
      roselin:
        soulstream: [get_session_name, list_sessions]
        serendipity: []
`);

    expect(resolveModelPreset(catalog, "opencode-test").mcp_tool_allowlist).toEqual({
      roselin: {
        soulstream: ["get_session_name", "list_sessions"],
        serendipity: [],
      },
    });
  });

  it("rejects empty MCP allowlist server and tool names", () => {
    for (const allowlist of [
      { roselin: { "": ["get_session_name"] } },
      { roselin: { soulstream: [""] } },
    ]) {
      expect(() => parseModelCatalogYaml(JSON.stringify({
        presets: [{
          id: "opencode-test",
          label: "OpenCode Test",
          backend: "opencode",
          model: "opencode/test",
          mcp_tool_allowlist: allowlist,
        }],
      }))).toThrow();
    }
  });

  it("fails explicitly when a configured preset is missing", () => {
    const catalog = parseModelCatalogYaml("presets: []\n");

    expect(() => resolveModelPreset(catalog, "missing")).toThrow(
      UnknownModelPresetError,
    );
  });
});
