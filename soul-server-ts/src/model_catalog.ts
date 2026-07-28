import fs from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { AgentBackendSchema } from "./agent_registry.js";
import {
  ANTHROPIC_API_KEY_ENV,
  isModelPresetEnvResolvable,
} from "./model_preset_env.js";

export const ModelPresetSchema = z.object({
  id: z.string().trim().min(1, "model preset id required"),
  label: z.string().trim().min(1, "model preset label required"),
  backend: AgentBackendSchema,
  model: z.string().trim().min(1, "model preset model required"),
  env: z.record(z.string(), z.string()).optional(),
  usage_model_id: z.string().trim().min(1).optional(),
});

export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const ModelCatalogSchema = z.object({
  presets: z.array(ModelPresetSchema).default([]),
}).superRefine((catalog, ctx) => {
  const seen = new Set<string>();
  for (const [index, preset] of catalog.presets.entries()) {
    if (seen.has(preset.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presets", index, "id"],
        message: `Duplicate model preset id: ${preset.id}`,
      });
    }
    seen.add(preset.id);
  }
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogSchema>;

export interface AdvertisedModelPreset {
  id: string;
  label: string;
  backend: ModelPreset["backend"];
  available: boolean;
  reason?: "env_unresolved";
  /**
   * Internal server-to-server join metadata. Public model preset APIs strip it.
   * null means the preset uses its own API-key endpoint and has no usage overlay.
   */
  usage_provider: "claude" | "codex" | null;
  usage_model_id?: string;
}

export interface ModelCatalogLogger {
  error(bindings: Record<string, unknown>, message: string): void;
  warn?(bindings: Record<string, unknown>, message: string): void;
}

export class UnknownModelPresetError extends Error {
  constructor(readonly presetId: string) {
    super(`Unknown model preset: ${presetId}`);
    this.name = "UnknownModelPresetError";
  }
}

export class ModelCatalog {
  private lastSuccessfulConfig: ModelCatalogConfig | undefined;

  constructor(
    private readonly catalogPath: string,
    private readonly logger?: ModelCatalogLogger,
  ) {}

  list(): ModelPreset[] {
    return this.read().presets;
  }

  resolve(presetId: string): ModelPreset {
    const preset = this.list().find((entry) => entry.id === presetId);
    if (!preset) {
      throw new UnknownModelPresetError(presetId);
    }
    return preset;
  }

  advertise(
    processEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  ): AdvertisedModelPreset[] {
    return this.list().map((preset) => {
      const available = isModelPresetEnvResolvable(preset.env, processEnv);
      const usesAnthropicApiKey = Boolean(preset.env?.[ANTHROPIC_API_KEY_ENV]);
      const usageProvider = usesAnthropicApiKey
        ? null
        : preset.backend === "claude" || preset.backend === "codex"
          ? preset.backend
          : null;
      return {
        id: preset.id,
        label: preset.label,
        backend: preset.backend,
        available,
        ...(!available ? { reason: "env_unresolved" as const } : {}),
        usage_provider: usageProvider,
        ...(usageProvider
          ? { usage_model_id: preset.usage_model_id ?? preset.model }
          : {}),
      };
    });
  }

  private read(): ModelCatalogConfig {
    let raw: string;
    try {
      raw = fs.readFileSync(this.catalogPath, "utf-8");
    } catch (error) {
      if (isMissingFileError(error)) {
        const empty = { presets: [] };
        this.lastSuccessfulConfig ??= empty;
        return empty;
      }
      return this.lastSuccessfulOrThrow(error);
    }
    try {
      const parsed: unknown = parseYaml(raw) ?? {};
      const config = ModelCatalogSchema.parse(parsed);
      this.lastSuccessfulConfig = config;
      return config;
    } catch (error) {
      return this.lastSuccessfulOrThrow(error);
    }
  }

  private lastSuccessfulOrThrow(error: unknown): ModelCatalogConfig {
    if (!this.lastSuccessfulConfig) throw error;
    this.logger?.error(
      { err: error, catalogPath: this.catalogPath },
      "Model catalog reload failed; using the last successful catalog",
    );
    return this.lastSuccessfulConfig;
  }
}

/**
 * Startup preflight. A missing file is the additive empty-catalog state, while
 * malformed or unreadable configured files remain explicit startup failures.
 */
export function loadModelCatalog(
  catalogPath: string,
  logger?: ModelCatalogLogger,
): ModelCatalog {
  const missingAtStartup = !fs.existsSync(catalogPath);
  const catalog = new ModelCatalog(catalogPath, logger);
  catalog.list();
  if (missingAtStartup) {
    logger?.warn?.(
      { path: catalogPath },
      "model catalog not found; advertising no presets",
    );
  }
  return catalog;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}
