import React from 'react';
import {
  TouchableOpacity,
  type AccessibilityRole,
  type AccessibilityState,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { createPrimitiveRoles, useTokens } from '../theme';
import type { SurfaceRoleName } from '../theme/surfaceRoles';
import { GlassSurface } from './GlassSurface';

type LegacyGlassCardRole = 'panel' | 'card' | 'message';
type GlassCardRole = SurfaceRoleName | LegacyGlassCardRole;

export interface AppGlassCardProps {
  children?: React.ReactNode;
  role?: GlassCardRole;
  style?: StyleProp<ViewStyle>;
  isInteractive?: boolean;
  cornerRadius?: number;
  testID?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
}

/**
 * role 기반 카드 표면. 화면은 색·반경을 전달하지 않는다.
 * native glass 사용 여부는 surfaceRoles의 역할 스위치 한 곳에서만 결정한다.
 */
export function AppGlassCard({
  children,
  role = 'glassCard',
  style,
  isInteractive = false,
  cornerRadius,
  testID,
  onLayout,
}: AppGlassCardProps) {
  return (
    <GlassSurface
      role={resolveAppGlassRole(role)}
      testID={testID}
      isInteractive={isInteractive}
      cornerRadius={cornerRadius}
      style={style}
      onLayout={onLayout}
    >
      {children}
    </GlassSurface>
  );
}

export function resolveAppGlassRole(role: GlassCardRole): SurfaceRoleName {
  if (role === 'panel') return 'glassSoft';
  if (role === 'card') return 'glassCard';
  if (role === 'message') return 'glassDense';
  return role;
}

export interface AppGlassPressableProps {
  children?: React.ReactNode;
  role?: GlassCardRole;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  surfaceTestID?: string;
  disabled?: boolean;
  activeOpacity?: number;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  onPress?: () => void;
  onLongPress?: () => void;
}

/**
 * 카드·행의 터치 표면. GlassView와 BlurView 폴백을 호출부에 노출하지 않는다.
 */
export function AppGlassPressable({
  children,
  role = 'glassCard',
  style,
  contentStyle,
  testID,
  surfaceTestID,
  disabled,
  activeOpacity = 0.75,
  accessibilityLabel,
  accessibilityRole = 'button',
  accessibilityState,
  onPress,
  onLongPress,
}: AppGlassPressableProps) {
  const t = useTokens();
  const primitive = createPrimitiveRoles(t).row;
  const interactionDisabled = disabled ?? (!onPress && !onLongPress);
  return (
    <AppGlassCard
      role={role}
      style={style}
      isInteractive={!interactionDisabled}
      testID={surfaceTestID}
    >
      <TouchableOpacity
        testID={testID}
        style={[
          !interactionDisabled && {
            minWidth: t.hitTarget.min,
            minHeight: t.hitTarget.min,
            borderRadius: primitive.radius,
          },
          contentStyle,
        ]}
        disabled={interactionDisabled}
        activeOpacity={activeOpacity}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={interactionDisabled ? undefined : accessibilityRole}
        accessibilityState={{
          ...accessibilityState,
          disabled: interactionDisabled,
        }}
        onPress={onPress}
        onLongPress={onLongPress}
      >
        {children}
      </TouchableOpacity>
    </AppGlassCard>
  );
}
