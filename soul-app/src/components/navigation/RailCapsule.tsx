import React from 'react';
import { Text, View, type AccessibilityRole } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GlassSurface } from '../GlassSurface';
import { useTokens } from '../../theme';

export const RAIL_CAPSULE_WIDTH = 48;
export const RAIL_ITEM_HEIGHT = 50;

export function RailCapsule({ children, testID }: { children: React.ReactNode; testID: string }) {
  const t = useTokens();
  return <GlassSurface role="chrome" testID={testID} cornerRadius={t.foundation.radius.round}
    style={{ width: RAIL_CAPSULE_WIDTH }}>
    <View style={{ width: RAIL_CAPSULE_WIDTH, paddingVertical: t.spacing.xs, gap: t.uiSpacing.xs / 2, alignItems: 'center' }}>
      {children}
    </View>
  </GlassSurface>;
}

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, disabled = false, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={onPress}
    style={{ width: RAIL_CAPSULE_WIDTH - 4, height: RAIL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    {children}
    {badge !== undefined && badge > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: 0, right: 0,
      ...t.foundation.typography.label, backgroundColor: t.colors.accentTint, color: t.colors.accent,
      borderRadius: t.foundation.radius.round, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{badge}</Text> : null}
  </PlatformPressable>;
}
