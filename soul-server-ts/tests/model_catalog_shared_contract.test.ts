import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ModelCatalogSchema,
  parseModelCatalogYaml,
  resolveModelPreset,
  UnknownModelPresetError,
  type ModelPreset,
} from "@soulstream/model-catalog";
import { priceInferenceUsage } from "@soulstream/model-catalog/inference-pricing";

const REPOSITORY_CATALOG = parseModelCatalogYaml(fs.readFileSync(
  fileURLToPath(new URL("../../packages/model-catalog/data/model-catalog.yaml", import.meta.url)),
  "utf-8",
));

function catalogWithPresets(presets: unknown[]): unknown {
  return {
    schema_version: 1,
    groups: [],
    presets,
    models: [],
    price_snapshot: {
      price_version: "test-v1",
      as_of: "2026-10-19",
      checked_at: "2026-10-19",
      currency: "USD",
      unit: "per_1m_tokens",
      model_mapping_version: "exact-provider-model-v1",
      refreshed_model_rows: {},
      sources: {},
      assumptions: [],
    },
    persistent_defaults: {
      model_preset: (presets[0] as { id?: string } | undefined)?.id ?? "missing",
      fallback_models: [],
    },
  };
}

function parsePresets(presets: unknown[]): ReturnType<typeof ModelCatalogSchema.parse> {
  return ModelCatalogSchema.parse(catalogWithPresets(presets));
}

describe("shared model catalog contract", () => {
  it("includes and prices the DeepSeek Go model in the fixed snapshot", () => {
    expect(REPOSITORY_CATALOG.price_snapshot.refreshed_model_rows.deepseek).toContain("deepseek-v4.1-flash");
    const usage = {
      provider: "deepseek", input_total: 1_000, cache_read: 100,
      cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown: 0, output_total: 1_000,
    };
    expect(priceInferenceUsage(REPOSITORY_CATALOG, { ...usage, model: "deepseek-v4.1-flash" }))
      .toEqual(priceInferenceUsage(REPOSITORY_CATALOG, { ...usage, model: "deepseek-flash" }));
  });

  it("parses a catalog and resolves the backend model without changing the preset id", () => {
    const catalog = parsePresets([{
      id: "search-codex",
      label: "Search Codex",
      backend: "codex",
      model: "model-from-catalog",
      supported_efforts: ["high", "max"],
      default_effort: "high",
    }]);

    expect(resolveModelPreset(catalog, "search-codex")).toEqual({
      id: "search-codex",
      label: "Search Codex",
      backend: "codex",
      model: "model-from-catalog",
      supported_efforts: ["high", "max"],
      default_effort: "high",
    } satisfies ModelPreset);
  });

  it("preserves profile MCP allowlists, including a server explicitly disabled with an empty list", () => {
    const catalog = parsePresets([{
      id: "opencode-test",
      label: "OpenCode Test",
      backend: "opencode",
      model: "opencode/test",
      mcp_tool_allowlist: {
        roselin: {
          soulstream: ["get_session_name", "list_sessions"],
          serendipity: [],
        },
      },
    }]);

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
      expect(() => parsePresets([{
        id: "opencode-test",
        label: "OpenCode Test",
        backend: "opencode",
        model: "opencode/test",
        mcp_tool_allowlist: allowlist,
      }])).toThrow();
    }
  });

  it("fails explicitly when a configured preset is missing", () => {
    const catalog = parseModelCatalogYaml(`
schema_version: 1
groups: []
presets:
  - id: p1
    label: P1
    backend: claude
    model: m1
models: []
price_snapshot:
  price_version: test-v1
  as_of: "2026-10-19"
  checked_at: "2026-10-19"
  currency: USD
  unit: per_1m_tokens
  model_mapping_version: exact-provider-model-v1
  refreshed_model_rows: {}
  sources: {}
  assumptions: []
persistent_defaults:
  model_preset: p1
  fallback_models: []
`);

    expect(() => resolveModelPreset(catalog, "missing")).toThrow(
      UnknownModelPresetError,
    );
  });
});
