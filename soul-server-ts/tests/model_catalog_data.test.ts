import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findModelProvider,
  findModelRow,
  modelDisplayName,
  parseModelCatalogGroups,
  parseModelCatalogYaml,
  resolvePresetProvider,
  selectModelPresets,
} from "@soulstream/model-catalog";
import {
  priceInferenceUsage,
  priceInferenceUsageComponents,
} from "@soulstream/model-catalog/inference-pricing";
import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";
import { readStoredPersistentSettings } from "@soulstream/wire-schema/persistent-session-settings";

import { makeTempDirSync } from "./helpers/temp_dir.js";

const REPOSITORY_CATALOG_YAML = fs.readFileSync(
  fileURLToPath(new URL("../../packages/model-catalog/data/model-catalog.yaml", import.meta.url)),
  "utf-8",
);
const catalog = parseModelCatalogYaml(REPOSITORY_CATALOG_YAML);

const PRESET_IDS = [
  "claude-haiku",
  "claude-sonnet",
  "claude-opus",
  "claude-opus-lean",
  "claude-fable",
  "claude-fable-5.2",
  "codex-6-astra",
  "codex-6.1-sol",
  "codex-6.1-terra",
  "codex-6-sol",
  "codex-6-luna",
  "codex-5.6-sol",
  "codex-5.6-luna",
  "codex-5.6-terra",
  "kimi-2",
  "kimi-3",
  "kimi-3.1-pro",
  "deepseek-flash-4.1",
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-4-carbon",
  "gemini-4-hydrogen",
  "opencode-deepseek-v4.1-flash-free",
];

const CHINA_PRESET_IDS = [
  "kimi-2",
  "kimi-3",
  "kimi-3.1-pro",
  "deepseek-flash-4.1",
  "opencode-deepseek-v4.1-flash-free",
];

/** 17 formerly priced rows: provider:model -> [input, cache_read, write5m, write1h, output]. */
const EXPECTED_RATES: Record<string, readonly [number, number, number | null, number | null, number]> = {
  "claude:claude-opus-5-5": [4, 0.2, 5, 8, 20],
  "claude:claude-fable-5-2": [8, 0.2, 10, 16, 40],
  "claude:claude-fable-5-1": [10, 0.25, 12.5, 20, 50],
  "claude:claude-opus-5": [5, 0.5, 6.25, 10, 25],
  "claude:claude-sonnet-5-5": [2, 0.1, 2.5, 4, 10],
  "claude:claude-sonnet-5": [2, 0.2, 2.5, 4, 10],
  "claude:claude-opus-4-8": [5, 0.5, 6.25, 10, 25],
  "claude:claude-haiku-4-5": [1, 0.1, 1.25, 2, 5],
  "codex:gpt-6-luna": [0.1, 0.01, 0.125, 0.125, 0.5],
  "codex:gpt-6-sol": [2, 0.2, 2.5, 2.5, 10],
  "codex:gpt-6.1-sol": [2, 0.1, 2.5, 2.5, 10],
  "codex:gpt-6-astra": [10, 1, 12.5, 12.5, 50],
  "antigravity:gemini-4-carbon": [2, 0.1, null, null, 10],
  "antigravity:gemini-4-hydrogen": [1.5, 0.075, null, null, 7.5],
  "antigravity:gemini-4-argon": [2, 0.1, null, null, 10],
  "antigravity:gemini-3.8-flash": [0.75, 0.075, null, null, 3.75],
  "deepseek:deepseek-flash": [0.3, 0.006, null, null, 1.2],
};

const DEEPSEEK_ALIASES = [
  "deepseek-v4.1-flash-1017",
  "deepseek-v4.1-flash",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
  "opencode/deepseek-v4.1-flash-free",
];

const USAGE = {
  input_total: 1_000_000,
  cache_read: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_write_unknown: 0,
  output_total: 1_000_000,
};

type PresetExpectation = {
  label: string;
  backend: string;
  model: string;
  group?: string;
  provider?: string;
  usage_model_id?: string;
  usage_provider?: string;
  supported_efforts?: string[];
  default_effort?: string;
  trusted_execution?: boolean;
  env?: Record<string, string>;
};

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const KIMI_ENV = {
  ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
  ANTHROPIC_API_KEY: "${KIMI_API_KEY}",
  CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
};

