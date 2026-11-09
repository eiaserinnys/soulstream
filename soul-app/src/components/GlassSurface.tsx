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
  DARK_COLORS,
  getSurfaceRole,
  LIGHT_COLORS,
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
export type GlassColorScheme = 'auto' | 'light' | 'dark' | 'adaptive';

type ExpoGlassEffectModule = {
  GlassView: React.ComponentType<any>;
  GlassContainer?: React.ComponentType<any>;
  isLiquidGlassAvailable: () => boolean;
  isGlassEffectAPIAvailable: () => boolean;
};

let glassEffectModule: ExpoGlassEffectModule | null | undefined;
const SurfaceRoleContext = React.createContext<readonly SurfaceRoleName[]>([]);
const AdaptiveNativeGlassContext = React.createContext(false);

/** 자식이 적응형 native 리퀴드 글래스 위에 있는지 알려 준다. */
export function useAdaptiveNativeGlass(): boolean {
  return React.useContext(AdaptiveNativeGlassContext);
}

/** Native modals are separate compositing layers, even when React retains their ancestry. */
export function GlassSurfaceBoundary({ children }: { children: React.ReactNode }) {
  return <SurfaceRoleContext.Provider value={[]}>{children}</SurfaceRoleContext.Provider>;
}

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
  /** Forces the glass appearance independently of the app theme (e.g. bright rail capsule in dark mode). */
  colorScheme?: GlassColorScheme;
  testID?: string;
  onLayout?: (event: LayoutChangeEvent) => void;
}

export function GlassSurface(props: GlassSurfaceProps) {
  return <GlassSurfaceImpl {...props} />;
}

export interface GlassClusterContainerProps {
  children: React.ReactNode;
  /** 인접한 GlassView 사이에서 UIKit이 합쳐 그릴 간격. */
  spacing?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  pointerEvents?: ViewStyle['pointerEvents'];
}

/**
 * 떠 있는 유리 클러스터의 컨테이너.
 *
 * iOS 26에서는 인접한 GlassView를 GlassContainer로 묶어 하나의 유리 덩어리로 합쳐 그린다.
 * 네이티브 합성이 불가능한 환경(웹, Reduce Transparency, 구형 OS)에서는 같은 style과
 * `spacing`만큼의 레이아웃 gap을 쓰는 View로 대체한다.
 */
