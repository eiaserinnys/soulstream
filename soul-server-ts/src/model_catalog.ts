import fs from "node:fs";

import {
  ModelCatalogSchema,
  parseModelCatalogYaml,
  resolveModelPreset,
  UnknownModelPresetError,
  type ModelCatalogConfig,
  type ModelPreset,
} from "@soulstream/model-catalog";
import type { AgentBackend } from "@soulstream/model-catalog";
import type { ReasoningEffort } from "@soulstream/model-catalog";

import {
  claudeTransportEfforts,
  codexTransportEfforts,
} from "./engine/effort_boundary.js";
import {
  ANTHROPIC_API_KEY_ENV,
  isModelPresetEnvResolvable,
} from "./model_preset_env.js";

export {
  ModelCatalogSchema,
  ModelPresetSchema,
  parseModelCatalogYaml,
  resolveModelPreset,
  UnknownModelPresetError,
} from "@soulstream/model-catalog";
export type {
  AgentBackend,
  ModelCatalogConfig,
  ModelPreset,
  ReasoningEffort,
} from "@soulstream/model-catalog";

/**
 * A non-empty list of efforts, spelled the way the wire contract states it
 * (`minItems: 1`). zod v4's `.nonempty()` only adds a runtime check — it still
 * infers a plain array — so the advertised surface carries this type instead and
 * {@link toAdvertisedEfforts} is the one place the two meet.
 */
export type AdvertisedEfforts = [ReasoningEffort, ...ReasoningEffort[]];

/**
 * Absent, never `[]`: "no advertised effort choices" is expressed by omitting the
 * field, which is exactly what the wire schema allows.
 */
function toAdvertisedEfforts(
  efforts: readonly ReasoningEffort[] | undefined,
): AdvertisedEfforts | undefined {
  if (!efforts) return undefined;
  const [head, ...tail] = efforts;
  return head === undefined ? undefined : [head, ...tail];
}

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
  /**
   * Advertised effort levels. Absent means this preset has no effort control;
   * present means at least one level, which is what the wire contract states
   * (`minItems: 1`) — hence the non-empty tuple rather than a plain array.
   */
  supported_efforts?: AdvertisedEfforts;
  /** Advertised default effort. Absent means the backend default applies. */
  default_effort?: ReasoningEffort;
}

export interface ModelCatalogLogger {
  error(bindings: Record<string, unknown>, message: string): void;
  warn?(bindings: Record<string, unknown>, message: string): void;
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
    const narrowed = toAdvertisedEfforts(supported);
    const { supported_efforts: _s, ...rest } = preset;
    return {
      ...rest,
      ...(narrowed ? { supported_efforts: narrowed } : {}),
    };
  }

  resolve(presetId: string): ModelPreset {
    return this.narrowEfforts(resolveModelPreset(this.read(), presetId));
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
      const advertisedEfforts = toAdvertisedEfforts(preset.supported_efforts);
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
        ...(advertisedEfforts ? { supported_efforts: advertisedEfforts } : {}),
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
      const config = parseModelCatalogYaml(raw);
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
