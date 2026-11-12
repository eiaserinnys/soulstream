import {
  ModelCatalogSchema,
  parseModelCatalogYaml,
  selectModelPresets,
  UnknownModelPresetError,
  type ModelCatalogConfig,
  type ModelPreset,
} from "@soulstream/model-catalog";
import type { ModelCatalogFileStore } from "@soulstream/model-catalog/file-loader";
import type { ReasoningEffort } from "@soulstream/model-catalog";

import {
  antigravityTransportEfforts,
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
  parseModelCatalogGroups,
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
  /** Resolved model id for orchestrator persistence during cross-node handoff. */
  model: string;
  available: boolean;
  reason?: "env_unresolved";
  /**
   * Internal server-to-server join metadata. Public model preset APIs strip it.
   * null means the preset uses its own API-key endpoint and has no usage overlay.
   */
  usage_provider: "claude" | "codex" | "antigravity" | "opencode_go" | null;
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

export interface ModelCatalogOptions {
  logger?: ModelCatalogLogger;
  effortCapabilities?: EffortCapabilities;
  /** Node opt-in groups, already resolved against the first snapshot at startup. */
  enabledGroups?: readonly string[];
}

/**
 * Node view over the shared catalogue file store. `list`, `resolve`, and
 * `advertise` only expose presets whose group this node enabled; the node
 * selection is applied before env resolution so a disabled group never appears
 * even as `env_unresolved`. {@link snapshot} exposes the unfiltered catalogue
 * for remote preset validation and usage attribution.
 */
export class ModelCatalog {
  private readonly enabledGroups: readonly string[];

  constructor(
    private readonly store: ModelCatalogFileStore,
    private readonly options: ModelCatalogOptions = {},
  ) {
    this.enabledGroups = options.enabledGroups ?? [];
  }

  list(): ModelPreset[] {
    return selectModelPresets(this.store.snapshot(), this.enabledGroups)
      .map((preset) => this.narrowEfforts(preset));
  }

  /** Full catalogue snapshot, ignoring this node's group selection. */
  snapshot(): ModelCatalogConfig {
    return this.store.snapshot();
  }

  /**
   * Intersects declared efforts with what the active transport can carry, so the
   * advertisement and the create-time validation share one list by construction.
   *
   * A `default_effort` outside that intersection is rejected by the load-time
   * validation hook, so this only ever narrows the supported list.
   */
  private narrowEfforts(preset: ModelPreset): ModelPreset {
    const capability = this.options.effortCapabilities?.[preset.backend];
    if (!capability || !preset.supported_efforts) return preset;
    const supported = preset.supported_efforts.filter((effort) =>
      capability.includes(effort),
    );
    if (supported.length === preset.supported_efforts.length) return preset;

    const dropped = preset.supported_efforts.filter(
      (effort) => !capability.includes(effort),
    );
    this.options.logger?.warn?.(
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
    const preset = selectModelPresets(this.store.snapshot(), this.enabledGroups)
      .find((candidate) => candidate.id === presetId);
    if (!preset) throw new UnknownModelPresetError(presetId);
    return this.narrowEfforts(preset);
  }

  advertise(
    processEnv: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  ): AdvertisedModelPreset[] {
    return this.list().map((preset) => {
      const available = isModelPresetEnvResolvable(preset.env, processEnv);
      const usesAnthropicApiKey = Boolean(preset.env?.[ANTHROPIC_API_KEY_ENV]);
      // An explicit usage_provider wins: the OpenCode Go preset carries an
      // Anthropic API key for its compatible endpoint but bills against Go.
      const usageProvider = preset.usage_provider
        ?? (usesAnthropicApiKey
          ? null
          : preset.backend === "claude" || preset.backend === "codex" || preset.backend === "antigravity"
            ? preset.backend
            : null);
      const advertisedEfforts = toAdvertisedEfforts(preset.supported_efforts);
      return {
        id: preset.id,
        label: preset.label,
        backend: preset.backend,
        model: preset.model,
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
}

/**
 * Catalogue validation hook: a `default_effort` the active transport cannot
 * deliver is a configuration error, not something to paper over — dropping it
 * silently would move every new session on that preset to the backend default
 * while the file still claims otherwise. It runs on the first load (startup
 * failure) and on every reload (the store keeps the last good catalogue and
 * logs once per failing signature).
 */
export function assertCatalogDefaultsDeliverable(
  catalog: ModelCatalogConfig,
  effortCapabilities?: EffortCapabilities,
): void {
  for (const preset of catalog.presets) {
    const capability = effortCapabilities?.[preset.backend];
    if (!capability || !preset.default_effort) continue;
    if (capability.includes(preset.default_effort)) continue;
    throw new Error(
      `Model preset ${preset.id}: default_effort "${preset.default_effort}" `
      + `cannot be delivered by the active ${preset.backend} transport `
      + `(it carries [${capability.join(", ")}])`,
    );
  }
}

export interface ModelCatalogReannounceTarget {
  reannounceAgentCatalog(): Promise<void>;
}

/**
 * Re-advertise the node catalogue whenever a valid replacement file loads.
 * The upstream adapter itself skips silently (with a warning) while the
 * WebSocket is closed; the next connection registration carries the latest
 * snapshot, so no retry layer is needed here.
 */
export function subscribeModelCatalogReannounce(params: {
  store: Pick<ModelCatalogFileStore, "subscribe">;
  currentAdapter(): ModelCatalogReannounceTarget | null;
  logger?: ModelCatalogLogger;
}): () => void {
  return params.store.subscribe(() => {
    const adapter = params.currentAdapter();
    if (!adapter) {
      params.logger?.warn?.(
        {},
        "Model catalog reannounce skipped — UpstreamAdapter not ready",
      );
      return;
    }
    void adapter.reannounceAgentCatalog().catch((error: unknown) => {
      params.logger?.error?.(
        { err: error },
        "Model catalog reannounce to upstream failed",
      );
    });
  });
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
    antigravity: antigravityTransportEfforts(),
  };
}
