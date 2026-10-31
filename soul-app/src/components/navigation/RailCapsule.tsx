import React from 'react';
import { ScrollView, Text, View, type AccessibilityRole } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GlassSurface } from '../GlassSurface';
import { useTokens } from '../../theme';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

export const RAIL_CAPSULE_WIDTH = 48;
export const RAIL_ITEM_HEIGHT = 50;
const CompactRailContext = React.createContext(false);

export function RailCapsuleViewport({ children, maxHeight, testID }: { children: React.ReactNode; maxHeight?: number; testID?: string }) {
  if (maxHeight === undefined) return <>{children}</>;
  return <ScrollView testID={testID} style={{ maxHeight }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    {children}
  </ScrollView>;
}

export function RailCapsule({ children, testID, compact = false }: { children: React.ReactNode; testID: string; compact?: boolean }) {
  const t = useTokens();
  return <GlassSurface role="chrome" testID={testID} cornerRadius={t.foundation.radius.round}
    style={{ width: RAIL_CAPSULE_WIDTH }}>
    <View style={{ width: RAIL_CAPSULE_WIDTH, paddingVertical: compact ? t.spacing.xxs : t.spacing.xs, gap: compact ? 0 : t.uiSpacing.xs / 2, alignItems: 'center' }}>
      <CompactRailContext.Provider value={compact}>{children}</CompactRailContext.Provider>
    </View>
  </GlassSurface>;
}

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, badgeCount, dot, disabled = false, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; badgeCount?: number; dot?: boolean; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  const compact = React.useContext(CompactRailContext);
  const count = badgeCount ?? badge;
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={disabled ? undefined : onPress}
    style={{ width: RAIL_CAPSULE_WIDTH - 4, height: compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    <View style={{ position: 'relative' }}>
      {children}
      {count && count > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: -t.spacing.xxs, right: -t.spacing.xxs,
        ...t.foundation.typography.label, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.accentTint,
        color: t.colors.accent, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{count}</Text>
        : dot ? <View testID={`${testID}-dot`} style={{ position: 'absolute', top: 0, right: 0, width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.accent }} /> : null}
    </View>
  </PlatformPressable>;
}
