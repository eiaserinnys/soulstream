import React from 'react';
export const GLASS_BUTTON_BORDER_WIDTH = 2;
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityRole,
  type AccessibilityState,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { CompactTouchTarget } from './CompactTouchTarget';
import { BlurView, type BlurTint } from 'expo-blur';
import {
  createPrimitiveRoles,
  createPlannerVisualRoles,
  createSurfaceRoles,
  getSurfaceRole,
  useTokens,
  type DesignTokens,
  type PrimitiveRoleDefinition,
} from '../theme';
import type { SurfaceRoleName } from '../theme/surfaceRoles';
import {
  createGlobalAppFailureRecord,
  enqueueGlobalAppFailure,
} from '../lib/session-succession-diagnostics';
import { reportSanitizedEasObserveError } from '../lib/eas-observe-crash-reporting';

type GlassStyle = 'clear' | 'regular' | 'none';
type GlassColorScheme = 'auto' | 'light' | 'dark';

type ExpoGlassEffectModule = {
  GlassView: React.ComponentType<any>;
  isLiquidGlassAvailable: () => boolean;
  isGlassEffectAPIAvailable: () => boolean;
};

let glassEffectModule: ExpoGlassEffectModule | null | undefined;
const SurfaceRoleContext = React.createContext<readonly SurfaceRoleName[]>([]);

function loadGlassEffect(): ExpoGlassEffectModule | null {
  if (glassEffectModule !== undefined) return glassEffectModule;
  try {
    glassEffectModule = require('expo-glass-effect') as ExpoGlassEffectModule;
  } catch {
    glassEffectModule = null;
  }
  return glassEffectModule;
}

function canUseNativeGlass(): boolean {
  if (Platform.OS !== 'ios') return false;
  const module = loadGlassEffect();
  if (!module) return false;
  try {
    return module.isLiquidGlassAvailable() && module.isGlassEffectAPIAvailable();
  } catch {
    return false;
  }
}

function useReduceTransparency(): boolean {
  const [reduceTransparency, setReduceTransparency] = React.useState(false);
  const reduceTransparencyRef = React.useRef(false);
  const applyReduceTransparency = React.useCallback((enabled: boolean) => {
    if (reduceTransparencyRef.current === enabled) return;
    reduceTransparencyRef.current = enabled;
    setReduceTransparency(enabled);
  }, []);

  React.useEffect(() => {
    let mounted = true;
    const reduceTransparencyPromise =
      AccessibilityInfo.isReduceTransparencyEnabled?.();
    reduceTransparencyPromise
      ?.then((enabled) => {
        if (mounted) applyReduceTransparency(enabled);
      })
      .catch(() => {});

    const subscription = AccessibilityInfo.addEventListener?.(
      'reduceTransparencyChanged' as any,
      applyReduceTransparency,
    );
    return () => {
      mounted = false;
      subscription?.remove?.();
    };
  }, [applyReduceTransparency]);

  return reduceTransparency;
}

