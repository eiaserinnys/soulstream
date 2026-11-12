import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pino from "pino";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  findModelProvider,
  parseModelCatalogYaml,
  resolvePresetProvider,
  type ModelCatalogConfig,
} from "@soulstream/model-catalog";
import {
  modelCatalogPathForRepository,
  openModelCatalogFile,
  repositoryRootFromEntryUrl,
} from "@soulstream/model-catalog/file-loader";

import { ClaudeSdkEventMapper } from "../src/engine/claude_sdk_event_mapper.js";
import { ClaudeRuntimeState } from "../src/engine/claude_sdk_runtime_state.js";
import { ModelCatalog, subscribeModelCatalogReannounce } from "../src/model_catalog.js";
import {
  buildReleaseManifest,
  verifyReleaseManifest,
  type ReleaseManifestBuildInput,
} from "../src/release/release_manifest.js";
import {
  modelCatalogPathForStartup,
  parseReleaseManifest,
} from "../src/release/release_runtime.js";
import { runnerChildModelCatalogGetter } from
  "../src/runner/runner_child_engine_factory.js";
import { parseRunnerChildConfig } from "../src/runner/runner_child_config.js";

import { makeTempDirSync } from "./helpers/temp_dir.js";

const REPOSITORY_CATALOG_PATH = modelCatalogPathForRepository(
  repositoryRootFromEntryUrl(import.meta.url),
);
const REPOSITORY_CATALOG = parseModelCatalogYaml(
  fs.readFileSync(REPOSITORY_CATALOG_PATH, "utf-8"),
);
const silentLogger = pino({ level: "silent" });

async function withTempCatalog<T>(
  content: string,
  fn: (catalogPath: string) => Promise<T> | T,
): Promise<T> {
  const directory = makeTempDirSync("model-catalog-runtime-");
  const catalogPath = path.join(directory, "model-catalog.yaml");
  fs.writeFileSync(catalogPath, content, "utf-8");
  try {
    return await fn(catalogPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** Writes a replacement catalogue and moves its signature past the previous read. */
function writeCatalog(catalogPath: string, catalog: ModelCatalogConfig): void {
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf-8");
  const changedMtime = fs.statSync(catalogPath).mtimeMs + 2_000;
  fs.utimesSync(catalogPath, changedMtime / 1_000, changedMtime / 1_000);
}

const PRICED_ASSISTANT = {
  type: "assistant",
  message: {
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "done" }],
  },
  parent_tool_use_id: null,
  uuid: "assistant-price",
  session_id: "claude-price",
} as unknown as SDKMessage;

const PRICED_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "done",
  uuid: "result-price",
  session_id: "claude-price",
  usage: {
    input_tokens: 48,
    output_tokens: 15_972,
    cache_creation: { ephemeral_1h_input_tokens: 104_313, ephemeral_5m_input_tokens: 0 },
    cache_read_input_tokens: 1_971_030,
    cache_creation_input_tokens: 104_313,
  },
} as unknown as SDKMessage;

function priceNextTurn(getModelCatalog: () => ModelCatalogConfig): number | undefined {
  const mapper = new ClaudeSdkEventMapper(new ClaudeRuntimeState(), getModelCatalog);
  mapper.mapSdkMessage(PRICED_ASSISTANT);
  const complete = mapper.mapSdkMessage(PRICED_RESULT)
    .find((event) => event.type === "complete");
  return complete?.turnCostUsd;
}

const RUNNER_CONFIG = {
  schemaVersion: 1,
  sessionId: "session-catalog",
  backend: "claude",
  agent: {
    id: "agent-catalog",
    name: "Catalog Agent",
    backend: "claude",
    workspace_dir: "/workspace/catalog",
  },
  paths: {
    sessionDirectory: "/runner/session-catalog",
    databasePath: "/runner/session-catalog/runner.sqlite",
    socketPath: "/runner/session-catalog/runner.sock",
    pidPath: "/runner/session-catalog/runner.pid",
    lockPath: "/runner/session-catalog/runner.lock",
    configPath: "/runner/session-catalog/runner-config.json",
    logPath: "/runner/session-catalog/runner.log",
  },
  codeSha: "sha-catalog",
  snapshotPath: "/release/sha-catalog/soul-server-ts",
  codexAdapterMode: "sdk",
  claudeRuntimeV2Enabled: false,
  claudeRuntimeIdleTtlMs: 300_000,
  claudeRuntimeMaxEntries: 16,
  claudeRuntimeTurnTimeoutMs: 1_800_000,
  internalMcpUrl: "http://127.0.0.1:4308/mcp/internal",
  codexHome: null,
  rolloutRoot: null,
} as const;

