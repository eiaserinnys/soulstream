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
