import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { act, render, renderHook } from '@testing-library/react-native';
import { Easing, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTokens } from '../../../theme';
import { UndoCountdownRing } from '../UndoCountdownRing';

const sharedValue = useSharedValue as jest.Mock;
const timing = withTiming as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-22T00:00:00.000Z'));
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
});

afterEach(() => jest.useRealTimers());

test('renders the SVG ring at the metadata line height and hides it from accessibility', async () => {
  const t = renderHook(() => useTokens()).result.current;
  const view = render(<UndoCountdownRing expiresAt={Date.now() + 5000} durationMs={5000} />);
  await act(async () => {});
  const ring = view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring' });
  const ringStyle = StyleSheet.flatten(ring.props.style);

  expect(ringStyle.width).toBe(t.foundation.typography.meta.lineHeight);
  expect(ringStyle.height).toBe(t.foundation.typography.meta.lineHeight);
  expect(view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-track' })).toBeTruthy();
  expect(view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-progress' })).toBeTruthy();
  expect(ring.props.accessibilityElementsHidden).toBe(true);
  expect(ring.props.importantForAccessibility).toBe('no-hide-descendants');
  expect(ring.props['aria-hidden']).toBe(true);
});

test('starts continuous progress at elapsed time and resumes from expiresAt after remount', async () => {
  const expiresAt = Date.now() + 5000;
  const first = render(<UndoCountdownRing expiresAt={expiresAt} durationMs={5000} />);
  await act(async () => {});
  expect(sharedValue).toHaveBeenLastCalledWith(0);
  expect(timing).toHaveBeenLastCalledWith(1, { duration: 5000, easing: Easing.linear });
  first.unmount();

  await act(async () => { jest.advanceTimersByTime(2000); });
  sharedValue.mockClear();
  timing.mockClear();
  const resumed = render(<UndoCountdownRing expiresAt={expiresAt} durationMs={5000} />);
  await act(async () => {});

  expect(sharedValue).toHaveBeenLastCalledWith(0.4);
  expect(timing).toHaveBeenLastCalledWith(1, { duration: 3000, easing: Easing.linear });
  resumed.unmount();
});

test('reduced motion advances in five discrete one-second steps', async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
  const view = render(<UndoCountdownRing expiresAt={Date.now() + 5000} durationMs={5000} />);
  await act(async () => {});

  const progress = sharedValue.mock.results.at(-1)?.value;
  expect(progress.value).toBe(0);
  expect(timing).not.toHaveBeenCalled();
  for (let step = 1; step <= 4; step += 1) {
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(progress.value).toBe(step / 5);
  }
  view.unmount();
});
