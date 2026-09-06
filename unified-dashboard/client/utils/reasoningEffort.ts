import type { ModelPresetAvailability } from "@seosoyoung/soul-ui";

/**
 * Everything about "which efforts exist" comes from the model preset the node
 * advertised. There is deliberately no client-side table of models or defaults:
 * the node's `model-catalog.yaml` is the single source of truth, and a preset
 * that advertises nothing renders as "auto (backend default)".
 */
export type EffortPreset = Pick<
  ModelPresetAvailability,
  "supported_efforts" | "default_effort"
>;

export function effortOptionsForPreset(
  preset: EffortPreset | null | undefined,
): readonly string[] {
  const supported = preset?.supported_efforts;
  return supported && supported.length > 0 ? supported : [];
}

/** True when the preset offers an effort choice at all. */
export function presetSupportsEffort(
  preset: EffortPreset | null | undefined,
): boolean {
  return effortOptionsForPreset(preset).length > 0;
}

export function defaultEffortForPreset(
  preset: EffortPreset | null | undefined,
): string | undefined {
  return preset?.default_effort;
}

/**
 * True when a previously chosen value is still offered by the current preset.
 * A false result must prompt re-selection — never a silent substitution.
 */
export function isEffortSupported(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): boolean {
  if (!selected) return true;
  return effortOptionsForPreset(preset).includes(selected);
}

/**
 * Value to put on the create request. Omitting it makes the node apply the
 * preset default, so an unset or unsupported selection is sent as `undefined`
 * rather than being quietly rewritten to another level.
 */
export function reasoningEffortForSubmit(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): string | undefined {
  if (!selected) return undefined;
  return isEffortSupported(preset, selected) ? selected : undefined;
}

export function selectedAgentBackend<
  T extends { id: string; backend?: string | null },
>(agents: T[], selectedAgentId: string): string | null {
  if (!selectedAgentId) return null;
  return agents.find((agent) => agent.id === selectedAgentId)?.backend ?? null;
}