export interface GlassSurfaceProps {
  children?: React.ReactNode;
  role: SurfaceRoleName;
  style?: StyleProp<ViewStyle>;
  isInteractive?: boolean;
  /** Used by foreground card primitives for a token-defined corner radius. */
  cornerRadius?: number;
  testID?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export function GlassSurface(props: GlassSurfaceProps) {
  return <GlassSurfaceImpl {...props} />;
}

interface GlassSurfaceImplProps extends GlassSurfaceProps {
  /** Internal primitive renderer that can keep fallback interaction semantics. */
  renderContent?: (surfaceKind: GlassSurfaceKind) => React.ReactNode;
}

function GlassSurfaceImpl({
  children,
  role,
  style,
  isInteractive = false,
  testID,
  cornerRadius,
  onLayout,
  renderContent,
}: GlassSurfaceImplProps) {
  const t = useTokens();
  const ancestorRoles = React.useContext(SurfaceRoleContext);
  const roles = createSurfaceRoles(t);
  const requestedSurface = getSurfaceRole(roles, role);
  const nestedSameRole =
    requestedSurface.compositesBackdrop && ancestorRoles.includes(role);
  const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__;
  const violationMessage = `Nested GlassSurface role is not allowed: ${role}`;
  if (nestedSameRole && isDevelopmentBuild) {
    throw new Error(violationMessage);
  }
  const reportedViolation = React.useRef(false);
  React.useEffect(() => {
    if (!nestedSameRole || isDevelopmentBuild) {
      reportedViolation.current = false;
      return;
    }
    if (reportedViolation.current) return;
    reportedViolation.current = true;
    reportSurfaceRoleViolation(new Error(violationMessage));
  }, [isDevelopmentBuild, nestedSameRole, violationMessage]);

  const resolvedRole: SurfaceRoleName = nestedSameRole ? 'canvas' : role;
  const surface = nestedSameRole ? getSurfaceRole(roles, resolvedRole) : requestedSurface;
  const reduceTransparency = useReduceTransparency();
  const surfaceKind = resolveGlassSurfaceKind({
    nativeGlassAvailable: canUseNativeGlass(),
    reduceTransparency,
    nativeGlassEnabled: surface.nativeGlass,
  });
  const resolvedBlurTint = resolveGlassBlurTint(t.mode);
  const radiusStyle = createSurfaceRadiusStyle(
    cornerRadius ?? surface.borderRadius,
  );
  const surfaceStyle = [
    styles.surface,
    surface.materialStyle[surfaceKind],
    style,
    radiusStyle,
  ] as StyleProp<ViewStyle>;
  const content = (
    <SurfaceRoleContext.Provider value={[...ancestorRoles, resolvedRole]}>
      {renderContent ? renderContent(surfaceKind) : children}
    </SurfaceRoleContext.Provider>
  );

  if (surfaceKind === 'native') {
    const { GlassView } = loadGlassEffect()!;
    const colorScheme: GlassColorScheme = t.mode === 'dark' ? 'dark' : 'light';
    return (
      <GlassView
        testID={testID}
        glassEffectStyle="regular"
        colorScheme={colorScheme}
        tintColor={surface.nativeTintColor}
        isInteractive={isInteractive}
        style={surfaceStyle}
        onLayout={onLayout}
      >
        {content}
      </GlassView>
    );
  }

  if (surfaceKind === 'blur') {
    return (
      <BlurView
        testID={testID}
        tint={resolvedBlurTint}
        intensity={surface.blurIntensity}
        style={[surfaceStyle, { backgroundColor: surface.blurColor }]}
        onLayout={onLayout}
      >
        {content}
      </BlurView>
    );
  }

  return (
    <View
      testID={testID}
      style={[surfaceStyle, { backgroundColor: surface.fallbackColor }]}
      onLayout={onLayout}
    >
      {content}
    </View>
  );
}

function createSurfaceRadiusStyle(radius: number): ViewStyle {
  return {
    borderRadius: radius,
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: radius,
    borderBottomRightRadius: radius,
  };
}

function reportSurfaceRoleViolation(error: Error) {
  reportSanitizedEasObserveError(error, 'glass-surface-role');
  try {
    console.error(`[GlassSurface] ${error.message}`);
  } catch {
    // 로깅 실패가 표면의 안전한 렌더를 중단시키지 않는다.
  }
  try {
    void enqueueGlobalAppFailure(createGlobalAppFailureRecord(error));
  } catch (diagnosticError) {
    try {
      console.error('[GlassSurface] diagnostic outbox enqueue failed:', diagnosticError);
    } catch {
      // 진단 부가기능은 표면 렌더보다 우선하지 않는다.
    }
  }
}

export type GlassSurfaceKind = 'native' | 'blur' | 'solid';

export function resolveGlassSurfaceKind(input: {
  nativeGlassAvailable: boolean;
  reduceTransparency: boolean;
  nativeGlassEnabled?: boolean;
}): GlassSurfaceKind {
  if (input.reduceTransparency) return 'solid';
  if (input.nativeGlassEnabled === false) return 'solid';
  return input.nativeGlassAvailable ? 'native' : 'blur';
}

export function resolveGlassBlurTint(
  mode: DesignTokens['mode'],
  override?: BlurTint,
): BlurTint {
  return override ?? (mode === 'dark' ? 'dark' : 'light');
}

export interface GlassButtonProps {
  onPress: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  hitSlop?: number;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityState?: AccessibilityState;
  'aria-pressed'?: boolean;
  variant?: 'primary' | 'secondary' | 'paper' | 'plain';
  size?: 'standard' | 'compact' | 'card';
  iconOnly?: boolean;
  borderRadius?: number;
  padding?: { horizontal?: number; vertical?: number };
  style?: StyleProp<ViewStyle>;
  frameStyle?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  surfaceTestID?: string;
}

export function GlassButton({
  onPress,
  children,
  disabled,
  hitSlop,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  'aria-pressed': ariaPressed,
  variant = 'secondary',
  size = 'standard',
  iconOnly = false,
  borderRadius,
  padding,
  style,
  frameStyle,
  contentStyle,
  testID,
  surfaceTestID,
}: GlassButtonProps) {
  const t = useTokens();
  const [focused, setFocused] = React.useState(false);
  const [plainPressed, setPlainPressed] = React.useState(false);
  const buttonPrimitive = createPrimitiveRoles(t)[variant === 'primary' ? 'buttonPrimary' : 'buttonSecondary'];
  const primitive = createPrimitiveRoles(t).iconFrame;
  const paper = variant === 'paper';
  const plain = variant === 'plain';
  const standardMinHeight = Math.max(t.hitTarget.min, buttonPrimitive.minHeight);
  const resolvedRadius = borderRadius ?? (plain && iconOnly ? t.foundation.radius.round : buttonPrimitive.radius);
  const horizontal = iconOnly ? 0 : padding?.horizontal ?? buttonPrimitive.padding.horizontal;
  const vertical = iconOnly ? 0 : padding?.vertical ?? buttonPrimitive.padding.vertical;
  const iconBoundaryStyle: ViewStyle | undefined = iconOnly
    ? { width: t.hitTarget.min, height: t.hitTarget.min }
    : undefined;

  const renderButton = (nativePressFeedback: boolean) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      onFocus={() => {
        if (!disabled) setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      disabled={disabled}
      hitSlop={hitSlop ?? t.spacing.sm}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ ...accessibilityState, disabled: !!disabled }}
      {...(Platform.OS === 'web' && ariaPressed !== undefined ? { 'aria-pressed': ariaPressed } : {})}
      style={({ pressed }) => [
        styles.buttonInner,
        ...(Platform.OS === 'web' ? [{ outlineStyle: 'solid' as const, outlineWidth: 0 }] : []),
        {
          minWidth: t.hitTarget.min,
          minHeight: t.hitTarget.min,
          paddingHorizontal: horizontal,
          paddingVertical: vertical,
          borderRadius: resolvedRadius,
          gap: t.spacing.xs,
          opacity: disabled ? 0.55 : 1,
          backgroundColor: paper
            ? resolvePaperButtonBackground(t, buttonPrimitive, !!disabled, pressed)
            : plain
              ? resolvePlainButtonBackground(buttonPrimitive, !!disabled, pressed, focused)
            : resolveGlassButtonBackground(buttonPrimitive, !!disabled, pressed, nativePressFeedback),
          borderWidth: paper || plain ? 0 : GLASS_BUTTON_BORDER_WIDTH,
          borderColor: paper || plain ? 'transparent' : focused && !disabled ? buttonPrimitive.focusedColor : 'transparent',
        },
        !iconOnly && { minHeight: standardMinHeight },
        contentStyle,
        iconBoundaryStyle,
      ]}
    >
      {children}
    </Pressable>
  );

