import fs from "node:fs";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { AgentBackendSchema } from "./agent_registry.js";
import {
  claudeTransportEfforts,
  codexTransportEfforts,
} from "./engine/effort_boundary.js";
import {
  REASONING_EFFORT_ACCEPT_SET,
  type ReasoningEffort,
} from "./engine/protocol.js";
import {
  ANTHROPIC_API_KEY_ENV,
  isModelPresetEnvResolvable,
} from "./model_preset_env.js";

const ReasoningEffortSchema = z.enum(
  REASONING_EFFORT_ACCEPT_SET as unknown as [ReasoningEffort, ...ReasoningEffort[]],
);

export const ModelPresetSchema = z.object({
  id: z.string().trim().min(1, "model preset id required"),
  label: z.string().trim().min(1, "model preset label required"),
  backend: AgentBackendSchema,
  model: z.string().trim().min(1, "model preset model required"),
  env: z.record(z.string(), z.string()).optional(),
  usage_model_id: z.string().trim().min(1).optional(),
  /**
   * Effort levels this preset's model actually advertises. Canonical source for
   * what a client may offer and what a create request may ask for. Omit when the
   * model does not support effort at all — clients then show "auto (backend
   * default)" instead of inventing a list.
   */
  supported_efforts: z.array(ReasoningEffortSchema).nonempty().optional(),
  /** Effort applied when a create request does not specify one. */
  default_effort: ReasoningEffortSchema.optional(),
}).superRefine((preset, ctx) => {
  if (preset.default_effort === undefined) return;
  if (preset.supported_efforts === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default_effort"],
      message:
        `Model preset ${preset.id}: default_effort requires supported_efforts`,
    });
    return;
  }
  if (!preset.supported_efforts.includes(preset.default_effort)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["default_effort"],
      message:
        `Model preset ${preset.id}: default_effort "${preset.default_effort}" `
        + `is not in supported_efforts [${preset.supported_efforts.join(", ")}]`,
    });
  }
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
  /** Advertised effort levels. Absent means this preset has no effort control. */
  supported_efforts?: ReasoningEffort[];
  /** Advertised default effort. Absent means the backend default applies. */
  default_effort?: ReasoningEffort;
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

/**
 * Per-backend limit on what this node can actually deliver. A preset may declare
 * an effort the running transport cannot express; narrowing here means the
 * advertisement and the create-time validation share one list by construction.
 */
export type EffortCapabilities = Partial<
  Record<ModelPreset["backend"], readonly ReasoningEffort[]>
>;

export class ModelCatalog {
  private lastSuccessfulConfig: ModelCatalogConfig | undefined;

  constructor(
    private readonly catalogPath: string,
    private readonly logger?: ModelCatalogLogger,
    private readonly effortCapabilities?: EffortCapabilities,
  ) {}

  list(): ModelPreset[] {
    return this.read().presets.map((preset) => this.narrowEfforts(preset));
  }

  /**
   * Intersects declared efforts with what the active transport can carry, so the
   * advertisement and the create-time validation share one list by construction.
   *
   * A `default_effort` outside that intersection is rejected in {@link read}, at
   * parse time, so this only ever narrows the supported list.
   */
  private narrowEfforts(preset: ModelPreset): ModelPreset {
    const capability = this.effortCapabilities?.[preset.backend];
    if (!capability || !preset.supported_efforts) return preset;
    const supported = preset.supported_efforts.filter((effort) =>
      capability.includes(effort),
    );
    if (supported.length === preset.supported_efforts.length) return preset;

    const dropped = preset.supported_efforts.filter(
      (effort) => !capability.includes(effort),
    );
    this.logger?.warn?.(
      { presetId: preset.id, backend: preset.backend, dropped },
      "Model preset advertises efforts the active transport cannot carry",
    );
    const { supported_efforts: _s, ...rest } = preset;
    return {
      ...rest,
      ...(supported.length > 0
        ? { supported_efforts: supported as ModelPreset["supported_efforts"] }
        : {}),
    };
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
        ...(preset.supported_efforts
          ? { supported_efforts: [...preset.supported_efforts] }
          : {}),
        ...(preset.default_effort
          ? { default_effort: preset.default_effort }
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
      this.assertDefaultsAreDeliverable(config);
      this.lastSuccessfulConfig = config;
      return config;
    } catch (error) {
      return this.lastSuccessfulOrThrow(error);
    }
  }

  /**
   * A `default_effort` the active transport cannot deliver is a configuration
   * error, not something to paper over: dropping it silently would move every new
   * session on that preset to the backend default while the file still claims
   * otherwise. It is raised here, with the rest of config validation, so a bad
   * *reload* degrades to the last good catalogue instead of taking the node down
   * mid-flight, and a bad catalogue at startup is a hard startup failure.
   */
  private assertDefaultsAreDeliverable(config: ModelCatalogConfig): void {
    for (const preset of config.presets) {
      const capability = this.effortCapabilities?.[preset.backend];
      if (!capability || !preset.default_effort) continue;
      if (capability.includes(preset.default_effort)) continue;
      throw new Error(
        `Model preset ${preset.id}: default_effort "${preset.default_effort}" `
        + `cannot be delivered by the active ${preset.backend} transport `
        + `(it carries [${capability.join(", ")}])`,
      );
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
  effortCapabilities?: EffortCapabilities,
): ModelCatalog {
  const missingAtStartup = !fs.existsSync(catalogPath);
  const catalog = new ModelCatalog(catalogPath, logger, effortCapabilities);
  // Parses the file, so a malformed catalogue or an undeliverable default_effort
  // fails here rather than on the first session.
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

/**
 * Effort capability of this node, derived from the transports it will actually
 * run. Both catalogue construction sites use this so a node can never advertise
 * an effort its own engine cannot deliver.
 */
export function nodeEffortCapabilities(
  codexAdapterMode: "sdk" | "app-server",
): EffortCapabilities {
  return {
    claude: claudeTransportEfforts(),
    codex: codexTransportEfforts(codexAdapterMode),
  };
}
