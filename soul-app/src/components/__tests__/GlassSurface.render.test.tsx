const mockNativeAvailable = jest.fn(() => true);
const mockApiAvailable = jest.fn(() => true);
const mockReportSanitizedEasObserveError = jest.fn();
const removeTransparencyListener = jest.fn();
const mockBlurProps = new Map<string, Record<string, unknown>>();
const devGlobal = globalThis as typeof globalThis & { __DEV__?: boolean };
const originalDev = devGlobal.__DEV__;
let reduceTransparency = false;
let transparencyListener: ((enabled: boolean) => void) | undefined;

jest.mock('expo-glass-effect', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    GlassView: ({ testID, ...props }: Record<string, unknown>) =>
      React.createElement(View, { ...props, testID: `native-${testID}` }),
    isLiquidGlassAvailable: () => mockNativeAvailable(),
    isGlassEffectAPIAvailable: () => mockApiAvailable(),
  };
});

jest.mock('expo-blur', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    BlurView: ({ testID, ...props }: Record<string, unknown>) => {
      mockBlurProps.set(String(testID), props);
      return React.createElement(View, { ...props, testID: `blur-${testID}` });
    },
  };
});
jest.mock('../../lib/eas-observe-crash-reporting', () => ({
  reportSanitizedEasObserveError: (...args: unknown[]) => (
    mockReportSanitizedEasObserveError(...args)
  ),
}));

import React from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppGlassCard } from '../AppGlassCard';
import { CompactTouchTarget } from '../CompactTouchTarget';
import { DisclosureIcon } from '../DisclosureIcon';
import { GlassSurface } from '../GlassSurface';
import { LiquidGlassButton } from '../LiquidGlassButton';
import { useSettingsStore } from '../../store/settingsStore';
import { SESSION_SUCCESSION_DIAGNOSTICS_KEY } from '../../lib/session-succession-diagnostics';