export function GlassClusterContainer({
  children,
  spacing,
  style,
  testID,
  pointerEvents,
}: GlassClusterContainerProps) {
  const reduceTransparency = useReduceTransparency();
  const GlassContainer = loadGlassEffect()?.GlassContainer;
  const resolvedStyle = spacing !== undefined ? [{ gap: spacing }, style] : style;
  if (!reduceTransparency && canUseNativeGlass() && GlassContainer) {
    return (
      <GlassContainer spacing={spacing} style={resolvedStyle} testID={testID} pointerEvents={pointerEvents}>
        {children}
      </GlassContainer>
    );
  }
  return (
    <View testID={testID} style={resolvedStyle} pointerEvents={pointerEvents}>
      {children}
    </View>
  );
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
  colorScheme = 'auto',
  onLayout,
  renderContent,
}: GlassSurfaceImplProps) {
  const t = useTokens();
  const ancestorRoles = React.useContext(SurfaceRoleContext);
  const effectiveMode: DesignTokens['mode'] =
    colorScheme === 'light' || colorScheme === 'dark' ? colorScheme : t.mode;
  const effectiveTokens: DesignTokens =
    effectiveMode === t.mode
      ? t
      : {
          ...t,
          mode: effectiveMode,
          colors: effectiveMode === 'light' ? LIGHT_COLORS : DARK_COLORS,
        };
  const roles = createSurfaceRoles(effectiveTokens);
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
  const surface = nestedSameRole
    ? getSurfaceRole(roles, resolvedRole)
    : requestedSurface;
  const reduceTransparency = useReduceTransparency();
  const surfaceKind = resolveGlassSurfaceKind({
    nativeGlassAvailable: canUseNativeGlass(),
    reduceTransparency,
    nativeGlassEnabled: surface.nativeGlass,
  });
  const resolvedBlurTint = resolveGlassBlurTint(effectiveMode);
  const resolvedCornerRadius = cornerRadius ?? surface.borderRadius;
  const radiusStyle = createSurfaceRadiusStyle(resolvedCornerRadius);
  const surfaceStyle = [
    styles.surface,
    surface.materialStyle[surfaceKind],
    style,
    radiusStyle,
  ] as StyleProp<ViewStyle>;
  // native 유리는 UIKit이 연속 곡률로 그리고 가장자리 그림자까지 모양 밖에 그린다.
  // 호스트가 원형 곡률로 잘라 내면 그 조각이 외곽선처럼 남으므로 자르지 않는다.
  const nativeSurfaceStyle = [
    surface.materialStyle.native,
    style,
    radiusStyle,
    { overflow: 'visible', borderCurve: 'continuous' },
  ] as StyleProp<ViewStyle>;
  const content = (
    <AdaptiveNativeGlassContext.Provider
      value={surfaceKind === 'native' && colorScheme === 'adaptive'}
    >
      <SurfaceRoleContext.Provider value={[...ancestorRoles, resolvedRole]}>
        {renderContent ? renderContent(surfaceKind) : children}
      </SurfaceRoleContext.Provider>
    </AdaptiveNativeGlassContext.Provider>
  );

  if (surfaceKind === 'native') {
    const { GlassView } = loadGlassEffect()!;
    // 'adaptive'는 스킴을 고정하지 않고 앱 외양(UIKit)을 따르게 한다.
    const resolvedColorScheme: 'auto' | 'light' | 'dark' =
      colorScheme === 'adaptive' ? 'auto' : effectiveMode === 'dark' ? 'dark' : 'light';
    return (
      <GlassView
        testID={testID}
        glassEffectStyle="regular"
        colorScheme={resolvedColorScheme}
        tintColor={surface.nativeTintColor}
        isInteractive={isInteractive}
        borderRadius={resolvedCornerRadius}
        style={nativeSurfaceStyle}
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
  const compactFrameStyle = [frameStyle, Platform.OS === 'web' ? { outlineStyle: 'solid' as const, outlineWidth: 0 } : undefined];
  const compactFocusStyle = focused && !disabled ? { borderWidth: GLASS_BUTTON_BORDER_WIDTH, borderColor: buttonPrimitive.focusedColor } : undefined;
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
      accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
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
        accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
        {...(Platform.OS === 'web' && ariaPressed !== undefined ? { 'aria-pressed': ariaPressed } : {})}
        style={[{
          minWidth: Math.max(t.hitTarget.min, primitive.minHeight),
          minHeight: Math.max(t.hitTarget.min, primitive.minHeight),
          alignItems: 'center',
          justifyContent: 'center',
          opacity: disabled ? 0.55 : 1,
        }, compactFrameStyle, disabled ? { opacity: 0.55 } : undefined]}
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
      return <CompactTouchTarget testID={testID} frameStyle={compactFrameStyle} onPress={onPress} disabled={disabled} accessibilityRole={accessibilityRole}
        onFocus={() => { if (!disabled) setFocused(true); }} onBlur={() => setFocused(false)}
        accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: !!disabled, ...accessibilityState }}>
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
    return <CompactTouchTarget testID={testID} frameStyle={compactFrameStyle} onPress={onPress} disabled={disabled} accessibilityRole={accessibilityRole}
      onFocus={() => { if (!disabled) setFocused(true); }} onBlur={() => setFocused(false)}
      accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: !!disabled, ...accessibilityState }}>
      {variant === 'primary' ? <View testID={surfaceTestID} style={[style, visualStyle, { backgroundColor: buttonPrimitive.backgroundColor }, compactFocusStyle]}>{children}</View>
        : <GlassSurfaceImpl role={buttonPrimitive.surfaceRole} testID={surfaceTestID} isInteractive cornerRadius={resolvedRadius} style={[style, visualStyle, compactFocusStyle]}>{children}</GlassSurfaceImpl>}
    </CompactTouchTarget>;
  }

  if (variant === 'primary') {
    return (
      <View testID={surfaceTestID} style={[style, iconBoundaryStyle]}>
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
