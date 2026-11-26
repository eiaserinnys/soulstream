import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { normalizePricedModelId } from "./inference_pricing.js";

export {
  MODEL_PRESET_WEEKLY_HEADROOM_FLOOR_PERCENT,
  chooseUsablePresetId,
  type UsablePresetCandidate,
} from "./preset_selection.js";

export const MODEL_BACKENDS = [
  "claude",
  "codex",
  "antigravity",
  "opencode",
] as const;

export const MODEL_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/**
 * Usage-statistics providers a preset can be attributed to. A preset without an
 * explicit value falls back to its backend when that backend is also a provider
 * and to `unknown` otherwise.
 */
export const MODEL_PRESET_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "deepseek",
] as const;

export const AgentBackendSchema = z.enum(MODEL_BACKENDS);
export type AgentBackend = (typeof MODEL_BACKENDS)[number];
export type ReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];
export type ModelPresetProvider = (typeof MODEL_PRESET_PROVIDERS)[number];
export type ResolvedModelPresetProvider = ModelPresetProvider | "unknown";

const ReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);
const NonEmptyMcpNameSchema = z.string().trim().min(1);

export const ModelPresetSchema = z.object({
  id: z.string().trim().min(1, "model preset id required").refine(id => id !== "default", "default is a reserved model preset id"),
  label: z.string().trim().min(1, "model preset label required"),
  backend: AgentBackendSchema,
  model: z.string().trim().min(1, "model preset model required"),
  /** Node opt-in group. Presets without a group are always available. */
  group: z.string().trim().min(1).optional(),
  /** Usage-statistics provider attributed to runs of this preset. */
  provider: z.enum(MODEL_PRESET_PROVIDERS).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Only a literal boolean `true` marks a preset as trusted for unrestricted
   * execution. An absent field, `false`, or any string value is untrusted.
   */
  trusted_execution: z.boolean().optional(),
  mcp_tool_allowlist: z.record(
    NonEmptyMcpNameSchema,
    z.record(NonEmptyMcpNameSchema, z.array(NonEmptyMcpNameSchema)),
  ).optional(),
  usage_model_id: z.string().trim().min(1).optional(),
  /**
   * Token window this preset's backend serves. The Claude SDK result mapper
   * falls back to it when a result message omits `contextWindow`.
   */
  context_window: z.number().int().positive().optional(),
  /** Reported model names (exact, case-insensitive) that use `context_window`. */
  context_window_aliases: z.array(z.string().trim().min(1)).optional(),
  /** Reported model-name prefixes (case-insensitive) that use `context_window`. */
  context_window_prefixes: z.array(z.string().trim().min(1)).optional(),
  /** Subscription usage source joined by the orchestrator usage overlay. */
  usage_provider: z.literal("opencode_go").optional(),
  supported_efforts: z.array(ReasoningEffortSchema).nonempty().optional(),
  default_effort: ReasoningEffortSchema.optional(),
  persistent_decision: z.object({
    // JSON represents an infinite bound as null; restore it on catalog reload.
    first_call_cache_bins: z.array(z.tuple([
      z.union([z.number(), z.literal(Infinity), z.null().transform(() => Infinity)]),
      z.number(), z.number(), z.number(),
    ])).optional(),
    generation_cost_seed: z.object({
      baselineTokens: z.number(), growthTokensPerCall: z.number(),
      input: z.number(), cached: z.number(), output: z.number(), reasoning: z.number(),
      source: z.string().trim().min(1), sampleCount: z.number(),
    }).optional(),
  }).optional(),
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

/** USD per 1M tokens. `null` means the component has no known published rate. */
const ModelRateSchema = z.number().finite().nonnegative().nullable();

export const ModelCatalogRatesSchema = z.object({
  input: ModelRateSchema,
  cache_read: ModelRateSchema,
  cache_write_5m: ModelRateSchema,
  cache_write_1h: ModelRateSchema,
  output: ModelRateSchema,
});
export type ModelCatalogRates = z.infer<typeof ModelCatalogRatesSchema>;

export const ModelCatalogModelSchema = z.object({
  provider: z.enum(MODEL_PRESET_PROVIDERS),
  model: z.string().trim().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]),
  display_name: z.string().trim().min(1).optional(),
  /** `null` keeps the row for provider and display lookup without a price. */
  rates: ModelCatalogRatesSchema.nullable(),
  source: z.string().trim().min(1).optional(),
});
export type ModelCatalogModel = z.infer<typeof ModelCatalogModelSchema>;

export const PriceSnapshotMetadataSchema = z.object({
  price_version: z.string().trim().min(1),
  as_of: z.string().trim().min(1),
  checked_at: z.string().trim().min(1),
  currency: z.string().trim().min(1),
  unit: z.string().trim().min(1),
  model_mapping_version: z.string().trim().min(1),
  legacy_rows_last_checked_at: z.string().trim().min(1).optional(),
  refreshed_model_rows: z.record(z.string(), z.array(z.string().trim().min(1))),
  sources: z.record(z.string(), z.string().trim().min(1)),
  assumptions: z.array(z.string()),
});
export type PriceSnapshotMetadata = z.infer<typeof PriceSnapshotMetadataSchema>;