/** Values of the 18 common presets plus the 5 china operating additions. */
const EXPECTED_PRESETS: Record<string, PresetExpectation> = {
  "claude-haiku": { label: "Claude - Haiku", backend: "claude", model: "haiku" },
  "claude-sonnet": {
    label: "Claude - Sonnet",
    backend: "claude",
    model: "sonnet",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "xhigh",
  },
  "claude-opus": {
    label: "Claude - Opus",
    backend: "claude",
    model: "opus",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "xhigh",
    trusted_execution: true,
  },
  "claude-opus-lean": {
    label: "Claude - Opus (담당 시범, 압축 25만)",
    backend: "claude",
    model: "claude-opus-5-5[1m]",
    usage_model_id: "opus",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "xhigh",
    trusted_execution: true,
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "250000", ENABLE_TOOL_SEARCH: "false" },
  },
  "claude-fable": {
    label: "Claude - Fable 5.1",
    backend: "claude",
    model: "claude-fable-5-1[1m]",
    usage_model_id: "fable",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "high",
    trusted_execution: true,
  },
  "claude-fable-5.2": {
    label: "Claude - Fable 5.2",
    backend: "claude",
    model: "claude-fable-5-2[1m]",
    usage_model_id: "fable",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "medium",
    trusted_execution: true,
  },
  "codex-6-astra": {
    label: "Codex - 6 Astra",
    backend: "codex",
    model: "gpt-6-astra",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "medium",
    trusted_execution: true,
  },
  "codex-6.1-sol": {
    label: "Codex - 6.1 Sol",
    backend: "codex",
    model: "gpt-6.1-sol",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "high",
    trusted_execution: true,
  },
  "codex-6.1-terra": {
    label: "Codex - 6.1 Terra",
    backend: "codex",
    model: "gpt-6.1-terra",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "max",
  },
  "codex-6-sol": {
    label: "Codex - 6 Sol",
    backend: "codex",
    model: "gpt-6-sol",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "xhigh",
    trusted_execution: true,
  },
  "codex-6-luna": {
    label: "Codex - 6 Luna",
    backend: "codex",
    model: "gpt-6-luna",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "xhigh",
  },
  "codex-5.6-sol": {
    label: "Codex - 5.6 Sol",
    backend: "codex",
    model: "gpt-5.6-sol",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "xhigh",
  },
  "codex-5.6-luna": {
    label: "Codex - 5.6 Luna",
    backend: "codex",
    model: "gpt-5.6-luna",
    supported_efforts: CLAUDE_EFFORTS,
    default_effort: "xhigh",
  },
  "codex-5.6-terra": {
    label: "Codex - 5.6 Terra",
    backend: "codex",
    model: "gpt-5.6-terra",
    supported_efforts: CODEX_EFFORTS,
    default_effort: "xhigh",
  },
  "kimi-2": {
    label: "Kimi - 2",
    backend: "claude",
    model: "kimi-for-coding",
    group: "china",
    provider: "kimi",
    env: KIMI_ENV,
  },
  "kimi-3": {
    label: "Kimi - 3",
    backend: "claude",
    model: "k3",
    group: "china",
    provider: "kimi",
    env: KIMI_ENV,
  },
  "kimi-3.1-pro": {
    label: "Kimi - 3.1 Pro",
    backend: "claude",
    model: "k3.1-pro",
    group: "china",
    provider: "kimi",
    env: KIMI_ENV,
  },
  "deepseek-flash-4.1": {
    label: "DeepSeek - Flash 4.1",
    backend: "claude",
    model: "deepseek-v4.1-flash",
    group: "china",
    provider: "deepseek",
    usage_provider: "opencode_go",
    supported_efforts: ["xhigh", "max"],
    default_effort: "max",
    env: {
      ANTHROPIC_BASE_URL: "https://opencode.ai/inference/go/anthropic",
      ANTHROPIC_API_KEY: "${OPENCODE_GO_API_KEY}",
      ENABLE_TOOL_SEARCH: "true",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4.1-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4.1-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4.1-flash",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144",
    },
  },
  "gemini-3.8-flash": {
    label: "Gemini - 3.8 Flash",
    backend: "antigravity",
    model: "gemini-3.8-flash",
    supported_efforts: ["low", "medium", "high"],
    default_effort: "low",
  },
  "gemini-4-argon": {
    label: "Gemini - 4 Argon",
    backend: "antigravity",
    model: "gemini-4-argon",
    supported_efforts: ["low", "medium", "high"],
    default_effort: "high",
    trusted_execution: true,
  },
  "gemini-4-carbon": {
    label: "Gemini - 4 Carbon",
    backend: "antigravity",
    model: "gemini-4-carbon",
    supported_efforts: ["low", "medium", "high"],
    default_effort: "high",
    trusted_execution: true,
  },
  "gemini-4-hydrogen": {
    label: "Gemini - 4 Hydrogen",
    backend: "antigravity",
    model: "gemini-4-hydrogen",
    supported_efforts: ["low", "medium", "high", "xhigh"],
    default_effort: "high",
  },
  "opencode-deepseek-v4.1-flash-free": {
    label: "OpenCode - DeepSeek V4.1 Flash Free",
    backend: "opencode",
    model: "opencode/deepseek-v4.1-flash-free",
    group: "china",
    provider: "deepseek",
  },
};

