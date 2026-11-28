import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import type { makeStyles } from './SessionSuccessionSheet.styles';

/** Same selection row for new sessions and draft cards. */
export function SessionSelectionRow({ testID, label, value, onPress, styles, disabled, accessibilityLabel, valueLines = 1 }: {
  testID?: string; label: string; value: React.ReactNode; onPress(): void;
  styles: ReturnType<typeof makeStyles>; disabled?: boolean; accessibilityLabel?: string; valueLines?: number;
}) {
  return <TouchableOpacity testID={testID} style={styles.selectionRow} onPress={onPress}
    disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
    <Text style={[styles.fieldLabel, disabled && styles.disabled]}>{label}</Text>
    <Text style={[styles.selectionValue, disabled && styles.disabled]} numberOfLines={valueLines}>{value}</Text>
  </TouchableOpacity>;
}
