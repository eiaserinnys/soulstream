import React from 'react';
import { Text, View, type AccessibilityRole } from 'react-native';
import { PlatformPressable } from '@react-navigation/elements';
import { GLASS_BUTTON_BORDER_WIDTH, GlassSurface } from '../GlassSurface';
import { LIGHT_COLORS, useTokens, type DesignTokens } from '../../theme';
import { STATUS_DOT_SIZE } from '../chat/StatusDot';

export const RAIL_CAPSULE_WIDTH = 48;

/**
 * 캡슐은 다크 테마에서도 밝은 리퀴드 글래스로 렌더되므로 아이콘 색은 앱 테마가 아니라
 * 캡슐의 밝은 표면을 기준으로 고른다. 비선택 아이콘은 다크에서 #111111, 라이트에서
 * LIGHT textMuted(#53575d)이고, 선택 아이콘과 배지·점은 짙은 남색 #002b66을 쓴다.
 * 다크 비선택 값은 확정 보완 명세가 지정한 #111111이며, LIGHT_COLORS.textPrimary는
 * 이 리포에서 #000000이라 값이 달라 레일 전용 상수로 둔다.
 * 실측 대비: 비선택 다크 6.44:1(어두운 캔버스 위)·16.99:1(밝은 카드 위), 라이트 7.06:1.
 * 선택 #002b66은 밝은 캡슐 위 4.6~13.3:1, #d8ebff 배지 위 11.2:1로 AA를 넘는다.
 */
const DARK_RAIL_UNSELECTED_ICON = '#111111';
export const RAIL_CAPSULE_SELECTED_ACCENT = '#002b66';

export function railCapsuleIconColor(
  t: Pick<DesignTokens, 'mode'>,
  selected = false,
): string {
  if (selected) return RAIL_CAPSULE_SELECTED_ACCENT;
  return t.mode === 'dark' ? DARK_RAIL_UNSELECTED_ICON : LIGHT_COLORS.textMuted;
}
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
  return <GlassSurface role="chrome" testID={testID} colorScheme="light" isInteractive cornerRadius={RAIL_CAPSULE_WIDTH / 2}
    style={{ width: row ? length : RAIL_CAPSULE_WIDTH, height: row ? RAIL_CAPSULE_WIDTH : length }}>
    {content}
  </GlassSurface>;
}

export function RailCapsuleItem({ children, testID, label, onPress, selected, badge, badgeCount, dot, disabled = false, role = 'button' }: {
  children: React.ReactNode; testID: string; label: string; onPress: () => void;
  selected?: boolean; badge?: number; badgeCount?: number; dot?: boolean; disabled?: boolean; role?: AccessibilityRole;
}) {
  const t = useTokens();
  const { compact, single, direction } = React.useContext(RailCapsuleItemContext);
  const count = badgeCount ?? badge;
  const itemLength = compact ? t.hitTarget.min : RAIL_ITEM_HEIGHT;
  return <PlatformPressable testID={testID} accessibilityRole={role} accessibilityLabel={label}
    accessibilityState={{ ...(selected === undefined ? {} : { selected }), disabled }} disabled={disabled} onPress={disabled ? undefined : onPress}
    style={{ width: single ? RAIL_CAPSULE_WIDTH : direction === 'row' ? itemLength : RAIL_CAPSULE_WIDTH - 4,
      height: single ? RAIL_CAPSULE_WIDTH : direction === 'row' ? RAIL_CAPSULE_WIDTH - 4 : itemLength,
      alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.55 : 1 }}>
    <View style={{ position: 'relative' }}>
      {children}
      {count && count > 0 ? <Text testID={`${testID}-badge`} style={{ position: 'absolute', top: -t.spacing.xxs, right: -t.spacing.xxs,
        ...t.foundation.typography.label, borderRadius: t.foundation.radius.round, backgroundColor: LIGHT_COLORS.accentTint,
        color: RAIL_CAPSULE_SELECTED_ACCENT, paddingHorizontal: t.uiSpacing.xs, fontWeight: '700' }}>{count}</Text>
        : dot ? <View testID={`${testID}-dot`} style={{ position: 'absolute', top: 0, right: 0, width: STATUS_DOT_SIZE, height: STATUS_DOT_SIZE, borderRadius: t.foundation.radius.round, backgroundColor: RAIL_CAPSULE_SELECTED_ACCENT }} /> : null}
    </View>
  </PlatformPressable>;
}
