import { act, renderHook } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { cancelAnimation, withRepeat } from 'react-native-reanimated';
import { useSwayCharacterAnimation } from '../useSwayCharacterAnimation';

const repeat = withRepeat as jest.Mock;
const cancel = cancelAnimation as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as any).__appStateListeners = [];
});

test('starts only after reduced-motion is known and resets to still for every inactive gate', async () => {
  let resolveReducedMotion!: (value: boolean) => void;
  let reducedMotionListener!: (value: boolean) => void;
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockReturnValue(
    new Promise<boolean>((resolve) => { resolveReducedMotion = resolve; }),
  );
  (AccessibilityInfo.addEventListener as jest.Mock).mockImplementation((_event, listener) => {
    reducedMotionListener = listener;
    return { remove: jest.fn() };
  });

  const view = renderHook<ReturnType<typeof useSwayCharacterAnimation>, { motionEnabled: boolean; active: boolean; shown: boolean }>(
    ({ motionEnabled, active, shown }) => useSwayCharacterAnimation({
    motionEnabled,
    active,
    shown,
    }), { initialProps: { motionEnabled: true, active: true, shown: true } });

  expect(repeat).not.toHaveBeenCalled();
  expect(view.result.current.phase.value).toBe(0);

  await act(async () => resolveReducedMotion(false));
  expect(repeat).toHaveBeenCalledTimes(1);

  act(() => reducedMotionListener(true));
  expect(view.result.current.phase.value).toBe(0);
  expect(repeat).toHaveBeenCalledTimes(1);
  act(() => reducedMotionListener(false));
  expect(repeat).toHaveBeenCalledTimes(2);

  view.rerender({ motionEnabled: false, active: true, shown: true });
  expect(view.result.current.phase.value).toBe(0);
  expect(cancel).toHaveBeenCalledWith(view.result.current.phase);

  view.rerender({ motionEnabled: true, active: true, shown: true });
  expect(repeat).toHaveBeenCalledTimes(3);

  act(() => {
    for (const listener of (globalThis as any).__appStateListeners) listener('background');
  });
  expect(view.result.current.phase.value).toBe(0);

  act(() => {
    for (const listener of (globalThis as any).__appStateListeners) listener('active');
  });
  expect(repeat).toHaveBeenCalledTimes(4);
  view.rerender({ motionEnabled: true, active: false, shown: true });
  expect(view.result.current.phase.value).toBe(0);
  view.rerender({ motionEnabled: true, active: true, shown: false });
  expect(view.result.current.phase.value).toBe(0);
  expect(repeat).toHaveBeenCalledTimes(4);
  view.unmount();
});