export const PersistentModelDefaultSchema = z.object({
  model_preset: z.string().trim().min(1),
  reasoning_effort: z.string().trim().min(1).nullable(),
});
export type PersistentModelDefault = z.infer<typeof PersistentModelDefaultSchema>;

export const PersistentDefaultsSchema = z.object({
  model_preset: z.string().trim().min(1),
  fallback_models: z.array(PersistentModelDefaultSchema.strict()),
}).strict();
export type PersistentDefaults = z.infer<typeof PersistentDefaultsSchema>;

/** Shared cross-field rules for catalogue defaults and administrator settings. */
export function persistentDefaultsIssues(
  defaults: PersistentDefaults,
  presets: readonly ModelPreset[],
): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const seen = new Set<string>();
  const candidates = [{ model_preset: defaults.model_preset, reasoning_effort: null }, ...defaults.fallback_models];
  for (const [index, candidate] of candidates.entries()) {
    const path = index === 0 ? ["model_preset"] : ["fallback_models", index - 1, "model_preset"];
    const preset = presets.find((entry) => entry.id === candidate.model_preset);
    if (!preset) {
      const field = index === 0 ? "persistent_defaults.model_preset" : `persistent_defaults.fallback_models[${index - 1}]`;
      issues.push({ path, message: `${field} "${candidate.model_preset}" is not a known model preset` });
    }
    if (seen.has(candidate.model_preset)) issues.push({ path, message: `Duplicate model preset: ${candidate.model_preset}` });
    seen.add(candidate.model_preset);
    if (candidate.reasoning_effort !== null && preset && !preset.supported_efforts?.includes(candidate.reasoning_effort as ReasoningEffort)) {
      issues.push({ path: ["fallback_models", index - 1, "reasoning_effort"], message: `Unsupported reasoning effort for ${candidate.model_preset}` });
    }
  }
  return issues;
}

export const PersistentCatalogDefaultsSchema = z.object({
  agent_id: z.string().trim().min(1).optional(),
  model_preset: z.string().trim().min(1),
  fallback_models: z.array(PersistentModelDefaultSchema).default([]),
});
export type PersistentCatalogDefaults = z.infer<typeof PersistentCatalogDefaultsSchema>;

const InstallDefaultsSchema = z.object({
  backends: z.object({
    claude: z.string().trim().min(1),
    codex: z.string().trim().min(1),
    antigravity: z.string().trim().min(1),
  }),
  profiles: z.object({ "card-orchestrator": z.string().trim().min(1) }),
});

export const ModelCatalogSchema = z.object({
  schema_version: z.literal(1),
  groups: z.array(z.string().trim().min(1)),
  presets: z.array(ModelPresetSchema).default([]),
  models: z.array(ModelCatalogModelSchema),
  price_snapshot: PriceSnapshotMetadataSchema,
  persistent_defaults: PersistentCatalogDefaultsSchema,
  install_defaults: InstallDefaultsSchema.optional(),

  task_defaults: z.object({
    turn_summary: z.object({ model_preset: z.string().trim().min(1) }),
    turn_story: z.object({ model_preset: z.string().trim().min(1) }),
    instruction_extraction: z.object({ model_preset: z.string().trim().min(1) }),
  }),
  provider_model_prefixes: z.array(z.object({
    prefix: z.string().trim().min(1),
    provider: z.enum(MODEL_PRESET_PROVIDERS),
  })),
}).superRefine((catalog, ctx) => {
  const seenPresetIds = new Set<string>();
  for (const [index, preset] of catalog.presets.entries()) {
    if (seenPresetIds.has(preset.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presets", index, "id"],
        message: `Duplicate model preset id: ${preset.id}`,
      });
    }
    seenPresetIds.add(preset.id);
  }

  const declaredGroups = new Set(catalog.groups);
  for (const [index, preset] of catalog.presets.entries()) {
    if (preset.group === undefined || declaredGroups.has(preset.group)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["presets", index, "group"],
      message:
        `Model preset ${preset.id}: group "${preset.group}" is not declared in `
        + `catalog groups [${catalog.groups.join(", ")}]`,
    });
  }

  const seenModelNames = new Map<string, number>();
  for (const [index, row] of catalog.models.entries()) {
    for (const name of [row.model, ...row.aliases]) {
      const previousIndex = seenModelNames.get(name);
      if (previousIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["models", index],
          message:
            `Duplicate model or alias "${name}" in model rows ${previousIndex} and ${index}`,
        });
        continue;
      }
      seenModelNames.set(name, index);
    }
  }

  const presetIds = new Set(catalog.presets.map((preset) => preset.id));
  if (catalog.install_defaults) {
    const installDefaults = [
      ...Object.entries(catalog.install_defaults.backends).map(([backend, id]) => ({ path: ["backends", backend], backend, id })),
      { path: ["profiles", "card-orchestrator"], backend: "claude", id: catalog.install_defaults.profiles["card-orchestrator"] },
    ];
    for (const { path, backend, id } of installDefaults) {
      const preset = catalog.presets.find((entry) => entry.id === id);
      if (!preset || preset.backend !== backend) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["install_defaults", ...path], message: `Install default ${id} must name a ${backend} preset` });
      }
    }
  }
  for (const [task, value] of Object.entries(catalog.task_defaults)) {
    if (presetIds.has(value.model_preset)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["task_defaults", task, "model_preset"],
      message: `task_defaults.${task}.model_preset "${value.model_preset}" is not a known model preset`,
    });
  }
  for (const issue of persistentDefaultsIssues(catalog.persistent_defaults, catalog.presets)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["persistent_defaults", ...issue.path], message: issue.message });
  }
});

