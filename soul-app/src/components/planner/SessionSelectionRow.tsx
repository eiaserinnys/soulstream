import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import type { makeStyles } from './SessionSuccessionSheet.styles';

/** Same selection row for new sessions and draft cards. */
export function SessionSelectionRow({ testID, label, value, onPress, styles, disabled, accessibilityLabel }: {
  testID?: string; label: string; value: string; onPress(): void;
  styles: ReturnType<typeof makeStyles>; disabled?: boolean; accessibilityLabel?: string;
}) {
  return <TouchableOpacity testID={testID} style={styles.selectionRow} onPress={onPress}
    disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <Text style={styles.selectionValue} numberOfLines={1}>{value}</Text>
  </TouchableOpacity>;
}
