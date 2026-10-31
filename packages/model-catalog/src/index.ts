import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const MODEL_BACKENDS = [
  "claude",
  "codex",
  "openai-agents",
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

export const AgentBackendSchema = z.enum(MODEL_BACKENDS);
export type AgentBackend = (typeof MODEL_BACKENDS)[number];
export type ReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

const ReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);
const NonEmptyMcpNameSchema = z.string().trim().min(1);

export const ModelPresetSchema = z.object({
  id: z.string().trim().min(1, "model preset id required"),
  label: z.string().trim().min(1, "model preset label required"),
  backend: AgentBackendSchema,
  model: z.string().trim().min(1, "model preset model required"),
  env: z.record(z.string(), z.string()).optional(),
  mcp_tool_allowlist: z.record(
    NonEmptyMcpNameSchema,
    z.record(NonEmptyMcpNameSchema, z.array(NonEmptyMcpNameSchema)),
  ).optional(),
  usage_model_id: z.string().trim().min(1).optional(),
  supported_efforts: z.array(ReasoningEffortSchema).nonempty().optional(),
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

/** Shared static fallback for validating presets that belong to an unconnected node. */
export const DEFAULT_MODEL_CATALOG: ModelCatalogConfig = {
  presets: [
    { id: "claude-sonnet", label: "Claude - Sonnet", backend: "claude", model: "sonnet", supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "xhigh" },
    { id: "claude-opus", label: "Claude - Opus", backend: "claude", model: "opus", supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "xhigh" },
    { id: "claude-fable", label: "Claude - Fable", backend: "claude", model: "claude-fable-5-1[1m]", usage_model_id: "fable", supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "high" },
    { id: "codex-6-astra", label: "Codex - 6 Astra", backend: "codex", model: "gpt-6-astra", supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "medium" },
    { id: "codex-6.1-sol", label: "Codex - 6.1 Sol", backend: "codex", model: "gpt-6.1-sol", supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "high" },
    { id: "codex-6-sol", label: "Codex - 6 Sol", backend: "codex", model: "gpt-6-sol", supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "xhigh" },
    { id: "codex-6-luna", label: "Codex - 6 Luna", backend: "codex", model: "gpt-6-luna", supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "xhigh" },
    { id: "codex-5.6-sol", label: "Codex - 5.6 Sol", backend: "codex", model: "gpt-5.6-sol", supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "xhigh" },
    { id: "codex-5.6-luna", label: "Codex - 5.6 Luna", backend: "codex", model: "gpt-5.6-luna", supported_efforts: ["low", "medium", "high", "xhigh", "max"], default_effort: "xhigh" },
    { id: "codex-5.6-terra", label: "Codex - 5.6 Terra", backend: "codex", model: "gpt-5.6-terra", supported_efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], default_effort: "xhigh" },
    { id: "kimi-2", label: "Kimi - 2", backend: "claude", model: "kimi-for-coding" },
    { id: "kimi-3", label: "Kimi - 3", backend: "claude", model: "k3" },
    { id: "gemini-3.8-flash", label: "Gemini - 3.8 Flash", backend: "antigravity", model: "gemini-3.8-flash", supported_efforts: ["low", "medium", "high"], default_effort: "low" },
    { id: "gemini-4-argon", label: "Gemini - 4 Argon", backend: "antigravity", model: "gemini-4-argon", supported_efforts: ["low", "medium", "high"], default_effort: "high" },
    { id: "opencode-deepseek-v4.1-flash-free", label: "OpenCode - DeepSeek V4.1 Flash Free", backend: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
  ],
};

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
