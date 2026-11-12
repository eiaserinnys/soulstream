import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";

import {
  ModelCatalog,
  ModelCatalogSchema,
  parseModelCatalogYaml,
  type ModelCatalogOptions,
} from "../src/model_catalog.js";

import { makeTempDirSync } from "./helpers/temp_dir.js";

const REPOSITORY_CATALOG_PATH = modelCatalogPathForRepository(
  repositoryRootFromEntryUrl(import.meta.url),
);

const COMMON_PRESET_IDS = [
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
  "gemini-3.8-flash",
  "gemini-4-argon",
  "gemini-4-carbon",
];

const CHINA_PRESET_IDS = [
  "kimi-2",
  "kimi-3",
  "kimi-3.1-pro",
  "deepseek-flash-4.1",
  "opencode-deepseek-v4.1-flash-free",
];

function openRepositoryCatalog(options: ModelCatalogOptions = {}): ModelCatalog {
  return new ModelCatalog(openModelCatalogFile({ path: REPOSITORY_CATALOG_PATH }), options);
}

function openTempCatalog(catalogPath: string, options: ModelCatalogOptions = {}): ModelCatalog {
  return new ModelCatalog(
    openModelCatalogFile({
      path: catalogPath,
      ...(options.logger ? { logger: options.logger } : {}),
    }),
    options,
  );
}