describe('GlassSurface render paths and composition', () => {
  beforeEach(() => {
    devGlobal.__DEV__ = true;
    mockNativeAvailable.mockReturnValue(true);
    mockApiAvailable.mockReturnValue(true);
    mockBlurProps.clear();
    useSettingsStore.setState({ appearance: 'dark' });
    reduceTransparency = false;
    transparencyListener = undefined;
    removeTransparencyListener.mockClear();
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock) = jest.fn(
      () => new Promise<boolean>(() => undefined),
    );
    (AccessibilityInfo.addEventListener as jest.Mock).mockImplementation((event, listener) => {
      if (event === 'reduceTransparencyChanged') transparencyListener = listener;
      return { remove: removeTransparencyListener };
    });
  });

  afterEach(() => {
    devGlobal.__DEV__ = originalDev;
    jest.restoreAllMocks();
  });

  test('native GlassView 지원 경로를 렌더한다', async () => {
    const screen = render(<GlassSurface role="glassCard" testID="surface" />);
    expect(screen.getByTestId('native-surface').props.tintColor).toBeTruthy();
    await waitFor(() => expect(AccessibilityInfo.isReduceTransparencyEnabled).toHaveBeenCalled());
  });

  test('native Liquid Glass는 수동 border 없이 role 반경이 호출부 radius override를 이긴다', () => {
    const screen = render(
      <GlassSurface role="glassSoft" testID="surface" style={squareRadiusOverride} />,
    );
    const style = StyleSheet.flatten(screen.getByTestId('native-surface').props.style);

    expectRoleRadius(style, 24);
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
  });

  test('native GlassView는 glassSoft/card/dense의 서로 다른 semantic tint를 소비한다', () => {
    const screen = render(
      <View>
        <GlassSurface role="glassSoft" testID="soft" />
        <GlassSurface role="glassCard" testID="card" />
        <GlassSurface role="glassDense" testID="dense" />
      </View>,
    );
    const tints = ['soft', 'card', 'dense'].map((id) => (
      screen.getByTestId(`native-${id}`).props.tintColor
    ));
    expect(tints.every(Boolean)).toBe(true);
    expect(new Set(tints)).toHaveProperty('size', 3);
  });

  test('native 미지원이면 BlurView fallback을 렌더한다', () => {
    mockNativeAvailable.mockReturnValue(false);
    const screen = render(<GlassSurface role="glassSoft" testID="surface" />);
    expect(backgroundColorOf(mockBlurProps.get('surface')?.style))
      .toBeTruthy();
  });

  test('Blur fallback은 role 반경과 명시적 경계선을 유지한다', () => {
    mockNativeAvailable.mockReturnValue(false);
    render(
      <GlassSurface role="glassSoft" testID="surface" style={squareRadiusOverride} />,
    );
    const style = StyleSheet.flatten(
      mockBlurProps.get('surface')?.style,
    ) as ViewStyle;

    expectRoleRadius(style, 24);
    expect(style.borderWidth).toBeGreaterThan(0);
    expect(style.borderColor).toBeTruthy();
  });

  test('Blur fallback도 glassSoft/card/dense의 서로 다른 semantic fill을 소비한다', () => {
    mockNativeAvailable.mockReturnValue(false);
    const screen = render(
      <View>
        <GlassSurface role="glassSoft" testID="soft" />
        <GlassSurface role="glassCard" testID="card" />
        <GlassSurface role="glassDense" testID="dense" />
      </View>,
    );
    const fills = ['soft', 'card', 'dense'].map((id) => (
      backgroundColorOf(mockBlurProps.get(id)?.style)
    ));
    expect(fills.every(Boolean)).toBe(true);
    expect(new Set(fills)).toHaveProperty('size', 3);
  });

  test('Reduce Transparency initial/event/recovery/unsubscribe를 반영한다', async () => {
    reduceTransparency = true;
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock).mockResolvedValue(true);
    const screen = render(<GlassSurface role="glassCard" testID="surface" />);

    await waitFor(() => {
      const solid = screen.getByTestId('surface');
      expect(StyleSheet.flatten(solid.props.style).backgroundColor).toBeTruthy();
    });
    act(() => transparencyListener?.(false));
    expect(screen.getByTestId('native-surface')).toBeTruthy();
    act(() => transparencyListener?.(true));
    expect(screen.getByTestId('surface')).toBeTruthy();

    screen.unmount();
    expect(removeTransparencyListener).toHaveBeenCalledTimes(1);
  });

  test('Reduce Transparency solid fallback도 glassSoft/card/dense 역할을 구분한다', async () => {
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock).mockResolvedValue(true);
    const screen = render(
      <View>
        <GlassSurface role="glassSoft" testID="soft" />
        <GlassSurface role="glassCard" testID="card" />
        <GlassSurface role="glassDense" testID="dense" />
      </View>,
    );

    await waitFor(() => expect(screen.getByTestId('soft')).toBeTruthy());
    const fills = ['soft', 'card', 'dense'].map((id) => (
      backgroundColorOf(screen.getByTestId(id).props.style)
    ));
    expect(fills.every(Boolean)).toBe(true);
    expect(new Set(fills)).toHaveProperty('size', 3);
  });

  test('Reduce Transparency solid fallback은 role 반경과 접근성 경계선을 유지한다', async () => {
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock).mockResolvedValue(true);
    const screen = render(
      <GlassSurface role="glassSoft" testID="surface" style={squareRadiusOverride} />,
    );

    await waitFor(() => expect(screen.getByTestId('surface')).toBeTruthy());
    const style = StyleSheet.flatten(screen.getByTestId('surface').props.style);
    expectRoleRadius(style, 24);
    expect(style.borderWidth).toBeGreaterThan(0);
    expect(style.borderColor).toBeTruthy();
  });

  test('정상 reusable composition은 crash 없이 렌더한다', () => {
    expect(() => render(
      <View>
        <AppGlassCard testID="card">
          <CompactTouchTarget accessibilityLabel="compact">
            <DisclosureIcon expanded />
          </CompactTouchTarget>
          <LiquidGlassButton onPress={() => undefined} accessibilityLabel="secondary">
            <Text>보조</Text>
          </LiquidGlassButton>
        </AppGlassCard>
        <GlassSurface role="glassSoft" testID="panel">
          <LiquidGlassButton onPress={() => undefined} accessibilityLabel="panel-secondary">
            <Text>패널 보조</Text>
          </LiquidGlassButton>
        </GlassSurface>
        <View><GlassSurface role="glassDense" testID="chat" /></View>
        <GlassSurface role="modal" testID="modal"><View /></GlassSurface>
      </View>,
    )).not.toThrow();
  });

  test('__DEV__에서는 synthetic direct same-role 중첩을 명시적으로 실패시킨다', () => {
    expect(() => render(
      <GlassSurface role="glassCard">
        <GlassSurface role="glassCard" />
      </GlassSurface>,
    )).toThrow('Nested GlassSurface role is not allowed: glassCard');
  });

  test('불투명 nativeSheet는 같은 역할이 중첩돼도 glass 규약 위반이 아니다', () => {
    expect(() => render(
      <GlassSurface role="nativeSheet">
        <GlassSurface role="nativeSheet" testID="nested-native-sheet" />
      </GlassSurface>,
    )).not.toThrow();
  });

  test('프로덕션에서는 same-role 중첩을 기록하고 안전한 role로 렌더한다', async () => {
    devGlobal.__DEV__ = false;
    await AsyncStorage.clear();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const screen = render(
      <GlassSurface role="modal">
        <GlassSurface role="modal" testID="nested-modal" />
      </GlassSurface>,
    );

    expect(screen.getByTestId('nested-modal')).toBeTruthy();
    expect(consoleError).toHaveBeenCalledWith(
      '[GlassSurface] Nested GlassSurface role is not allowed: modal',
    );
    expect(mockReportSanitizedEasObserveError).toHaveBeenCalledTimes(1);
    expect(mockReportSanitizedEasObserveError).toHaveBeenCalledWith(
      expect.any(Error),
      'glass-surface-role',
    );
    await waitFor(async () => {
      const outbox = JSON.parse(
        (await AsyncStorage.getItem(SESSION_SUCCESSION_DIAGNOSTICS_KEY)) ?? '{}',
      );
      expect(outbox.pending).toEqual([
        expect.objectContaining({
          phase: 'global',
          error: expect.objectContaining({
            message: 'Nested GlassSurface role is not allowed: modal',
          }),
        }),
      ]);
    });
  });

  test('synthetic indirect A→B→A same-role 중첩도 명시적으로 실패한다', () => {
    expect(() => render(
      <GlassSurface role="glassCard">
        <GlassSurface role="chrome">
          <GlassSurface role="glassCard" />
        </GlassSurface>
      </GlassSurface>,
    )).toThrow('Nested GlassSurface role is not allowed: glassCard');
  });
});

