import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo, Animated } from 'react-native';
import { cancelAnimation, withRepeat, withTiming } from 'react-native-reanimated';
import { useSessionCardAnimation } from '../useSessionCardAnimation';

// This verifies scheduling and gates, not native frame rate or CPU/heat.
const repeat = withRepeat as jest.Mock;
const cancel = cancelAnimation as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
});

test('visible running card uses UI-runtime repeats with the original periods and no RN timing', async () => {
  const timing = jest.spyOn(Animated, 'timing');
  const loop = jest.spyOn(Animated, 'loop').mockReturnValue({ start: jest.fn(), stop: jest.fn() } as never);
  const view = renderHook(() => useSessionCardAnimation({ isRunning: true, animationActive: true }));
  await act(async () => {});
  expect(repeat.mock.calls.map((call) => call.slice(1, 3))).toEqual([[-1, true], [-1, false]]);
  expect((withTiming as jest.Mock).mock.calls.map(([value, config]) => [value, config.duration]))
    .toEqual([[1, 1500], [1, 2800]]);
  expect(timing).not.toHaveBeenCalled();
  view.unmount();
  timing.mockRestore();
  loop.mockRestore();
});

test('visibility, foreground, completion and unmount cancel/reset both values; metadata rerender does not restart', async () => {
  const view = renderHook(({ running, visible }: { running: boolean; visible: boolean }) => useSessionCardAnimation({
    isRunning: running, animationActive: visible,
  }), { initialProps: { running: true, visible: false } });
  await act(async () => {});
  expect(repeat).not.toHaveBeenCalled();
  view.rerender({ running: true, visible: true });
  expect(repeat).toHaveBeenCalledTimes(2);
  view.rerender({ running: true, visible: true });
  expect(repeat).toHaveBeenCalledTimes(2);
  view.rerender({ running: true, visible: false });
  expect(view.result.current.pulse.value).toBe(0);
  expect(view.result.current.shimmer.value).toBe(0);
  view.rerender({ running: true, visible: true });
  expect(repeat).toHaveBeenCalledTimes(4);
  cancel.mockClear();
  act(() => {
    for (const listener of (globalThis as any).__appStateListeners) listener('background');
    expect(cancel).toHaveBeenCalledTimes(2);
  });
  expect(view.result.current.animationEnabled).toBe(false);
  act(() => {
    for (const listener of (globalThis as any).__appStateListeners) listener('active');
  });
  expect(repeat).toHaveBeenCalledTimes(6);
  view.rerender({ running: false, visible: true });
  expect(view.result.current.animationEnabled).toBe(false);
  cancel.mockClear();
  view.unmount();
  expect(cancel).toHaveBeenCalledWith(view.result.current.pulse);
  expect(cancel).toHaveBeenCalledWith(view.result.current.shimmer);
});

test('reduced motion stops both repeats while the running card remains visible', async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
  const view = renderHook(() => useSessionCardAnimation({ isRunning: true }));
  await act(async () => {});
  expect(view.result.current.animationEnabled).toBe(false);
  expect(view.result.current.pulse.value).toBe(0);
  expect(view.result.current.shimmer.value).toBe(0);
});
