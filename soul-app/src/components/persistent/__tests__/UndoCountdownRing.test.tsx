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
  const t = renderHook(() => useTokens()).result.current;
  const center = t.foundation.typography.meta.lineHeight / 2;
  expect(resumed.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-svg' }).props.rotation).toBeUndefined();
  const fill = resumed.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-progress' });
  expect(fill.props.rotation).toBe(-90);
  expect(fill.props.originX).toBe(center);
  expect(fill.props.originY).toBe(center);
  resumed.unmount();
});

test('reduced motion uses five separated arcs, starting with one and reaching five by 4.x seconds', async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
  const expiresAt = Date.now() + 5000;
  const view = render(<UndoCountdownRing expiresAt={expiresAt} durationMs={5000} />);
  await act(async () => {});

  const t = renderHook(() => useTokens()).result.current;
  const size = t.foundation.typography.meta.lineHeight;
  const strokeWidth = size * 2 / 24;
  const circumference = 2 * Math.PI * ((size - strokeWidth) / 2);
  const segment = circumference / 5 - strokeWidth;
  const gap = strokeWidth;
  const track = view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-track' });
  const expectedTrack = Array.from({ length: 5 }, () => [segment, gap]).flat();
  const getFillDashArray = () => view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-progress' }).props.strokeDasharray;
  const expectedFill = (count: number) => [...Array.from({ length: count }, () => [segment, gap]).flat(), 0, circumference];

  expect(track.props.strokeDasharray).toEqual(expectedTrack);
  expect(getFillDashArray()).toEqual(expectedFill(1));
  expect(view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-svg' }).props.rotation).toBeUndefined();
  expect(track.props.rotation).toBe(-90);
  expect(track.props.originX).toBe(size / 2);
  expect(track.props.originY).toBe(size / 2);
  const fill = view.UNSAFE_root.findByProps({ testID: 'undo-countdown-ring-progress' });
  expect(fill.props.rotation).toBe(-90);
  expect(fill.props.originX).toBe(size / 2);
  expect(fill.props.originY).toBe(size / 2);
  expect(timing).not.toHaveBeenCalled();

  await act(async () => { jest.advanceTimersByTime(2500); });
  expect(getFillDashArray()).toEqual(expectedFill(3));
  await act(async () => { jest.advanceTimersByTime(2000); });
  expect(getFillDashArray()).toEqual(expectedFill(5));
  view.unmount();
});
