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
import { AccessibilityInfo, StyleSheet, Text } from 'react-native';
import { fireEvent, render, renderHook } from '@testing-library/react-native';
import {
  DARK_COLORS,
  PHONE_FOUNDATION,
  type DesignTokens,
} from '../../theme/tokens';
import { createPrimitiveRoles } from '../../theme/surfacePrimitives';
import { useSettingsStore } from '../../store/settingsStore';
import { useTokens } from '../../theme';
import { GlassButton, resolveGlassButtonBackground } from '../GlassSurface';

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