function withTempCatalog<T>(content: string, fn: (catalogPath: string) => T): T {
  const directory = makeTempDirSync("model-catalog-");
  const catalogPath = path.join(directory, "model-catalog.yaml");
  fs.writeFileSync(catalogPath, content, "utf-8");
  try {
    return fn(catalogPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const MINIMAL_CATALOG_YAML = `schema_version: 1
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
`;

describe("ModelCatalog", () => {
  it("lists only presets whose group this node enabled and keeps the full snapshot", () => {
    const defaultView = openRepositoryCatalog();
    expect(defaultView.list().map((preset) => preset.id)).toEqual(COMMON_PRESET_IDS);
    expect(defaultView.snapshot().presets.map((preset) => preset.id)).toHaveLength(22);

    const chinaView = openRepositoryCatalog({ enabledGroups: ["china"] });
    expect(chinaView.list()).toHaveLength(22);
    expect(chinaView.list().map((preset) => preset.id)).toEqual(expect.arrayContaining([
      ...COMMON_PRESET_IDS,
      ...CHINA_PRESET_IDS,
    ]));
    expect(defaultView.snapshot().presets.map((preset) => preset.id)).toEqual(
      chinaView.snapshot().presets.map((preset) => preset.id),
    );
  });

  it("resolves a group preset only when the node enabled that group", () => {
    expect(() => openRepositoryCatalog().resolve("deepseek-flash-4.1")).toThrow(
      "Unknown model preset: deepseek-flash-4.1",
    );
  });

  it("loads the DeepSeek Go preset from the repository catalog", () => {
    const catalog = openRepositoryCatalog({ enabledGroups: ["china"] });
    expect(catalog.resolve("deepseek-flash-4.1")).toMatchObject({
      label: "DeepSeek - Flash 4.1",
      backend: "claude",
      model: "deepseek-v4.1-flash",
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
    });
  });

  it("advertises the OpenCode Go subscription usage provider only for the Go preset", () => {
    const catalog = openRepositoryCatalog({ enabledGroups: ["china"] });
    const byId = new Map(catalog.advertise().map((entry) => [entry.id, entry]));

    expect(byId.get("deepseek-flash-4.1")).toMatchObject({
      usage_provider: "opencode_go",
      usage_model_id: "deepseek-v4.1-flash",
    });
    expect(byId.get("kimi-2")?.usage_provider).toBeNull();
  });

  it("advertises the OpenCode DeepSeek preset without a usage provider or effort control", () => {
    const catalog = openRepositoryCatalog({ enabledGroups: ["china"] });
    const preset = catalog.advertise().find((entry) => entry.id === "opencode-deepseek-v4.1-flash-free");
    expect(preset).toMatchObject({
      backend: "opencode",
      usage_provider: null,
    });
    expect(preset?.supported_efforts).toBeUndefined();
    expect(preset).not.toHaveProperty("mcp_tool_allowlist");
    expect(catalog.resolve("opencode-deepseek-v4.1-flash-free")).toMatchObject({
      model: "opencode/deepseek-v4.1-flash-free",
      mcp_tool_allowlist: {
        roselin: {
          soulstream: expect.any(Array),
          serendipity: [],
        },
      },
    });
    expect((catalog.resolve("opencode-deepseek-v4.1-flash-free").mcp_tool_allowlist?.roselin?.soulstream)).toHaveLength(55);
  });

  it("encodes the effort policy, leaving Kimi on the backend default", () => {
    const catalog = openRepositoryCatalog({ enabledGroups: ["china"] });
    const byId = new Map(catalog.list().map((preset) => [preset.id, preset]));

    expect(byId.get("claude-fable")?.default_effort).toBe("high");
    expect(byId.get("claude-opus")?.default_effort).toBe("xhigh");
    expect(byId.get("claude-sonnet")?.default_effort).toBe("xhigh");
    expect(byId.get("codex-6-astra")?.default_effort).toBe("medium");
    expect(byId.get("codex-6.1-sol")?.default_effort).toBe("high");
    for (const id of [
      "codex-6-sol",
      "codex-6-luna",
      "codex-5.6-sol",
      "codex-5.6-luna",
      "codex-5.6-terra",
    ]) {
      expect(byId.get(id)?.default_effort, id).toBe("xhigh");
    }
    // The vendor does not validate output_config.effort, so declaring one here
    // would be display-only.
    expect(byId.get("kimi-2")?.supported_efforts).toBeUndefined();
    expect(byId.get("kimi-3")?.default_effort).toBeUndefined();
  });

  it("loads preset definitions and resolves by stable id", () => {
    withTempCatalog(MINIMAL_CATALOG_YAML, (catalogPath) => {
      const catalog = openTempCatalog(catalogPath);

      expect(catalog.list()).toMatchObject([
        { id: "p1", label: "P1", backend: "claude", model: "m1" },
      ]);
      const chinaCatalog = openTempCatalog(catalogPath, { enabledGroups: ["china"] });
      expect(chinaCatalog.resolve("p2")).toMatchObject({
        id: "p2",
        label: "P2",
        backend: "claude",
        model: "m2",
        group: "china",
      });
    });
  });

  it("re-reads the catalog after its file signature changes", () => {
    withTempCatalog(MINIMAL_CATALOG_YAML, (catalogPath) => {
      const store = openModelCatalogFile({ path: catalogPath });
      const catalog = new ModelCatalog(store);
      const readFile = vi.spyOn(fs, "readFileSync");
      expect(catalog.resolve("p1").model).toBe("m1");
      expect(catalog.resolve("p1").model).toBe("m1");
      expect(readFile.mock.calls.filter(([path]) => path === catalogPath)).toHaveLength(0);

      fs.writeFileSync(
        catalogPath,
        MINIMAL_CATALOG_YAML.replace("model: m1", "model: m1-edited"),
        "utf-8",
      );
      const changedMtime = fs.statSync(catalogPath).mtimeMs + 2_000;
      fs.utimesSync(catalogPath, changedMtime / 1_000, changedMtime / 1_000);

      expect(catalog.resolve("p1").model).toBe("m1-edited");
      expect(readFile.mock.calls.filter(([path]) => path === catalogPath)).toHaveLength(1);
      readFile.mockRestore();
    });
  });

  it("keeps the last successful catalog when the file is temporarily missing", () => {
    withTempCatalog(MINIMAL_CATALOG_YAML, (catalogPath) => {
      const catalog = openTempCatalog(catalogPath);
      fs.unlinkSync(catalogPath);
      expect(catalog.list()).toMatchObject([{ id: "p1", model: "m1" }]);
    });
  });

  it("fails the initial load when the catalog file is missing", () => {
    const directory = makeTempDirSync("model-catalog-missing-");
    try {
      const catalogPath = path.join(directory, "model-catalog.yaml");
      expect(() => openModelCatalogFile({ path: catalogPath })).toThrow(/ENOENT/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps malformed catalog content as an explicit startup failure", () => {
    withTempCatalog("presets: not-a-list\n", (catalogPath) => {
      expect(() => openModelCatalogFile({ path: catalogPath })).toThrow(ZodError);
    });
  });

  it("keeps the last successful catalog and logs when a runtime reload is malformed", () => {
    withTempCatalog(MINIMAL_CATALOG_YAML, (catalogPath) => {
      const error = vi.fn();
      const catalog = openTempCatalog(catalogPath, { logger: { error } });
      expect(catalog.resolve("p1").model).toBe("m1");

      fs.writeFileSync(catalogPath, "presets: not-a-list\n", "utf-8");
      const changedMtime = fs.statSync(catalogPath).mtimeMs + 2_000;
      fs.utimesSync(catalogPath, changedMtime / 1_000, changedMtime / 1_000);

      expect(catalog.list()).toMatchObject([{ id: "p1", model: "m1" }]);
      expect(catalog.advertise({})).toMatchObject([{ id: "p1", available: true }]);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          catalogPath,
          err: expect.any(ZodError),
        }),
        "Model catalog reload failed; keeping the last successful catalog",
      );
      expect(error).toHaveBeenCalledTimes(1);
    });
  });

  it("advertises unresolved env without exposing values and excludes API-key presets from usage", () => {
    withTempCatalog(
      `${MINIMAL_CATALOG_YAML.replace(
        "  - id: p1\n    label: P1\n    backend: claude\n    model: m1\n",
        "  - id: claude-fable\n    label: Claude - Fable\n    backend: claude\n"
        + "    model: \"claude-fable-5[1m]\"\n    usage_model_id: fable\n"
        + "  - id: kimi-2\n    label: Kimi - 2\n    backend: claude\n    model: kimi-for-coding\n"
        + "    env:\n      ANTHROPIC_BASE_URL: https://api.kimi.com/coding/\n"
        + "      ANTHROPIC_API_KEY: \${KIMI_API_KEY}\n",
      ).replace("model_preset: p1", "model_preset: claude-fable")
        .replace("  - id: p2\n    label: P2\n    backend: claude\n    model: m2\n    group: china\n", "")}`,
      (catalogPath) => {
        const catalog = openTempCatalog(catalogPath);

        expect(catalog.advertise({})).toEqual([
          {
            id: "claude-fable",
            label: "Claude - Fable",
            backend: "claude",
            model: "claude-fable-5[1m]",
            available: true,
            usage_provider: "claude",
            usage_model_id: "fable",
          },
          {
            id: "kimi-2",
            label: "Kimi - 2",
            backend: "claude",
            model: "kimi-for-coding",
            available: false,
            reason: "env_unresolved",
            usage_provider: null,
          },
        ]);
        expect(JSON.stringify(catalog.advertise({}))).not.toContain(
          "https://api.kimi.com",
        );
      },
    );
  });

  it("rejects duplicate preset ids", () => {
    expect(() =>
      ModelCatalogSchema.parse({
        schema_version: 1,
        groups: [],
        presets: [
          { id: "claude-opus", label: "One", backend: "claude", model: "opus" },
          { id: "claude-opus", label: "Two", backend: "claude", model: "opus-2" },
        ],
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
        persistent_defaults: { model_preset: "claude-opus", fallback_models: [] },
      }),
    ).toThrow(ZodError);
  });

  it("fails explicitly for an unknown preset id", () => {
    withTempCatalog(MINIMAL_CATALOG_YAML, (catalogPath) => {
      const catalog = openTempCatalog(catalogPath);
      expect(() => catalog.resolve("missing")).toThrow(
        "Unknown model preset: missing",
      );
    });
  });
});

it("advertises the Antigravity usage provider for all three account presets", () => {
  const catalog = openRepositoryCatalog();
  expect(catalog.advertise({}).filter(p => p.backend === "antigravity")).toMatchObject([
    { id: "gemini-3.8-flash", usage_provider: "antigravity" },
    { id: "gemini-4-argon", usage_provider: "antigravity" },
    { id: "gemini-4-carbon", usage_provider: "antigravity" },
  ]);
});

describe("model preset trusted execution", () => {
  const trustedPresetIds = [
    "claude-opus",
    "claude-opus-lean",
    "claude-fable",
    "claude-fable-5.2",
    "codex-6-astra",
    "codex-6.1-sol",
    "codex-6-sol",
    "gemini-4-argon",
    "gemini-4-carbon",
  ];

  it("marks exactly the nine trusted presets in the repository catalog", () => {
    const catalog = openRepositoryCatalog();
    expect(
      catalog.list()
        .filter((preset) => preset.trusted_execution === true)
        .map((preset) => preset.id)
        .sort(),
    ).toEqual([...trustedPresetIds].sort());
  });

  it("ships Fable 5.2 with a medium default effort in the repository catalog", () => {
    const preset = openRepositoryCatalog()
      .snapshot()
      .presets.find((entry) => entry.id === "claude-fable-5.2");
    expect(preset).toMatchObject({
      default_effort: "medium",
      trusted_execution: true,
    });
  });

  it("rejects a string trusted_execution at the schema boundary", () => {
    expect(() => parseModelCatalogYaml(MINIMAL_CATALOG_YAML.replace(
      "  - id: p1\n    label: P1\n    backend: claude\n    model: m1\n",
      "  - id: p1\n    label: P1\n    backend: claude\n    model: m1\n    trusted_execution: \"true\"\n",
    ))).toThrow(ZodError);
  });

  it("accepts only boolean trusted_execution values", () => {
    const catalog = parseModelCatalogYaml(MINIMAL_CATALOG_YAML.replace(
      "  - id: p1\n    label: P1\n    backend: claude\n    model: m1\n",
      "  - id: trusted\n    label: Trusted\n    backend: claude\n    model: opus\n"
      + "    trusted_execution: true\n"
      + "  - id: isolated\n    label: Isolated\n    backend: claude\n    model: sonnet\n"
      + "    trusted_execution: false\n",
    ).replace("model_preset: p1", "model_preset: trusted"));
    expect(catalog.presets).toMatchObject([
      { id: "trusted", trusted_execution: true },
      { id: "isolated", trusted_execution: false },
      { id: "p2", group: "china" },
    ]);
  });
});
