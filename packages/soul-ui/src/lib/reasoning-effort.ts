import type { ModelPresetAvailability } from "./model-preset-availability";

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

export function isEffortSupported(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): boolean {
  if (!selected) return true;
  return effortOptionsForPreset(preset).includes(selected);
}

export function reasoningEffortForSubmit(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): string | undefined {
  if (!selected) return undefined;
  return isEffortSupported(preset, selected) ? selected : undefined;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X High",
  max: "Max",
  ultra: "Ultra",
};

export function reasoningEffortLabel(value: string): string {
  return REASONING_EFFORT_LABELS[value] ?? value;
}
