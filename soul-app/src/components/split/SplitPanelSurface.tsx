import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { AppGlassCard } from '../AppGlassCard';

export function SplitPanelSurface({
  children,
  style,
  testID,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID: string;
}) {
  return (
    <AppGlassCard role="glassSoft" style={[styles.panel, style]} testID={testID}>
      {children}
    </AppGlassCard>
  );
}

const styles = StyleSheet.create({
  panel: {
    height: '100%',
    overflow: 'hidden',
  },
});
