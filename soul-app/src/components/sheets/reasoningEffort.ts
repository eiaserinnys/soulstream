import type { ModelPresetAvailability } from '../../api/nodeEndpoints';

/**
 * Effort choices come from the model preset the node advertised — never from a
 * table in the app. A preset that advertises nothing renders as
 * "자동 (백엔드 기본값)".
 */
export type EffortPreset = Pick<
  ModelPresetAvailability,
  'supported_efforts' | 'default_effort'
>;

const EFFORT_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X High',
  max: 'Max',
  ultra: 'Ultra',
};

export const AUTO_EFFORT_LABEL = '자동 (백엔드 기본값)';

export function reasoningEffortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value;
}

export function effortOptionsForPreset(
  preset: EffortPreset | null | undefined,
): string[] {
  const supported = preset?.supported_efforts;
  return supported && supported.length > 0 ? [...supported] : [];
}

export function presetSupportsEffort(
  preset: EffortPreset | null | undefined,
): boolean {
  return effortOptionsForPreset(preset).length > 0;
}

export function defaultEffortForPreset(
  preset: EffortPreset | null | undefined,
): string | null {
  return preset?.default_effort ?? null;
}

export function isEffortSupported(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): boolean {
  if (!selected) return true;
  return effortOptionsForPreset(preset).includes(selected);
}

/**
 * Value shown in the row: the manual pick, else the preset default, else the
 * auto placeholder.
 */
export function effortRowValue(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): string {
  const effective = selected ?? defaultEffortForPreset(preset);
  return effective ? reasoningEffortLabel(effective) : AUTO_EFFORT_LABEL;
}

/**
 * Value to send. Omitting it makes the node apply the preset default, so an
 * unsupported carry-over is dropped rather than quietly rewritten.
 */
export function reasoningEffortForSubmit(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): string | undefined {
  if (!selected) return undefined;
  return isEffortSupported(preset, selected) ? selected : undefined;
}

export interface EffortActionSheet {
  options: string[];
  cancelButtonIndex: number;
  title: string;
}

/** Index 0 is the auto sentinel, mirroring the node/agent/model pickers. */
export function buildEffortActionSheet(
  preset: EffortPreset | null | undefined,
): EffortActionSheet {
  const options = ['자동', ...effortOptionsForPreset(preset).map(reasoningEffortLabel)];
  return {
    options: [...options, '취소'],
    cancelButtonIndex: options.length,
    title: 'Reasoning effort',
  };
}

export function resolveEffortActionSheetSelection(
  preset: EffortPreset | null | undefined,
  index: number,
): string | null | undefined {
  if (index === 0) return null;
  const efforts = effortOptionsForPreset(preset);
  const picked = efforts[index - 1];
  return picked ?? undefined;
}