const MANIFEST_INPUT: ReleaseManifestBuildInput = {
  sourceCommit: "46203dc8c05222cbac476d2973f6f9d554926ac2",
  hostBundleHash: "sha256-host",
  runnerReleaseId: "sha256-runner",
  runnerArtifactHash: "sha256-runner",
  schemaGeneration: "069:sha256-schema",
  wireGeneration: "sha256-wire",
  nodeVersion: "22.18.0",
  platform: "linux",
  arch: "x64",
  deploymentEnvIdentity: "sha256-env",
  claudeExecutable: { kind: "claude", path: "/usr/bin/claude", identity: "sha256-claude" },
  codexExecutable: { kind: "codex", path: "/usr/bin/codex", identity: "sha256-codex" },
};

describe("model catalog node view", () => {
  it("filters presets before env resolution: 17 without a group, 22 with china", async () => {
    await withTempCatalog(JSON.stringify(REPOSITORY_CATALOG), (catalogPath) => {
      const commonOnly = new ModelCatalog(openModelCatalogFile({ path: catalogPath }), {
        enabledGroups: [],
      });
      const commonAdvertised = commonOnly.advertise({});
      expect(commonAdvertised).toHaveLength(17);
      expect(commonAdvertised.map((entry) => entry.id)).not.toContain("kimi-3");
      expect(commonAdvertised.map((entry) => entry.id)).not.toContain("deepseek-flash-4.1");
      expect(commonOnly.snapshot().presets).toHaveLength(22);

      const withChina = new ModelCatalog(openModelCatalogFile({ path: catalogPath }), {
        enabledGroups: ["china"],
      });
      const chinaAdvertised = withChina.advertise({});
      expect(chinaAdvertised).toHaveLength(22);
      expect(chinaAdvertised.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        "kimi-2",
        "kimi-3",
        "kimi-3.1-pro",
        "deepseek-flash-4.1",
        "opencode-deepseek-v4.1-flash-free",
      ]));
      expect(chinaAdvertised.find((entry) => entry.id === "kimi-3")).toMatchObject({
        available: false,
        reason: "env_unresolved",
      });
    });
  });

  it("reannounces once a valid replacement loads, and warns without throwing when the adapter is not ready", async () => {
    await withTempCatalog(JSON.stringify(REPOSITORY_CATALOG), async (catalogPath) => {
      const store = openModelCatalogFile({ path: catalogPath });
      const adapter = { reannounceAgentCatalog: vi.fn(async () => {}) };
      const logger = { error: vi.fn(), warn: vi.fn() };
      const unsubscribe = subscribeModelCatalogReannounce({
        store,
        currentAdapter: () => adapter,
        logger,
      });

      store.snapshot();
      expect(adapter.reannounceAgentCatalog).not.toHaveBeenCalled();

      const edited = structuredClone(REPOSITORY_CATALOG);
      edited.presets[0]!.label = `${edited.presets[0]!.label} (edited)`;
      writeCatalog(catalogPath, edited);

      expect(store.snapshot().presets[0]?.label).toContain("(edited)");
      await vi.waitFor(() => expect(adapter.reannounceAgentCatalog).toHaveBeenCalledTimes(1));
      expect(logger.warn).not.toHaveBeenCalled();
      unsubscribe();
    });

    await withTempCatalog(JSON.stringify(REPOSITORY_CATALOG), (catalogPath) => {
      const store = openModelCatalogFile({ path: catalogPath });
      const logger = { error: vi.fn(), warn: vi.fn() };
      subscribeModelCatalogReannounce({
        store,
        currentAdapter: () => null,
        logger,
      });

      const edited = structuredClone(REPOSITORY_CATALOG);
      edited.price_snapshot.price_version = "test-v2";
      writeCatalog(catalogPath, edited);

      expect(() => store.snapshot()).not.toThrow();
      expect(logger.warn).toHaveBeenCalledWith(
        {},
        "Model catalog reannounce skipped — UpstreamAdapter not ready",
      );
    });
  });

  it("attributes every Kimi and DeepSeek preset from catalogue data and keeps the Go usage overlay", async () => {
    const byId = new Map(REPOSITORY_CATALOG.presets.map((preset) => [preset.id, preset]));
    for (const id of ["kimi-2", "kimi-3", "kimi-3.1-pro"]) {
      expect(resolvePresetProvider(byId.get(id)!), id).toBe("kimi");
    }
    expect(resolvePresetProvider(byId.get("deepseek-flash-4.1")!)).toBe("deepseek");
    expect(resolvePresetProvider(
      byId.get("opencode-deepseek-v4.1-flash-free")!,
    )).toBe("deepseek");

    expect(findModelProvider(REPOSITORY_CATALOG, "kimi-for-coding")).toBe("kimi");
    expect(findModelProvider(REPOSITORY_CATALOG, "k3")).toBe("kimi");
    expect(findModelProvider(REPOSITORY_CATALOG, "k3.1-pro")).toBe("kimi");
    expect(findModelProvider(REPOSITORY_CATALOG, "deepseek-v4.1-flash")).toBe("deepseek");
    expect(findModelProvider(
      REPOSITORY_CATALOG,
      "opencode/deepseek-v4.1-flash-free",
    )).toBe("deepseek");

    await withTempCatalog(JSON.stringify(REPOSITORY_CATALOG), (catalogPath) => {
      const view = new ModelCatalog(openModelCatalogFile({ path: catalogPath }), {
        enabledGroups: ["china"],
      });
      const advertised = view.advertise({});
      expect(advertised.find((entry) => entry.id === "deepseek-flash-4.1")).toMatchObject({
        usage_provider: "opencode_go",
        usage_model_id: "deepseek-v4.1-flash",
      });
      expect(advertised.find((entry) => entry.id === "kimi-3")?.usage_provider).toBeNull();
    });
  });

  it("prices the next terminal turn with the latest file rates on the host and runner paths", async () => {
    await withTempCatalog(JSON.stringify(REPOSITORY_CATALOG), (catalogPath) => {
      const store = openModelCatalogFile({ path: catalogPath });
      expect(priceNextTurn(() => store.snapshot())).toBe(1.548342);

      const doubled = structuredClone(REPOSITORY_CATALOG);
      doubled.price_snapshot.price_version = "test-double-v2";
      const row = doubled.models.find((model) => model.model === "claude-opus-5-5");
      expect(row?.rates).toBeDefined();
      for (const key of ["input", "cache_read", "cache_write_5m", "cache_write_1h", "output"] as const) {
        const rate = row!.rates![key];
        if (rate !== null) row!.rates![key] = rate * 2;
      }
      writeCatalog(catalogPath, doubled);

      expect(priceNextTurn(() => store.snapshot())).toBe(3.096684);
      expect(store.snapshot().price_snapshot.price_version).toBe("test-double-v2");

      const runnerConfig = parseRunnerChildConfig({
        ...RUNNER_CONFIG,
        modelCatalogPath: catalogPath,
      });
      const runnerGetter = runnerChildModelCatalogGetter(runnerConfig, silentLogger);
      expect(runnerGetter).toBeDefined();
      expect(priceNextTurn(runnerGetter!)).toBe(3.096684);

      const withoutPath = parseRunnerChildConfig(RUNNER_CONFIG);
      expect(runnerChildModelCatalogGetter(withoutPath, silentLogger)).toBeUndefined();
    });
  });
});

