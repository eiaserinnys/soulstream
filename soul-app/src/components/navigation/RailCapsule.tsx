import React from 'react';
import { PlatformColor, Text, View, type AccessibilityRole, type ColorValue } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GLASS_BUTTON_BORDER_WIDTH, GlassSurface, useAdaptiveNativeGlass } from '../GlassSurface';
import { useTokens } from '../../theme';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

export const RAIL_CAPSULE_WIDTH = 48;
export const RAIL_ITEM_HEIGHT = 50;
export function railCapsuleLength(count: number, compact: boolean, tokens: { spacingXs: number; uiSpacingXs: number; hitTargetMin: number }) {
  if (count === 0) return 0;
  if (count === 1) return RAIL_CAPSULE_WIDTH;
  return compact ? count * tokens.hitTargetMin + GLASS_BUTTON_BORDER_WIDTH
    : count * RAIL_ITEM_HEIGHT + (count - 1) * tokens.uiSpacingXs / 2 + 2 * tokens.spacingXs + GLASS_BUTTON_BORDER_WIDTH;
}
const RailCapsuleItemContext = React.createContext<{ compact: boolean; single: boolean; direction: 'column' | 'row' }>({ compact: false, single: false, direction: 'column' });

function countRailCapsuleItems(children: React.ReactNode): number {
  return React.Children.toArray(children).filter(Boolean).reduce<number>((count, child) => {
    if (React.isValidElement(child) && child.type === React.Fragment) {
      return count + countRailCapsuleItems((child.props as { children?: React.ReactNode }).children);
    }
    return count + 1;
  }, 0);
}

export function RailCapsule({ children, testID, compact = false, direction = 'column' }: {
  children: React.ReactNode; testID: string; compact?: boolean; direction?: 'column' | 'row';
}) {
  const t = useTokens();
  const single = countRailCapsuleItems(children) === 1;
  const row = direction === 'row';
  const length = railCapsuleLength(countRailCapsuleItems(children), compact,
    { spacingXs: t.spacing.xs, uiSpacingXs: t.uiSpacing.xs, hitTargetMin: t.hitTarget.min });
  const content = <View style={{ ...(row ? { height: RAIL_CAPSULE_WIDTH, flexDirection: 'row' as const } : { width: RAIL_CAPSULE_WIDTH }),
    ...(single ? { width: RAIL_CAPSULE_WIDTH, height: RAIL_CAPSULE_WIDTH, gap: 0, justifyContent: 'center' as const }
      : { ...(row ? { paddingHorizontal: compact ? 0 : t.spacing.xs } : { paddingVertical: compact ? 0 : t.spacing.xs }), gap: compact ? 0 : t.uiSpacing.xs / 2 }),
    alignItems: 'center' }}>
    <RailCapsuleItemContext.Provider value={{ compact, single, direction }}>{children}</RailCapsuleItemContext.Provider>
  </View>;
  return <GlassSurface role="chrome" testID={testID} colorScheme="adaptive" isInteractive cornerRadius={RAIL_CAPSULE_WIDTH / 2}
    style={{ width: row ? length : RAIL_CAPSULE_WIDTH, height: row ? RAIL_CAPSULE_WIDTH : length }}>
    {content}
  </GlassSurface>;
}

type RailCapsuleItemChildren = React.ReactNode | ((iconColor: ColorValue) => React.ReactNode);

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, badgeCount, dot, disabled = false, role = 'button' }: {
  children: RailCapsuleItemChildren; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; badgeCount?: number; dot?: boolean; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  // iOS 26 native 유리는 배경에 따라 밝기가 바뀌므로 iOS 동적 색을 쓰고,
  // 웹·Reduce Transparency·구형 OS 대체 경로는 하단 탭바와 같은 앱 테마 토큰을 쓴다.
  const adaptiveNative = useAdaptiveNativeGlass();
  const { compact, single, direction } = React.useContext(RailCapsuleItemContext);
  const count = badgeCount ?? badge;
  const itemLength = compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT;
  const iconColor: ColorValue = adaptiveNative
    ? PlatformColor(selected ? 'systemBlue' : 'label')
    : selected ? t.colors.accent : t.colors.textMuted;
  const badgeBackgroundColor: ColorValue = adaptiveNative ? PlatformColor('systemBlue') : t.colors.accentTint;
  const badgeTextColor: ColorValue = adaptiveNative ? '#ffffff' : t.colors.accent;
  const dotColor: ColorValue = adaptiveNative ? PlatformColor('systemBlue') : t.colors.accent;
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={disabled ? undefined : onPress}
    style={{ width: single ? RAIL_CAPSULE_WIDTH : direction === 'row' ? itemLength : RAIL_CAPSULE_WIDTH - 4,
      height: single ? RAIL_CAPSULE_WIDTH : direction === 'row' ? RAIL_CAPSULE_WIDTH - 4 : itemLength,
      alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    <View style={{ position: 'relative' }}>
      {typeof children === 'function' ? children(iconColor) : children}
      {count && count > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: -t.spacing.xxs, right: -t.spacing.xxs,
        ...t.foundation.typography.label, borderRadius: t.foundation.radius.round, backgroundColor: badgeBackgroundColor,
        color: badgeTextColor, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{count}</Text>
        : dot ? <View testID={`${testID}-dot`} style={{ position: 'absolute', top: 0, right: 0, width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: dotColor }} /> : null}
    </View>
  </PlatformPressable>;
}
