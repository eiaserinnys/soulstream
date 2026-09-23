import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSearchQueryModelResolver,
  SearchQueryModelConfigurationError,
} from "../src/search/search_query_model_resolver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("search query model resolver", () => {
  it("resolves the backend model and explicit effort once from the configured catalog", async () => {
    const directory = await mkdtemp(join(tmpdir(), "search-model-catalog-"));
    temporaryDirectories.push(directory);
    const catalogPath = join(directory, "catalog.yaml");
    await writeFile(catalogPath, `
presets:
  - id: search-preset
    label: Search preset
    backend: codex
    model: resolved-backend-model
    supported_efforts: [high, max]
    default_effort: high
`, "utf8");

    const resolver = createSearchQueryModelResolver({
      catalogPath,
      presetId: "search-preset",
      reasoningEffort: "max",
    });
    await writeFile(catalogPath, "presets: []\n", "utf8");

    expect(resolver.resolve()).toEqual({
      model: "resolved-backend-model",
      reasoningEffort: "max",
    });
  });

  it("reports missing configuration and missing presets explicitly", () => {
    const missingPathResolver = createSearchQueryModelResolver({
      catalogPath: "",
      presetId: "search-preset",
      reasoningEffort: "max",
    });
    expect(() => missingPathResolver.resolve()).toThrow(
      SearchQueryModelConfigurationError,
    );

    const missingPresetResolver = createSearchQueryModelResolver({
      catalogPath: "unused",
      presetId: "",
      reasoningEffort: "max",
    });
    expect(() => missingPresetResolver.resolve()).toThrow(
      SearchQueryModelConfigurationError,
    );
  });

  it("rejects a preset or effort that cannot run through the Codex executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "search-model-catalog-"));
    temporaryDirectories.push(directory);
    const catalogPath = join(directory, "catalog.yaml");
    await writeFile(catalogPath, `
presets:
  - id: non-codex-preset
    label: Other backend
    backend: claude
    model: other-model
    supported_efforts: [high]
  - id: codex-preset
    label: Codex backend
    backend: codex
    model: codex-model
    supported_efforts: [high]
`, "utf8");

    const nonCodexResolver = createSearchQueryModelResolver({
      catalogPath,
      presetId: "non-codex-preset",
      reasoningEffort: "high",
    });
    expect(() => nonCodexResolver.resolve()).toThrow(/must use the codex backend/);

    const unsupportedEffortResolver = createSearchQueryModelResolver({
      catalogPath,
      presetId: "codex-preset",
      reasoningEffort: "max",
    });
    expect(() => unsupportedEffortResolver.resolve()).toThrow(
      /does not support effort max/,
    );
  });
});