export type ModelCatalogConfig = z.infer<typeof ModelCatalogSchema>;

export class UnknownModelPresetError extends Error {
  constructor(readonly presetId: string) {
    super(`Unknown model preset: ${presetId}`);
    this.name = "UnknownModelPresetError";
  }
}

export function parseModelCatalogYaml(raw: string): ModelCatalogConfig {
  const parsed: unknown = parseYaml(raw) ?? {};
  return ModelCatalogSchema.parse(parsed);
}

export function resolveModelPreset(
  catalog: ModelCatalogConfig,
  presetId: string,
): ModelPreset {
  const preset = catalog.presets.find((entry) => entry.id === presetId);
  if (!preset) throw new UnknownModelPresetError(presetId);
  return preset;
}

/**
 * Node view of the catalogue: presets without a group are always available, and
 * grouped presets only when the node enabled their group.
 */
export function selectModelPresets(
  catalog: ModelCatalogConfig,
  enabledGroups: readonly string[],
): ModelPreset[] {
  return catalog.presets.filter(
    (preset) => preset.group === undefined || enabledGroups.includes(preset.group),
  );
}

/** Parse a comma-separated node group selection; an empty value selects no group. */
export function parseModelCatalogGroups(
  raw: string | null | undefined,
  catalog: ModelCatalogConfig,
): string[] {
  const requested = (raw ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const unique = [...new Set(requested)];
  const declared = new Set(catalog.groups);
  const unknown = unique.filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown model catalog group(s): ${unknown.join(", ")} `
      + `(declared groups: ${catalog.groups.join(", ") || "none"})`,
    );
  }
  return unique;
}

/**
 * Usage-statistics provider for one preset: the explicit field wins, otherwise
 * the backend itself when it is also a provider, otherwise `unknown`.
 */
export function resolvePresetProvider(
  preset: Pick<ModelPreset, "provider" | "backend">,
): ResolvedModelPresetProvider {
  if (preset.provider !== undefined) return preset.provider;
  if (preset.backend === "claude" || preset.backend === "codex" || preset.backend === "antigravity") {
    return preset.backend;
  }
  return "unknown";
}

/**
 * Find the model row for a runtime model string, first exactly and then once
 * through the priced-id normalization (context suffix and trailing date).
 */
export function findModelRow(
  catalog: ModelCatalogConfig,
  model: string,
): ModelCatalogModel | undefined {
  const match = (candidate: string): ModelCatalogModel | undefined => catalog.models.find(
    (row) => row.model === candidate || row.aliases.includes(candidate),
  );
  const exact = match(model);
  if (exact !== undefined) return exact;
  const normalized = normalizePricedModelId(model);
  return normalized === model ? undefined : match(normalized);
}

/** Display name from the model row, or `null` when the row has none. */
export function modelDisplayName(
  catalog: ModelCatalogConfig,
  model: string,
): string | null {
  return findModelRow(catalog, model)?.display_name ?? null;
}

/**
 * Usage-statistics provider for a runtime model string from catalogue data alone:
 * a preset running exactly that model, then a model row. `undefined` when the
 * catalogue does not know the string; callers keep their own backend fallback.
 */
export function findModelProvider(
  catalog: ModelCatalogConfig,
  model: string,
): ResolvedModelPresetProvider | undefined {
  const preset = catalog.presets.find((candidate) => candidate.model === model);
  if (preset !== undefined) return resolvePresetProvider(preset);
  return findModelRow(catalog, model)?.provider;
}

/** Validate an explicit effort against the static preset definition and apply its default. */
export function normalizeReasoningEffort(
  preset: { id: string; supported_efforts?: readonly string[]; default_effort?: string },
  requested?: string | null,
): string | null {
  if (requested != null && !preset.supported_efforts?.includes(requested as ReasoningEffort)) {
    throw new Error(`Reasoning effort "${requested}" is not supported by model preset "${preset.id}"`);
  }
  return requested ?? preset.default_effort ?? null;
}
