import React from 'react';
import { View, type AccessibilityRole } from 'react-native';
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

export function RailCapsuleItem({ children, testID, label, onPress, selected, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; role?: AccessibilityRole;
}) {
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={selected === undefined ? undefined : { selected }} onPress={onPress}
    style={{ width: RAIL_CAPSULE_WIDTH - 4, height: RAIL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center' }}>
    {children}
  </PlatformPressable>;
}
