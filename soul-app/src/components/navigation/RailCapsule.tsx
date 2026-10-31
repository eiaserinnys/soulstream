import React from 'react';
import { Text, View, type AccessibilityRole } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GlassSurface } from '../GlassSurface';
import { useTokens } from '../../theme';

export const RAIL_CAPSULE_WIDTH = 48;
export const RAIL_ITEM_HEIGHT = 50;

const CompactRailContext = React.createContext(false);

export function RailCapsule({ children, testID, compact = false }: {
  children: React.ReactNode; testID: string; compact?: boolean;
}) {
  const t = useTokens();
  return <CompactRailContext.Provider value={compact}>
    <GlassSurface role="chrome" testID={testID} cornerRadius={t.foundation.radius.round}
      style={{ width: RAIL_CAPSULE_WIDTH }}>
      <View style={{ width: RAIL_CAPSULE_WIDTH, paddingVertical: t.spacing.xs, gap: t.uiSpacing.xs / 2, alignItems: 'center' }}>
        {children}
      </View>
    </GlassSurface>
  </CompactRailContext.Provider>;
}

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, disabled = false, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  const compact = React.useContext(CompactRailContext);
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={onPress}
    style={{ width: RAIL_CAPSULE_WIDTH - 4, height: compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    {children}
    {badge !== undefined && badge > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: t.uiSpacing.xs, right: t.uiSpacing.sm,
      ...t.foundation.typography.label, backgroundColor: t.colors.accentTint, color: t.colors.accent,
      borderRadius: t.foundation.radius.round, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{badge}</Text> : null}
  </PlatformPressable>;
}