describe("portable release catalogue path", () => {
  const catalogPath = "/srv/soulstream/model-catalog.yaml";

  it("records the bound catalogue path and makes it the startup source", () => {
    const manifest = buildReleaseManifest({ ...MANIFEST_INPUT, modelCatalogPath: catalogPath });
    expect(manifest.model_catalog_path).toBe(catalogPath);

    const parsed = parseReleaseManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed.model_catalog_path).toBe(catalogPath);
    expect(modelCatalogPathForStartup(parsed, "file:///release/dist/main.js")).toBe(catalogPath);

    const repositoryBound = buildReleaseManifest(MANIFEST_INPUT);
    expect(repositoryBound).not.toHaveProperty("model_catalog_path");
    expect(modelCatalogPathForStartup(repositoryBound, "file:///checkout/soul-server-ts/dist/main.js"))
      .toBe("/checkout/packages/model-catalog/data/model-catalog.yaml");
  });

  it("rejects a startup bind whose catalogue path differs from the manifest", () => {
    const manifest = buildReleaseManifest({ ...MANIFEST_INPUT, modelCatalogPath: catalogPath });

    // The path is part of the hashed manifest body, so a differing path fails
    // the manifest identity axis before the dedicated path comparison.
    expect(() => verifyReleaseManifest(manifest, {
      ...MANIFEST_INPUT,
      modelCatalogPath: "/srv/other/model-catalog.yaml",
    })).toThrow(/release manifest mismatch/);
    expect(() => verifyReleaseManifest(manifest, MANIFEST_INPUT))
      .toThrow(/release manifest mismatch/);
    expect(() => verifyReleaseManifest(manifest, {
      ...MANIFEST_INPUT,
      modelCatalogPath: catalogPath,
    })).not.toThrow();
  });
});