function backgroundColorOf(style: unknown): unknown {
  if (Array.isArray(style)) {
    for (let index = style.length - 1; index >= 0; index -= 1) {
      const value = backgroundColorOf(style[index]);
      if (value !== undefined) return value;
    }
    return undefined;
  }
  if (!style || typeof style !== 'object') return undefined;
  return (style as { backgroundColor?: unknown }).backgroundColor;
}

const squareRadiusOverride = {
  borderRadius: 0,
  borderTopLeftRadius: 1,
  borderTopRightRadius: 2,
  borderBottomLeftRadius: 3,
  borderBottomRightRadius: 4,
};

function expectRoleRadius(
  style: ViewStyle,
  radius: number,
) {
  expect(style).toEqual(expect.objectContaining({
    borderRadius: radius,
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: radius,
    borderBottomRightRadius: radius,
  }));
}


test('오늘 전경 카드의 명시적 토큰 반경은 native와 fallback 표면에 동일하게 전달된다', () => {
  const { PlannerForegroundCard } = require('../planner/PlannerForegroundCard');
  const { DESIGN_RADIUS } = require('../../theme');
  mockNativeAvailable.mockReturnValue(true);
  mockApiAvailable.mockReturnValue(true);
  const screen = render(<PlannerForegroundCard glassTestID="today-radius" cornerRadius={DESIGN_RADIUS.lg}><Text>오늘</Text></PlannerForegroundCard>);
  expect(StyleSheet.flatten(screen.getByTestId('native-today-radius').props.style).borderRadius).toBe(16);
  screen.unmount();
  mockNativeAvailable.mockReturnValue(false);
  const fallback = render(<PlannerForegroundCard glassTestID="today-radius" cornerRadius={DESIGN_RADIUS.lg}><Text>오늘</Text></PlannerForegroundCard>);
  expect(StyleSheet.flatten(fallback.getByTestId('blur-today-radius').props.style).borderRadius).toBe(16);
});
