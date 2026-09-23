import { readFileSync } from "node:fs";

import {
  MODEL_REASONING_EFFORTS,
  parseModelCatalogYaml,
  resolveModelPreset,
} from "@soulstream/model-catalog";

import type { CodexReasoningEffort } from "../llm/codex_ephemeral_executor.js";

export type SearchQueryModel = {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
};

export type SearchQueryModelResolver = {
  readonly resolve: () => SearchQueryModel;
};

export type CreateSearchQueryModelResolverOptions = {
  readonly catalogPath: string | null | undefined;
  readonly presetId: string | null | undefined;
  readonly reasoningEffort: string | null | undefined;
  readonly onConfigurationError?: (error: SearchQueryModelConfigurationError) => void;
};

export class SearchQueryModelConfigurationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SearchQueryModelConfigurationError";
  }
}

export function createSearchQueryModelResolver(
  options: CreateSearchQueryModelResolverOptions,
): SearchQueryModelResolver {
  let resolved: SearchQueryModel | undefined;
  let configurationError: SearchQueryModelConfigurationError | undefined;
  try {
    const catalogPath = requireSetting(options.catalogPath, "MODEL_CATALOG_PATH");
    const presetId = requireSetting(
      options.presetId,
      "SEARCH_QUERY_EXPANSION_PRESET_ID",
    );
    const effort = requireSetting(
      options.reasoningEffort,
      "SEARCH_QUERY_EXPANSION_EFFORT",
    );
    if (!(MODEL_REASONING_EFFORTS as readonly string[]).includes(effort)) {
      throw new SearchQueryModelConfigurationError(
        `Unsupported search query expansion reasoning effort: ${effort}`,
      );
    }
    const catalog = parseModelCatalogYaml(readFileSync(catalogPath, "utf8"));
    const preset = resolveModelPreset(catalog, presetId);
    if (preset.backend !== "codex") {
      throw new SearchQueryModelConfigurationError(
        `Search query expansion preset ${presetId} must use the codex backend`,
      );
    }
    if (!preset.supported_efforts?.includes(effort as CodexReasoningEffort)) {
      throw new SearchQueryModelConfigurationError(
        `Search query expansion preset ${presetId} does not support effort ${effort}`,
      );
    }
    resolved = {
      model: preset.model,
      reasoningEffort: effort as CodexReasoningEffort,
    };
  } catch (error) {
    configurationError = error instanceof SearchQueryModelConfigurationError
      ? error
      : new SearchQueryModelConfigurationError(
          `Search query expansion model configuration could not be loaded: ${errorMessage(error)}`,
          error,
        );
    options.onConfigurationError?.(configurationError);
  }

  return {
    resolve() {
      if (configurationError) throw configurationError;
      if (!resolved) {
        throw new SearchQueryModelConfigurationError(
          "Search query expansion model configuration is unavailable",
        );
      }
      return resolved;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSetting(value: string | null | undefined, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SearchQueryModelConfigurationError(
      `${name} is required for search query expansion`,
    );
  }
  return value.trim();
}
