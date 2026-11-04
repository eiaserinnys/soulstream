import React from 'react';
import { Text, View, type AccessibilityRole } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GLASS_BUTTON_BORDER_WIDTH, GlassSurface } from '../GlassSurface';
import { useTokens } from '../../theme';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

export const RAIL_CAPSULE_WIDTH = 48;
export const RAIL_ITEM_HEIGHT = 50;
export function railCapsuleHeight(count: number, compact: boolean, tokens: { spacingXs: number; uiSpacingXs: number; hitTargetMin: number }) {
  if (count === 0) return 0;
  if (count === 1) return RAIL_CAPSULE_WIDTH;
  return compact ? count * tokens.hitTargetMin + GLASS_BUTTON_BORDER_WIDTH
    : count * RAIL_ITEM_HEIGHT + (count - 1) * tokens.uiSpacingXs / 2 + 2 * tokens.spacingXs + GLASS_BUTTON_BORDER_WIDTH;
}
const RailCapsuleItemContext = React.createContext({ compact: false, single: false });

function countRailCapsuleItems(children: React.ReactNode): number {
  return React.Children.toArray(children).filter(Boolean).reduce<number>((count, child) => {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      return count + countRailCapsuleItems((child.props as { children?: React.ReactNode }).children);
    }
    return count + 1;
  }, 0);
}

export function RailCapsule({ children, testID, compact = false }: {
  children: React.ReactNode; testID: string; compact?: boolean;
}) {
  const t = useTokens();
  const single = countRailCapsuleItems(children) === 1;
  const content = <View style={{ width: RAIL_CAPSULE_WIDTH,
    ...(single ? { height: RAIL_CAPSULE_WIDTH, paddingVertical: 0, gap: 0, justifyContent: 'center' as const }
      : { paddingVertical: compact ? 0 : t.spacing.xs, gap: compact ? 0 : t.uiSpacing.xs / 2 }),
    alignItems: 'center' }}>
    <RailCapsuleItemContext.Provider value={{ compact, single }}>{children}</RailCapsuleItemContext.Provider>
  </View>;
  return <GlassSurface role="chrome" testID={testID} cornerRadius={t.foundation.radius.round}
    style={{ width: RAIL_CAPSULE_WIDTH, height: railCapsuleHeight(countRailCapsuleItems(children), compact,
      { spacingXs: t.spacing.xs, uiSpacingXs: t.uiSpacing.xs, hitTargetMin: t.hitTarget.min }) }}>
    {content}
  </GlassSurface>;
}

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, badgeCount, dot, disabled = false, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; badgeCount?: number; dot?: boolean; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  const { compact, single } = React.useContext(RailCapsuleItemContext);
  const count = badgeCount ?? badge;
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={disabled ? undefined : onPress}
    style={{ width: single ? RAIL_CAPSULE_WIDTH : RAIL_CAPSULE_WIDTH - 4,
      height: single ? RAIL_CAPSULE_WIDTH : compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT,
      alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    <View style={{ position: 'relative' }}>
      {children}
      {count && count > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: -t.spacing.xxs, right: -t.spacing.xxs,
        ...t.foundation.typography.label, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.accentTint,
        color: t.colors.accent, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{count}</Text>
        : dot ? <View testID={`${testID}-dot`} style={{ position: 'absolute', top: 0, right: 0, width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: t.colors.accent }} /> : null}
    </View>
  </PlatformPressable>;
}
