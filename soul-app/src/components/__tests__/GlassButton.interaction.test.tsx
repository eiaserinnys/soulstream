jest.mock('expo-glass-effect', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    GlassView: (props: Record<string, unknown>) => React.createElement(View, props),
    isLiquidGlassAvailable: () => false,
    isGlassEffectAPIAvailable: () => false,
  };
});
jest.mock('expo-blur', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { BlurView: (props: Record<string, unknown>) => React.createElement(View, props) };
});

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

import React from 'react';
import { AccessibilityInfo, Platform, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { fireEvent, render, renderHook } from '@testing-library/react-native';
import {
  DARK_COLORS,
  PHONE_FOUNDATION,
  type DesignTokens,
} from '../../theme/tokens';
import { createPrimitiveRoles } from '../../theme/surfacePrimitives';
import { createPlannerVisualRoles } from '../../theme/plannerVisualRoles';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { GlassButton, GLASS_BUTTON_BORDER_WIDTH, resolveGlassButtonBackground, resolvePaperButtonBackground } from '../GlassSurface';

describe('GlassButton interaction contract', () => {
  beforeEach(() => {
    mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock) = jest.fn(
      () => new Promise<boolean>(() => undefined),
    );
    useSettingsStore.setState({ appearance: 'dark' });
  });

  test('default secondary는 native glass만 press feedback을 소유하고 phone 44pt를 유지한다', () => {
    const screen = render(
      <GlassButton testID="button" surfaceTestID="surface" onPress={() => undefined}>
        <Text>보조</Text>
      </GlassButton>,
    );
    const surface = screen.getByTestId('surface');
    const button = screen.getByTestId('button');
    const normal = StyleSheet.flatten(button.props.style);
    const secondary = createPrimitiveRoles(phoneTokens()).buttonSecondary;
    const nativePressed = resolveGlassButtonBackground(secondary, false, true, true);
    const fallbackPressed = resolveGlassButtonBackground(secondary, false, true, false);
    expect(StyleSheet.flatten(surface.props.style).borderRadius).toBe(secondary.radius);
    expect(normal.minWidth).toBeGreaterThanOrEqual(44);
    expect(normal.minHeight).toBeGreaterThanOrEqual(44);
    expect(normal.backgroundColor).toBe(secondary.backgroundColor);
    expect(nativePressed).toBe(secondary.backgroundColor);
    expect(fallbackPressed).toBe(secondary.pressedColor);
  });

  test('iconOnly는 outer glass와 inner action을 같은 44pt 정사각 경계에 맞춘다', () => {
    const screen = render(
      <GlassButton
        iconOnly
        testID="button"
        surfaceTestID="surface"
        onPress={() => undefined}
      >
        <Text>+</Text>
      </GlassButton>,
    );
    const surface = StyleSheet.flatten(screen.getByTestId('surface').props.style);
    const button = StyleSheet.flatten(screen.getByTestId('button').props.style);
    const secondary = createPrimitiveRoles(phoneTokens()).buttonSecondary;

    expect(surface).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: secondary.radius,
    });
    expect(button).toMatchObject({
      width: 44,
      height: 44,
      paddingHorizontal: 0,
      paddingVertical: 0,
      borderRadius: secondary.radius,
    });
  });

  test('primary 명시만 solid accent를 쓰고 disabled affordance를 보존한다', () => {
    const screen = render(
      <GlassButton variant="primary" testID="primary" disabled onPress={() => undefined}>
        <Text>저장</Text>
      </GlassButton>,
    );
    const button = screen.getByTestId('primary');
    const style = StyleSheet.flatten(button.props.style);
    const primary = createPrimitiveRoles(phoneTokens()).buttonPrimary;
    expect(style.backgroundColor).toBe(primary.disabledColor);
    expect(style.minWidth).toBeGreaterThanOrEqual(44);
    expect(button.props.accessibilityState).toEqual({ disabled: true });
  });

  test('iPad는 48pt hit target을 유지한다', () => {
    mockDimensions = { width: 1024, height: 1366, scale: 2, fontScale: 1 };
    const screen = render(
      <GlassButton testID="button" onPress={() => undefined}><Text>보조</Text></GlassButton>,
    );
    const style = StyleSheet.flatten(screen.getByTestId('button').props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
  });

  test('public borderRadius override는 outer material과 inner action에 함께 적용된다', () => {
    const screen = render(
      <GlassButton
        testID="button"
        surfaceTestID="surface"
        borderRadius={22}
        onPress={() => undefined}
      >
        <Text>보조</Text>
      </GlassButton>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('surface').props.style).borderRadius).toBe(22);
    expect(StyleSheet.flatten(screen.getByTestId('button').props.style).borderRadius).toBe(22);
  });

  test.each(['secondary', 'primary'] as const)(
    '%s focus는 semantic border를 표시하고 blur에서 제거한다',
    (variant) => {
      const screen = render(
        <GlassButton variant={variant} testID="button" onPress={() => undefined}>
          <Text>액션</Text>
        </GlassButton>,
      );
      const button = screen.getByTestId('button');
      const primitive = createPrimitiveRoles(phoneTokens())[
        variant === 'primary' ? 'buttonPrimary' : 'buttonSecondary'
      ];
      const normal = StyleSheet.flatten(button.props.style);
      expect(normal).toMatchObject({
        minWidth: 44,
        borderWidth: 2,
        borderColor: 'transparent',
      });

      fireEvent(button, 'focus');
      const focused = StyleSheet.flatten(button.props.style);
      expect(focused).toMatchObject({
        borderWidth: 2,
        borderColor: primitive.focusedColor,
      });
      expect(focused.minWidth).toBe(normal.minWidth);
      expect(focused.minHeight).toBe(normal.minHeight);
      fireEvent(button, 'blur');
      expect(StyleSheet.flatten(button.props.style)).toMatchObject({
        borderWidth: 2,
        borderColor: 'transparent',
      });
    },
  );

  test('web plain focus는 UA 외곽선 없이 테마 피드백과 버튼 동작을 유지한다', () => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const onPress = jest.fn();
      const screen = render(
        <GlassButton variant="plain" testID="button" onPress={onPress}>
          <Text>닫기</Text>
        </GlassButton>,
      );
      const button = screen.getByTestId('button');
      const normal = StyleSheet.flatten(button.props.style);
      const primitive = createPrimitiveRoles(phoneTokens()).buttonSecondary;
      expect(normal).toMatchObject({ outlineStyle: 'solid', outlineWidth: 0, backgroundColor: 'transparent' });

      fireEvent(button, 'focus');
      const focused = StyleSheet.flatten(button.props.style);
      expect(focused.backgroundColor).toBe(primitive.pressedColor);
      for (const key of ['minWidth', 'minHeight', 'paddingHorizontal', 'paddingVertical', 'borderRadius'] as const) {
        expect(focused[key]).toBe(normal[key]);
      }
      fireEvent.press(button);
      expect(onPress).toHaveBeenCalledTimes(1);
      fireEvent(button, 'blur');
      expect(StyleSheet.flatten(button.props.style).backgroundColor).toBe('transparent');
    } finally {
      Platform.OS = originalOS;
    }
  });

  test('disabled button은 focus affordance를 활성화하지 않는다', () => {
    const screen = render(
      <GlassButton variant="secondary" testID="button" disabled onPress={() => undefined}>
        <Text>비활성</Text>
      </GlassButton>,
    );
    const button = screen.getByTestId('button');
    fireEvent(button, 'focus');
    expect(StyleSheet.flatten(button.props.style)).toMatchObject({
      borderWidth: 2,
      borderColor: 'transparent',
    });
  });

  test.each([
    ['secondary', 'card'],
    ['secondary', 'compact'],
    ['primary', 'card'],
    ['paper', 'card'],
    ['plain', 'card'],
    ['plain', 'compact'],
  ] as const)('web %s %s 아이콘은 공통 focus 표현과 hit frame을 유지한다', (variant, size) => {
    const originalOS = Platform.OS;
    Platform.OS = 'web';
    try {
      const tokens = renderHook(() => useTokens()).result.current;
      const primitive = createPrimitiveRoles(tokens)[variant === 'primary' ? 'buttonPrimary' : 'buttonSecondary'];
      const onPress = jest.fn();
      const buttonElement = (disabled = false) => (
        <GlassButton variant={variant} size={size} iconOnly disabled={disabled}
          testID="button" surfaceTestID="surface" onPress={onPress}
          borderRadius={tokens.foundation.radius.round}
          frameStyle={{ opacity: 0.2, outlineStyle: 'dashed', outlineWidth: 3 }}
          style={{ opacity: 0.8 }}>
          <Text>닫기</Text>
        </GlassButton>
      );
      const screen = render(buttonElement());
      const frame = () => StyleSheet.flatten(screen.getByTestId('button').props.style);
      const surface = () => StyleSheet.flatten(screen.getByTestId('surface').props.style);
      const normalFrame = frame();
      const normalSurface = surface();
      const visualSize = size === 'compact' ? tokens.foundation.iconFrame.compact : tokens.avatarSize.session;
      const focusedSurface = variant === 'plain'
        ? { backgroundColor: primitive.pressedColor }
        : { borderWidth: variant === 'paper' ? StyleSheet.hairlineWidth : GLASS_BUTTON_BORDER_WIDTH, borderColor: primitive.focusedColor };
      expect(normalFrame).toMatchObject({
        minWidth: Math.max(tokens.hitTarget.min, createPrimitiveRoles(tokens).iconFrame.minHeight),
        minHeight: Math.max(tokens.hitTarget.min, createPrimitiveRoles(tokens).iconFrame.minHeight),
        alignItems: 'center', justifyContent: 'center', opacity: 0.2,
        outlineStyle: 'solid', outlineWidth: 0,
      });
      expect(normalSurface).toMatchObject({
        width: visualSize, height: visualSize, borderRadius: tokens.foundation.radius.round,
        alignItems: 'center', justifyContent: 'center', opacity: 0.8,
      });
      fireEvent(screen.getByTestId('button'), 'focus');
      expect(surface()).toMatchObject(focusedSurface);
      expect(frame()).toEqual(normalFrame);
      const { borderWidth, borderColor, backgroundColor, ...normalLayout } = normalSurface;
      const { borderWidth: focusedWidth, borderColor: focusedColor, backgroundColor: focusedBackground, ...focusedLayout } = surface();
      expect(focusedLayout).toEqual(normalLayout);
      if (variant !== 'plain') expect(focusedBackground).toBe(backgroundColor);
      fireEvent.press(screen.getByTestId('button'));
      expect(onPress).toHaveBeenCalledTimes(1);
      fireEvent(screen.getByTestId('button'), 'blur');
      expect(surface()).toEqual(normalSurface);

      fireEvent(screen.getByTestId('button'), 'focus');
      expect(surface()).toMatchObject(focusedSurface);
      screen.rerender(buttonElement(true));
      expect(surface()).toEqual(normalSurface);
      const disabledFrame = variant === 'plain' ? frame()
        : StyleSheet.flatten(screen.UNSAFE_getByType(TouchableOpacity).props.style);
      expect(disabledFrame).toMatchObject({ ...normalFrame, opacity: 0.55 });
      expect(screen.getByTestId('button').props.accessibilityState.disabled).toBe(true);
      fireEvent(screen.getByTestId('button'), 'blur');
      fireEvent(screen.getByTestId('button'), 'focus');
      expect(surface()).toEqual(normalSurface);
    } finally {
      Platform.OS = originalOS;
    }
  });

  test('paper 변형은 persistent 종이 표면과 선 테두리를 쓴다', () => {
    const tokens = renderHook(() => useTokens()).result.current;
    const screen = render(<GlassButton variant="paper" testID="paper-button" surfaceTestID="paper-surface" onPress={() => undefined}>
      <Text>카드 열기</Text>
    </GlassButton>);
    const surface = StyleSheet.flatten(screen.getByTestId('paper-surface').props.style);
    const button = screen.getByTestId('paper-button');

    expect(surface).toMatchObject({ backgroundColor: tokens.persistentSession.paper, borderColor: tokens.persistentSession.line });
    expect(StyleSheet.flatten(button.props.style).backgroundColor).toBe(tokens.persistentSession.paper);
  });

  test('compact 아이콘은 hit frame과 눌림 상태를 유지하고 disabled 상태를 흐리게 표시한다', () => {
    const tokens = renderHook(() => useTokens()).result.current;
    const enabledOnPress = jest.fn();
    const disabledOnPress = jest.fn();
    const screen = render(
      <>
        <GlassButton
          variant="plain"
          iconOnly
          size="compact"
          testID="plain-button"
          surfaceTestID="plain-surface"
          onPress={() => undefined}
        >
          <Text>↓</Text>
        </GlassButton>
        <GlassButton
          variant="paper"
          iconOnly
          size="compact"
          testID="paper-button"
          onPress={() => undefined}
        >
          <Text>↑</Text>
        </GlassButton>
        <GlassButton
          variant="secondary"
          iconOnly
          size="card"
          frameStyle={{ opacity: 0.2 }}
          testID="enabled-compact-button"
          onPress={enabledOnPress}
        >
          <Text>다음</Text>
        </GlassButton>
        <GlassButton
          variant="secondary"
          iconOnly
          size="card"
          disabled
          frameStyle={{ opacity: 0.2 }}
          testID="disabled-compact-button"
          onPress={disabledOnPress}
        >
          <Text>이전</Text>
        </GlassButton>
      </>,
    );
    const button = screen.getByTestId('plain-button');
    const surface = screen.getByTestId('plain-surface');
    const hitFrame = StyleSheet.flatten(button.props.style);
    const visual = StyleSheet.flatten(surface.props.style);
    const existingFrame = StyleSheet.flatten(screen.getByTestId('paper-button').props.style);

    expect(hitFrame).toMatchObject({
      minWidth: existingFrame.minWidth,
      minHeight: existingFrame.minHeight,
    });
    expect(visual).toMatchObject({
      width: tokens.foundation.iconFrame.compact,
      height: tokens.foundation.iconFrame.compact,
      borderRadius: tokens.foundation.radius.round,
      backgroundColor: 'transparent',
    });
    expect(visual.borderWidth).toBeUndefined();
    expect(visual.borderColor).toBeUndefined();

    fireEvent(button, 'pressIn');
    expect(StyleSheet.flatten(screen.getByTestId('plain-surface').props.style).backgroundColor)
      .toBe(tokens.colors.accentTint);
    fireEvent(button, 'pressOut');
    expect(StyleSheet.flatten(screen.getByTestId('plain-surface').props.style).backgroundColor)
      .toBe('transparent');

    const enabledButton = screen.getByTestId('enabled-compact-button');
    const disabledButton = screen.getByTestId('disabled-compact-button');
    expect(StyleSheet.flatten(enabledButton.props.style).opacity).toBe(0.2);
    expect(StyleSheet.flatten(disabledButton.props.style).opacity).toBe(0.55);
    expect(StyleSheet.flatten(enabledButton.props.style).outlineStyle).toBeUndefined();
    expect(StyleSheet.flatten(enabledButton.props.style).outlineWidth).toBeUndefined();
    expect(disabledButton.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(enabledButton);
    expect(disabledButton.props.onPress).toBeUndefined();
    expect(disabledButton.props.onStartShouldSetResponder()).toBe(false);
    expect(enabledOnPress).toHaveBeenCalledTimes(1);
    expect(disabledOnPress).not.toHaveBeenCalled();
  });

  test('paper 변형 눌림은 planner의 중립 눌림 색을 쓰고 기본 보조 버튼은 유지한다', () => {
    const tokens = renderHook(() => useTokens()).result.current;
    const plannerPressedColor = createPlannerVisualRoles(tokens).grouped.pressedColor;
    const secondaryRole = createPrimitiveRoles(tokens).buttonSecondary;
    expect(resolvePaperButtonBackground(tokens, secondaryRole, false, true)).toBe(plannerPressedColor);
    expect(resolvePaperButtonBackground(tokens, secondaryRole, false, false)).toBe(tokens.persistentSession.paper);
    expect(resolveGlassButtonBackground(secondaryRole, false, true, false)).toBe(secondaryRole.pressedColor);
    expect(resolveGlassButtonBackground(createPrimitiveRoles(tokens).buttonPrimary, false, true, false))
      .toBe(createPrimitiveRoles(tokens).buttonPrimary.pressedColor);

    const secondary = render(<GlassButton variant="secondary" testID="secondary-pressed" onPress={() => undefined}>
      <Text>기본</Text>
    </GlassButton>);
    expect(StyleSheet.flatten(secondary.getByTestId('secondary-pressed').props.style).backgroundColor).toBe(secondaryRole.backgroundColor);
  });
});

function phoneTokens(): DesignTokens {
  return {
    mode: 'dark',
    colors: DARK_COLORS,
    foundation: PHONE_FOUNDATION,
    spacing: { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 40 },
    hitTarget: { min: 44 },
    controlHeight: { button: 44, chip: 28, input: 44, sendBtn: 44 },
    avatarSize: { compact: 20, message: 32, session: 44 },
  } as DesignTokens;
}