const BASE_CATALOG_YAML = `schema_version: 1
groups: [china]
presets:
  - id: p1
    label: P1
    backend: claude
    model: m1
  - id: p2
    label: P2
    backend: claude
    model: m2
    group: china
models:
  - provider: claude
    model: m1
    rates: {input: 1, cache_read: 0.1, cache_write_5m: 1, cache_write_1h: 2, output: 5}
    source: https://example.test/pricing
  - provider: claude
    model: m2
    rates: null
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
  fallback_models:
    - model_preset: p2
      reasoning_effort: high
`;

const EDITED_CATALOG_YAML = BASE_CATALOG_YAML.replace(
  "  - id: p2\n    label: P2\n    backend: claude\n    model: m2\n    group: china\n",
  "  - id: p2\n    label: P2\n    backend: claude\n    model: m2\n    group: china\n"
  + "  - id: p3\n    label: P3\n    backend: codex\n    model: gpt-x\n",
);

function writeCatalog(directory: string, content: string): string {
  const catalogPath = path.join(directory, "model-catalog.yaml");
  fs.writeFileSync(catalogPath, content, "utf-8");
  return catalogPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("repository model catalogue data", () => {
  it("carries the 23 operating presets and gates only the china group", () => {
    expect(catalog.schema_version).toBe(1);
    expect(catalog.groups).toEqual(["china"]);
    expect(catalog.presets.map((preset) => preset.id)).toEqual(PRESET_IDS);
    expect(catalog.presets.filter((preset) => preset.group === "china").map((preset) => preset.id))
      .toEqual(CHINA_PRESET_IDS);
    expect(selectModelPresets(catalog, []).map((preset) => preset.id)).toEqual(
      PRESET_IDS.filter((id) => !CHINA_PRESET_IDS.includes(id)),
    );
    expect(selectModelPresets(catalog, ["china"]).map((preset) => preset.id)).toEqual(PRESET_IDS);
  });

  it("keeps every operating preset value", () => {
    expect(Object.keys(EXPECTED_PRESETS)).toEqual(PRESET_IDS);
    for (const [id, expected] of Object.entries(EXPECTED_PRESETS)) {
      const preset = catalog.presets.find((entry) => entry.id === id)!;
      const actual: Record<string, unknown> = {
        label: preset.label,
        backend: preset.backend,
        model: preset.model,
      };
      for (const key of [
        "group",
        "provider",
        "usage_model_id",
        "usage_provider",
        "supported_efforts",
        "default_effort",
        "trusted_execution",
        "env",
      ] as const) {
        if (preset[key] !== undefined) actual[key] = preset[key];
      }
      expect({ id, ...actual }).toEqual({ id, ...expected });
    }

    const opencode = catalog.presets.find((preset) => preset.id === "opencode-deepseek-v4.1-flash-free")!;
    expect(opencode.mcp_tool_allowlist).toEqual({
      roselin: { soulstream: expect.any(Array), serendipity: [] },
    });
    expect(opencode.mcp_tool_allowlist?.roselin?.soulstream).toHaveLength(55);
  });

  it("resolves the usage provider from the preset field with the backend fallback", () => {
    const providers = new Map(
      catalog.presets.map((preset) => [preset.id, resolvePresetProvider(preset)]),
    );
    expect(providers.get("kimi-2")).toBe("kimi");
    expect(providers.get("kimi-3")).toBe("kimi");
    expect(providers.get("kimi-3.1-pro")).toBe("kimi");
    expect(providers.get("deepseek-flash-4.1")).toBe("deepseek");
    expect(providers.get("opencode-deepseek-v4.1-flash-free")).toBe("deepseek");
    expect(providers.get("claude-opus")).toBe("claude");
    expect(providers.get("codex-6.1-sol")).toBe("codex");
    expect(providers.get("gemini-4-argon")).toBe("antigravity");
    expect(resolvePresetProvider({ backend: "opencode" })).toBe("unknown");
    expect(resolvePresetProvider({ backend: "openai-agents" })).toBe("unknown");
  });

  it("parses the node group selection and rejects undeclared groups", () => {
    expect(parseModelCatalogGroups(undefined, catalog)).toEqual([]);
    expect(parseModelCatalogGroups("", catalog)).toEqual([]);
    expect(parseModelCatalogGroups(" china , ", catalog)).toEqual(["china"]);
    expect(parseModelCatalogGroups("china,china", catalog)).toEqual(["china"]);
    expect(() => parseModelCatalogGroups("china,nope", catalog))
      .toThrow(/Unknown model catalog group/);
  });

  it("maps the eight display names without naming the other rows", () => {
    const displayNames: Record<string, string> = {
      "claude-opus-5.5": "Claude Opus 5.5",
      "claude-opus-5-5": "Claude Opus 5.5",
      "claude-sonnet-5.5": "Claude Sonnet 5.5",
      "claude-sonnet-5-5": "Claude Sonnet 5.5",
      "gpt-6.1-sol": "GPT-6.1 Sol",
      "gpt-6-luna": "GPT-6 Luna",
      "gemini-3.8-flash": "Gemini 3.8 Flash",
      "gemini-4-argon": "Gemini 4 Argon",
      "gemini-4-carbon": "Gemini 4 Carbon",
      "gemini-4-hydrogen": "Gemini 4 Hydrogen",
      "kimi-for-coding/k3": "Kimi for Coding K3",
    };
    for (const [model, label] of Object.entries(displayNames)) {
      expect(modelDisplayName(catalog, model)).toBe(label);
    }
    expect(modelDisplayName(catalog, "claude-opus-5-5[1m]")).toBe("Claude Opus 5.5");
    expect(modelDisplayName(catalog, "claude-sonnet-5")).toBeNull();
    expect(modelDisplayName(catalog, "not-a-model")).toBeNull();
    expect(findModelRow(catalog, "deepseek-v4.1-flash")?.provider).toBe("deepseek");
  });

  it("finds the usage provider of a model string from presets and model rows", () => {
    expect(findModelProvider(catalog, "kimi-for-coding")).toBe("kimi");
    expect(findModelProvider(catalog, "k3")).toBe("kimi");
    expect(findModelProvider(catalog, "k3.1-pro")).toBe("kimi");
    expect(findModelProvider(catalog, "deepseek-v4.1-flash")).toBe("deepseek");
    expect(findModelProvider(catalog, "opencode/deepseek-v4.1-flash-free")).toBe("deepseek");
    expect(findModelProvider(catalog, "deepseek-v4-flash")).toBe("deepseek");
    expect(findModelProvider(catalog, "opus")).toBe("claude");
    expect(findModelProvider(catalog, "gpt-6.1-sol")).toBe("codex");
    expect(findModelProvider(catalog, "claude-haiku-4-5-20251001")).toBe("claude");
    expect(findModelProvider(catalog, "not-a-model")).toBeUndefined();
  });

  it("keeps every legacy price row and alias at its previous rates", () => {
    expect(catalog.models).toHaveLength(18);
    expect(catalog.models.filter((row) => row.rates !== null)).toHaveLength(17);
    for (const [key, rates] of Object.entries(EXPECTED_RATES)) {
      const separator = key.indexOf(":");
      const provider = key.slice(0, separator);
      const model = key.slice(separator + 1);
      const row = findModelRow(catalog, model)!;
      expect(row.provider).toBe(provider);
      expect(row.rates).toEqual({
        input: rates[0],
        cache_read: rates[1],
        cache_write_5m: rates[2],
        cache_write_1h: rates[3],
        output: rates[4],
      });
    }
  });

  it("prices all 22 legacy keys from the data file", () => {
    const keys = [
      ...Object.keys(EXPECTED_RATES),
      ...DEEPSEEK_ALIASES.map((alias) => `deepseek:${alias}`),
    ];
    expect(keys).toHaveLength(22);
    for (const key of keys) {
      const separator = key.indexOf(":");
      const provider = key.slice(0, separator);
      const model = key.slice(separator + 1);
      const canonicalKey = DEEPSEEK_ALIASES.includes(model) && provider === "deepseek"
        ? "deepseek:deepseek-flash"
        : key;
      const rates = EXPECTED_RATES[canonicalKey]!;
      const result = priceInferenceUsage(catalog, { provider, model, ...USAGE });
      expect(result.price_version).toBe("api-list-usd-2026-10-19-v1");
      expect(result.as_of).toBe("2026-10-19");
      expect(result.pricing_complete).toBe(true);
      expect(result.known_cost_usd).toBeCloseTo(rates[0] + rates[4], 10);
    }
  });

  it("keeps the price snapshot metadata", () => {
    expect(catalog.price_snapshot).toEqual({
      price_version: "api-list-usd-2026-10-19-v1",
      as_of: "2026-10-19",
      checked_at: "2026-10-19",
      currency: "USD",
      unit: "per_1m_tokens",
      model_mapping_version: "exact-provider-model-v1",
      legacy_rows_last_checked_at: "2026-10-05",
      refreshed_model_rows: {
        claude: ["claude-opus-5-5", "claude-fable-5-2", "claude-fable-5-1", "claude-sonnet-5-5"],
        codex: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"],
        antigravity: ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"],
        deepseek: [
          "deepseek-v4.1-flash-1017",
          "deepseek-v4.1-flash",
          "deepseek-flash",
          "deepseek-v4-flash",
          "deepseek-v4-flash-vision-exp",
          "opencode/deepseek-v4.1-flash-free",
        ],
      },
      sources: {
        claude: "https://platform.claude.com/docs/en/about-claude/pricing",
        codex: "https://developers.openai.com/api/docs/pricing?tab=suite",
        antigravity: "https://ai.google.dev/gemini-api/docs/pricing",
        deepseek: "https://api-docs.deepseek.com/quick_start/pricing/",
      },
      assumptions: [
        "Standard API prices and default context tiers are used for the fixed snapshot.",
        "DeepSeek V4.1 Flash uses the 1017 peak schedule; the OpenCode free-harness alias is priced at API list price, not at $0.",
        "OpenCode Go subscription usage is also valued at API list price.",
        "Gemini promotional rates remain frozen in this snapshot after their published end dates.",
        "Other legacy rows retain their previous 2026-10-05 values and are not claimed as reverified for this snapshot.",
      ],
    });
  });

  it("splits a priced usage into cache-read and non-cache decimals", () => {
    const components = priceInferenceUsageComponents(catalog, {
      provider: "deepseek",
      model: "deepseek-v4.1-flash",
      input_total: 2_000_000,
      cache_read: 1_000_000,
      cache_write_5m: 0,
      cache_write_1h: 0,
      cache_write_unknown: 0,
      output_total: 0,
    });
    expect(components.price_version).toBe("api-list-usd-2026-10-19-v1");
    expect(components.cache_read.known_cost_usd_decimal).toBe("0.006");
    expect(components.non_cache.known_cost_usd_decimal).toBe("0.3");
  });

  it("leaves unpriced rows unpriced and scopes the price lookup by provider", () => {
    const unpricedRow = priceInferenceUsage(catalog, {
      provider: "kimi",
      model: "kimi-for-coding/k3",
      ...USAGE,
    });
    expect(unpricedRow.known_cost_usd).toBeNull();
    expect(unpricedRow.unpriced_reasons).toEqual(["model_price_unknown"]);

    const otherProvider = priceInferenceUsage(catalog, {
      provider: "claude",
      model: "gpt-6.1-sol",
      ...USAGE,
    });
    expect(otherProvider.known_cost_usd).toBeNull();

    const normalized = priceInferenceUsage(catalog, {
      provider: "codex",
      model: "gpt-6.1-sol[1m]",
      ...USAGE,
    });
    expect(normalized.known_cost_usd).toBeCloseTo(12, 10);
  });

  it("keeps the PAS defaults in the data file", () => {
    expect(catalog.persistent_defaults).toEqual({
      model_preset: "claude-opus",
      fallback_models: [{ model_preset: "codex-6.1-sol", reasoning_effort: "high" }],
    });
  });
});

describe("model catalogue schema validation", () => {
  it("rejects duplicate preset ids", () => {
    expect(() => parseModelCatalogYaml(BASE_CATALOG_YAML.replace("  - id: p2", "  - id: p1")))
      .toThrow(/Duplicate model preset id/);
  });

  it("rejects a model or alias repeated across rows", () => {
    const duplicated = BASE_CATALOG_YAML.replace(
      "    model: m2\n    rates: null",
      "    model: m2\n    aliases: [m1]\n    rates: null",
    );
    expect(() => parseModelCatalogYaml(duplicated)).toThrow(/Duplicate model or alias/);
  });

  it("rejects a group that the catalogue does not declare", () => {
    const undeclared = BASE_CATALOG_YAML.replace("    group: china", "    group: europa");
    expect(() => parseModelCatalogYaml(undeclared))
      .toThrow(/is not declared in catalog groups/);
  });

  it("rejects persistent defaults that name a missing preset", () => {
    const missing = BASE_CATALOG_YAML.replace("  model_preset: p1", "  model_preset: nope");
    expect(() => parseModelCatalogYaml(missing))
      .toThrow(/persistent_defaults\.model_preset .*nope.* is not a known model preset/);
    const missingFallback = BASE_CATALOG_YAML.replace(
      "    - model_preset: p2",
      "    - model_preset: nope",
    );
    expect(() => parseModelCatalogYaml(missingFallback))
      .toThrow(/persistent_defaults\.fallback_models\[0\] .*nope.* is not a known model preset/);
  });

  it("rejects negative rates and an unsupported schema version", () => {
    expect(() => parseModelCatalogYaml(BASE_CATALOG_YAML.replace("input: 1,", "input: -1,")))
      .toThrow();
    expect(() => parseModelCatalogYaml(BASE_CATALOG_YAML.replace("schema_version: 1", "schema_version: 2")))
      .toThrow();
  });
});

describe("model catalogue file loader", () => {
  it("throws when the first load fails", () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    expect(() => openModelCatalogFile({ path: path.join(directory, "missing.yaml") }))
      .toThrow();
    const invalidPath = writeCatalog(directory, "schema_version: 2\n");
    expect(() => openModelCatalogFile({ path: invalidPath })).toThrow();
    const validPath = writeCatalog(directory, BASE_CATALOG_YAML);
    expect(() => openModelCatalogFile({
      path: validPath,
      validate: () => {
        throw new Error("not deliverable");
      },
    })).toThrow(/not deliverable/);
  });

  it("reloads on a valid replacement and notifies subscribers once", () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    const catalogPath = writeCatalog(directory, BASE_CATALOG_YAML);
    const store = openModelCatalogFile({ path: catalogPath, pollIntervalMs: 10 });
    try {
      expect(store.snapshot().presets.map((preset) => preset.id)).toEqual(["p1", "p2"]);
      const seen: number[] = [];
      const unsubscribe = store.subscribe((next) => seen.push(next.presets.length));

      fs.writeFileSync(catalogPath, EDITED_CATALOG_YAML, "utf-8");
      expect(store.snapshot().presets.map((preset) => preset.id)).toEqual(["p1", "p2", "p3"]);
      expect(seen).toEqual([3]);

      unsubscribe();
      fs.writeFileSync(catalogPath, BASE_CATALOG_YAML, "utf-8");
      expect(store.snapshot().presets).toHaveLength(2);
      expect(seen).toEqual([3]);
    } finally {
      store.close();
    }
  });

  it("keeps the last good catalogue on an invalid edit and logs once", () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    const catalogPath = writeCatalog(directory, BASE_CATALOG_YAML);
    const errors: string[] = [];
    const store = openModelCatalogFile({
      path: catalogPath,
      pollIntervalMs: 10,
      logger: { error: (_bindings, message) => errors.push(message) },
    });
    const notified: number[] = [];
    store.subscribe((next) => notified.push(next.presets.length));
    try {
      fs.writeFileSync(catalogPath, "schema_version: 2\n", "utf-8");
      expect(store.snapshot().presets).toHaveLength(2);
      expect(store.snapshot().presets).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(notified).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("keeps the last good catalogue when the file disappears and logs once", () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    const catalogPath = writeCatalog(directory, BASE_CATALOG_YAML);
    const errors: string[] = [];
    const store = openModelCatalogFile({
      path: catalogPath,
      pollIntervalMs: 10,
      logger: { error: (_bindings, message) => errors.push(message) },
    });
    const notified: number[] = [];
    store.subscribe((next) => notified.push(next.presets.length));
    try {
      fs.rmSync(catalogPath);
      expect(store.snapshot().presets).toHaveLength(2);
      expect(store.snapshot().presets).toHaveLength(2);
      expect(errors).toHaveLength(1);
      expect(notified).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("loads a CRLF catalogue", () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    const catalogPath = writeCatalog(directory, BASE_CATALOG_YAML.replace(/\n/g, "\r\n"));
    const store = openModelCatalogFile({ path: catalogPath });
    try {
      expect(store.snapshot().presets).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it("polls after start() and stops after close()", async () => {
    const directory = makeTempDirSync("model-catalog-loader-");
    const catalogPath = writeCatalog(directory, BASE_CATALOG_YAML);
    const store = openModelCatalogFile({ path: catalogPath, pollIntervalMs: 10 });
    const seen: number[] = [];
    store.subscribe((next) => seen.push(next.presets.length));
    store.start();
    try {
      fs.writeFileSync(catalogPath, EDITED_CATALOG_YAML, "utf-8");
      await waitFor(() => seen.length > 0);
      expect(seen).toEqual([3]);
    } finally {
      store.close();
    }
    fs.writeFileSync(catalogPath, BASE_CATALOG_YAML, "utf-8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen).toEqual([3]);
  });

  it("derives the repository root and catalogue path from an entry URL", () => {
    expect(repositoryRootFromEntryUrl("file:///repo/soul-server-ts/src/main.ts")).toBe("/repo");
    expect(modelCatalogPathForRepository("/repo")).toBe(
      path.join("/repo", "packages/model-catalog/data/model-catalog.yaml"),
    );
  });
});

describe("persistent settings fallback defaults", () => {
  const defaults = [{ model_preset: "codex-6.1-sol", reasoning_effort: "high" }];

  it("fills missing fallback models from the supplied catalogue defaults", () => {
    const stored = readStoredPersistentSettings([{
      type: "persistent_settings",
      value: { default_model: { model_preset: "claude-opus", reasoning_effort: "xhigh" } },
    }], defaults);
    expect(stored?.fallback_models).toEqual(defaults);
  });

  it("keeps an explicit empty list and the legacy fallback_model", () => {
    const empty = readStoredPersistentSettings([{
      type: "persistent_settings",
      value: { fallback_models: [] },
    }], defaults);
    expect(empty?.fallback_models).toEqual([]);

    const legacy = readStoredPersistentSettings([{
      type: "persistent_settings",
      value: { fallback_model: { model_preset: "claude-haiku", reasoning_effort: null } },
    }], defaults);
    expect(legacy?.fallback_models).toEqual([
      { model_preset: "claude-haiku", reasoning_effort: null },
    ]);
  });

  it("returns undefined when no persistent settings entry exists", () => {
    expect(readStoredPersistentSettings([], defaults)).toBeUndefined();
    expect(readStoredPersistentSettings(undefined, defaults)).toBeUndefined();
  });
});
