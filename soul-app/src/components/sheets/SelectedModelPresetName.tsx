import React from 'react';
import { Text } from 'react-native';
import { useTokens } from '../../theme';
import type { UseNewSessionSelectionResult } from './useNewSessionSelection';

/** Keep the automatic prefix in the surrounding text color; only the model name is red. */
export function SelectedModelPresetName({ selection }: {
  selection: Pick<UseNewSessionSelectionResult,
    'effectiveModelPreset' | 'selectedModelPresetId' | 'selectedModelPresetName'>;
}) {
  const t = useTokens();
  const preset = selection.effectiveModelPreset;
  if (preset?.reason !== 'quota_exhausted') return <>{selection.selectedModelPresetName}</>;
  const automatic = selection.selectedModelPresetId === null;
  return <>{automatic ? '자동 (' : ''}<Text style={{ color: t.colors.errorText }}>{preset.label}</Text>{automatic ? ')' : ''}</>;
}