  if (plain && iconOnly && size !== 'standard') {
    const visualSize = size === 'compact' ? t.foundation.iconFrame.compact : t.avatarSize.session;
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        onFocus={() => {
          if (!disabled) setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onPressIn={() => setPlainPressed(true)}
        onPressOut={() => setPlainPressed(false)}
        disabled={disabled}
        hitSlop={hitSlop ?? t.spacing.sm}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ ...accessibilityState, disabled: !!disabled }}
        {...(Platform.OS === 'web' && ariaPressed !== undefined ? { 'aria-pressed': ariaPressed } : {})}
        style={[{
          minWidth: Math.max(t.hitTarget.min, primitive.minHeight),
          minHeight: Math.max(t.hitTarget.min, primitive.minHeight),
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.55 : 1,
        }, frameStyle]}
      >
        <View
          testID={surfaceTestID}
          style={[{
            width: visualSize,
            height: visualSize,
            borderRadius: resolvedRadius,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'transparent',
          }, style, (plainPressed || focused) && !disabled
            ? { backgroundColor: resolvePlainButtonBackground(buttonPrimitive, false, plainPressed, focused) }
            : undefined]}
        >
          {children}
        </View>
      </Pressable>
    );
  }

  if (paper) {
    const paperSurfaceStyle: ViewStyle = { overflow: 'hidden', backgroundColor: t.persistentSession.paper,
      borderWidth: StyleSheet.hairlineWidth, borderColor: focused && !disabled ? buttonPrimitive.focusedColor : t.persistentSession.line,
      borderRadius: resolvedRadius };
    if (iconOnly && size !== 'standard') {
      const visualSize = size === 'compact' ? t.foundation.iconFrame.compact : t.avatarSize.session;
      return <CompactTouchTarget testID={testID} frameStyle={frameStyle} onPress={onPress} disabled={disabled} accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint} accessibilityState={{ ...accessibilityState, disabled: !!disabled }}>
        <View testID={surfaceTestID} style={[style, paperSurfaceStyle, { width: visualSize, height: visualSize, alignItems: 'center', justifyContent: 'center' }]}>{children}</View>
      </CompactTouchTarget>;
    }
    return <View testID={surfaceTestID} style={[paperSurfaceStyle, style]}>{renderButton(false)}</View>;
  }

  if (plain) return <View style={style}>{renderButton(false)}</View>;

  if (iconOnly && size !== 'standard') {
    const visualSize = size === 'compact' ? t.foundation.iconFrame.compact : t.avatarSize.session;
    const visualStyle: ViewStyle = { width: visualSize, height: visualSize, borderRadius: resolvedRadius,
      alignItems: 'center', justifyContent: 'center' };
    return <CompactTouchTarget testID={testID} frameStyle={frameStyle} onPress={onPress} disabled={disabled} accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint} accessibilityState={{ ...accessibilityState, disabled: !!disabled }}>
      {variant === 'primary' ? <View testID={surfaceTestID} style={[style, visualStyle, { backgroundColor: buttonPrimitive.backgroundColor }]}>{children}</View>
        : <GlassSurfaceImpl role={buttonPrimitive.surfaceRole} testID={surfaceTestID} isInteractive cornerRadius={resolvedRadius} style={[style, visualStyle]}>{children}</GlassSurfaceImpl>}
    </CompactTouchTarget>;
  }

  if (variant === 'primary') {
    return (
      <View style={[style, iconBoundaryStyle]}>
        {renderButton(false)}
      </View>
    );
  }

  return (
    <GlassSurfaceImpl
      role={buttonPrimitive.surfaceRole}
      testID={surfaceTestID}
      isInteractive
      cornerRadius={resolvedRadius}
      style={[style, iconBoundaryStyle]}
      renderContent={(surfaceKind) => renderButton(surfaceKind === 'native')}
    />
  );
}

export function resolveGlassButtonBackground(
  primitive: Pick<
    PrimitiveRoleDefinition,
    'backgroundColor' | 'pressedColor' | 'disabledColor'
  >,
  disabled: boolean,
  pressed: boolean,
  nativePressFeedback = false,
): string {
  if (disabled) return primitive.disabledColor;
  if (pressed && !nativePressFeedback) return primitive.pressedColor;
  return primitive.backgroundColor;
}

export function resolvePaperButtonBackground(
  t: DesignTokens,
  primitive: PrimitiveRoleDefinition,
  disabled: boolean,
  pressed: boolean,
): string {
  if (disabled) return primitive.disabledColor;
  return pressed ? createPlannerVisualRoles(t).grouped.pressedColor : t.persistentSession.paper;
}

export function resolvePlainButtonBackground(
  primitive: Pick<PrimitiveRoleDefinition, 'pressedColor'>,
  disabled: boolean,
  pressed: boolean,
  focused: boolean,
): string {
  return !disabled && (pressed || focused) ? primitive.pressedColor : 'transparent';
}

const styles = StyleSheet.create({
  surface: {
    overflow: 'hidden',
  },
  buttonInner: {
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
});
