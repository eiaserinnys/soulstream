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
import { GlassSurface, useAdaptiveNativeGlass } from '../GlassSurface';
import { AppModalSurface } from '../AppModalSurface';
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
    const screen = render(<GlassSurface role="chrome" testID="surface" />);
    expect(screen.getByTestId('native-surface')).toBeTruthy();
    await waitFor(() => expect(AccessibilityInfo.isReduceTransparencyEnabled).toHaveBeenCalled());
  });

  test('colorScheme="light"는 다크 앱 모드에서도 밝은 리퀴드 글래스 스킴을 강제하고 틴트를 두지 않는다', () => {
    const screen = render(
      <GlassSurface role="chrome" colorScheme="light" testID="capsule" />,
    );
    const native = screen.getByTestId('native-capsule');

    expect(native.props.colorScheme).toBe('light');
    expect(native.props.tintColor).toBeUndefined();
    expect(native.props.borderRadius).toBe(0);
  });

  test('colorScheme="light"의 blur fallback은 밝은 fill만 쓰고 외곽선을 두지 않는다', () => {
    mockNativeAvailable.mockReturnValue(false);
    render(<GlassSurface role="chrome" colorScheme="light" testID="capsule" />);
    const props = mockBlurProps.get('capsule');
    const style = StyleSheet.flatten(props?.style) as ViewStyle;

    expect(props?.tint).toBe('light');
    expect(backgroundColorOf(style)).toBe('rgba(242, 242, 247, 0.58)');
    expect(style.borderColor).toBeUndefined();
    expect(style.borderWidth).toBeUndefined();
  });

  test('colorScheme="adaptive"는 native GlassView에 auto 스킴을 넘기고 틴트를 두지 않는다', () => {
    const screen = render(
      <GlassSurface role="chrome" colorScheme="adaptive" testID="adaptive" cornerRadius={24} />,
    );
    const native = screen.getByTestId('native-adaptive');

    expect(native.props.colorScheme).toBe('auto');
    expect(native.props.tintColor).toBeUndefined();
    expect(native.props.borderRadius).toBe(24);
  });

  test('적응형 native 유리 문맥은 native와 adaptive가 함께일 때만 자식에게 열린다', () => {
    function Probe({ id }: { id: string }) {
      const adaptive = useAdaptiveNativeGlass();
      return <View testID={`probe-${id}`} accessibilityState={{ selected: adaptive }} />;
    }
    const native = render(
      <View>
        <GlassSurface role="chrome" colorScheme="adaptive"><Probe id="adaptive" /></GlassSurface>
        <GlassSurface role="chrome"><Probe id="auto" /></GlassSurface>
        <GlassSurface role="chrome" colorScheme="light"><Probe id="light" /></GlassSurface>
      </View>,
    );
    expect(native.getByTestId('probe-adaptive').props.accessibilityState.selected).toBe(true);
    expect(native.getByTestId('probe-auto').props.accessibilityState.selected).toBe(false);
    expect(native.getByTestId('probe-light').props.accessibilityState.selected).toBe(false);
    native.unmount();

    mockNativeAvailable.mockReturnValue(false);
    const fallback = render(
      <GlassSurface role="chrome" colorScheme="adaptive"><Probe id="adaptive-blur" /></GlassSurface>,
    );
    expect(fallback.getByTestId('probe-adaptive-blur').props.accessibilityState.selected).toBe(false);
  });

  test('native 유리 호스트는 유리를 자르지 않고 연속 곡률을 쓴다', () => {
    const screen = render(
      <GlassSurface role="chrome" testID="edge" cornerRadius={24} />,
    );
    const style = StyleSheet.flatten(screen.getByTestId('native-edge').props.style) as ViewStyle;

    expect(style.overflow).toBe('visible');
    expect(style.borderCurve).toBe('continuous');
    expectRoleRadius(style, 24);
  });

  test('blur와 solid 경로는 계속 호스트에서 유리를 자른다', () => {
    mockNativeAvailable.mockReturnValue(false);
    const blur = render(<GlassSurface role="chrome" testID="edge-blur" />);
    const blurStyle = StyleSheet.flatten(blur.getByTestId('blur-edge-blur').props.style) as ViewStyle;
    expect(blurStyle.overflow).toBe('hidden');
    blur.unmount();

    const solid = render(<GlassSurface role="glassSoft" testID="edge-solid" />);
    const solidStyle = StyleSheet.flatten(solid.getByTestId('edge-solid').props.style) as ViewStyle;
    expect(solidStyle.overflow).toBe('hidden');
  });

  test('colorScheme를 주지 않은 다크 chrome은 어두운 유리 스킴을 유지하고 틴트를 두지 않는다', () => {
    const screen = render(<GlassSurface role="chrome" testID="chrome" />);
    const native = screen.getByTestId('native-chrome');

    expect(native.props.colorScheme).toBe('dark');
    expect(native.props.tintColor).toBeUndefined();
  });

  test('native Liquid Glass는 호출부 cornerRadius를 borderRadius prop과 style에 함께 전달한다', () => {
    const screen = render(
      <GlassSurface role="chrome" testID="surface" cornerRadius={24} />,
    );
    const native = screen.getByTestId('native-surface');
    const style = StyleSheet.flatten(native.props.style);

    expectRoleRadius(style, 24);
    expect(native.props.borderRadius).toBe(24);
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
  });

  test('native가 가능해도 콘텐츠 역할은 솔리드 fallback 색으로 렌더한다', () => {
    const screen = render(
      <View>
        <GlassSurface role="glassSoft" testID="soft" />
        <GlassSurface role="glassCard" testID="card" />
        <GlassSurface role="glassDense" testID="dense" />
      </View>,
    );
    const fills = ['soft', 'card', 'dense'].map((id) => (
      backgroundColorOf(screen.getByTestId(id).props.style)
    ));
    expect(fills).toEqual(['#0f1115', '#0d1017', '#0b0e15']);
    expect(screen.queryByTestId('native-soft')).toBeNull();
    expect(screen.queryByTestId('blur-soft')).toBeNull();
  });

  test('native 미지원이면 BlurView fallback을 렌더한다', () => {
    mockNativeAvailable.mockReturnValue(false);
    render(<GlassSurface role="chrome" testID="surface" />);
    expect(backgroundColorOf(mockBlurProps.get('surface')?.style))
      .toBeTruthy();
  });

  test('Blur fallback은 role 반경을 유지하고 chrome에는 경계선을 두지 않는다', () => {
    mockNativeAvailable.mockReturnValue(false);
    render(
      <GlassSurface role="chrome" testID="surface" cornerRadius={24} />,
    );
    const style = StyleSheet.flatten(
      mockBlurProps.get('surface')?.style,
    ) as ViewStyle;

    expectRoleRadius(style, 24);
    expect(style.borderWidth).toBeUndefined();
    expect(style.borderColor).toBeUndefined();
  });

  test('콘텐츠 역할은 native 불가 환경에서도 같은 솔리드 fill을 쓴다', () => {
    mockNativeAvailable.mockReturnValue(false);
    const screen = render(
      <View>
        <GlassSurface role="glassSoft" testID="soft" />
        <GlassSurface role="glassCard" testID="card" />
        <GlassSurface role="glassDense" testID="dense" />
      </View>,
    );
    const fills = ['soft', 'card', 'dense'].map((id) => (
      backgroundColorOf(screen.getByTestId(id).props.style)
    ));
    expect(fills).toEqual(['#0f1115', '#0d1017', '#0b0e15']);
    expect(screen.queryByTestId('blur-soft')).toBeNull();
  });

  test('Reduce Transparency initial/event/recovery/unsubscribe를 반영한다', async () => {
    reduceTransparency = true;
    (AccessibilityInfo.isReduceTransparencyEnabled as jest.Mock).mockResolvedValue(true);
    const screen = render(<GlassSurface role="chrome" testID="surface" />);

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

  test('compact 터치 프레임은 호출자가 지정한 정렬을 우선한다', () => {
    const screen = render(<CompactTouchTarget testID="aligned-target" frameStyle={{ alignItems: 'stretch' }}><Text>제목</Text></CompactTouchTarget>);
    const frame = StyleSheet.flatten(screen.getByTestId('aligned-target').props.style);
    expect(frame.alignItems).toBe('stretch');
    expect(frame.minHeight).toBeGreaterThanOrEqual(44);
  });

  test('__DEV__에서는 synthetic direct same-role 중첩을 명시적으로 실패시킨다', () => {
    expect(() => render(
      <GlassSurface role="glassCard">
        <GlassSurface role="glassCard" />
      </GlassSurface>,
    )).toThrow('Nested GlassSurface role is not allowed: glassCard');
  });

  test('보드 모달의 상세 패널은 바깥 패널과 별개인 솔리드 표면을 쓴다', () => {
    const screen = render(<GlassSurface role="glassSoft">
      <AppModalSurface visible variant="board" modalId="modal_card_detail" onRequestClose={() => {}}>
        <GlassSurface role="glassSoft" testID="board-detail" />
      </AppModalSurface>
    </GlassSurface>);
    expect(backgroundColorOf(screen.getByTestId('board-detail').props.style)).toBe('#0f1115');
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
  const screen = render(<PlannerForegroundCard role="chrome" glassTestID="today-radius" cornerRadius={DESIGN_RADIUS.lg}><Text>오늘</Text></PlannerForegroundCard>);
  expect(StyleSheet.flatten(screen.getByTestId('native-today-radius').props.style).borderRadius).toBe(16);
  screen.unmount();
  mockNativeAvailable.mockReturnValue(false);
  const fallback = render(<PlannerForegroundCard role="chrome" glassTestID="today-radius" cornerRadius={DESIGN_RADIUS.lg}><Text>오늘</Text></PlannerForegroundCard>);
  expect(StyleSheet.flatten(fallback.getByTestId('blur-today-radius').props.style).borderRadius).toBe(16);
});
