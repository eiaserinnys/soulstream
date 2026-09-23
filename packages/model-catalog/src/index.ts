import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const MODEL_BACKENDS = [
  "claude",
  "codex",
  "openai-agents",
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

export const ModelPresetSchema = z.object({
  id: z.string().trim().min(1, "model preset id required"),
  label: z.string().trim().min(1, "model preset label required"),
  backend: AgentBackendSchema,
  model: z.string().trim().min(1, "model preset model required"),
  env: z.record(z.string(), z.string()).optional(),
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
