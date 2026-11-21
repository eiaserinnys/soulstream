import { defaultEffortForPreset, effortOptionsForPreset, reasoningEffortLabel, type EffortPreset } from '../../../../packages/soul-ui/src/lib/reasoning-effort';

export const AUTO_EFFORT_LABEL = '자동 (백엔드 기본값)';

export function effortRowValue(
  preset: EffortPreset | null | undefined,
  selected: string | null | undefined,
): string {
  const effective = selected ?? defaultEffortForPreset(preset);
  return effective ? reasoningEffortLabel(effective) : AUTO_EFFORT_LABEL;
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
