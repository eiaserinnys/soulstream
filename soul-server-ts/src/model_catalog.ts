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

export class ModelCatalog {
  constructor(private readonly catalogPath: string) {}

  list(): ModelPreset[] {
    return this.read().presets;
  }

  resolve(presetId: string): ModelPreset {
    const preset = this.list().find((entry) => entry.id === presetId);
    if (!preset) {
      throw new Error(`Unknown model preset: ${presetId}`);
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
    const raw = fs.readFileSync(this.catalogPath, "utf-8");
    const parsed: unknown = parseYaml(raw) ?? {};
    return ModelCatalogSchema.parse(parsed);
  }
}
