import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUIStore } from '../../../store/uiStore';
import { SplitLayout } from '../SplitLayout';

let mockWindow = { width: 1366, height: 1024, scale: 1, fontScale: 1 };

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../hooks/useSessionsStream', () => ({
  useSessionsStream: jest.fn(),
}));
jest.mock('../../../hooks/useNodeConnectivityStream', () => ({
  useNodeConnectivityStream: jest.fn(),
}));
jest.mock('../ThreePaneLayout', () => ({
  ThreePaneLayout: () => require('react').createElement(
    require('react-native').View,
    { testID: 'three-pane-layout' },
  ),
}));
jest.mock('../TwoPaneWithDrawer', () => ({
  TwoPaneWithDrawer: () => require('react').createElement(
    require('react-native').View,
    { testID: 'two-pane-layout' },
  ),
}));

describe('SplitLayout persisted width hydration gate', () => {
  let hydrated = false;
  let finishHydration: ((state: ReturnType<typeof useUIStore.getState>) => void) | undefined;

  beforeEach(() => {
    hydrated = false;
    finishHydration = undefined;
    mockWindow = { width: 1366, height: 1024, scale: 1, fontScale: 1 };
    jest.spyOn(useUIStore.persist, 'hasHydrated').mockImplementation(() => hydrated);
    jest.spyOn(useUIStore.persist, 'onHydrate').mockImplementation(() => jest.fn());
    jest.spyOn(useUIStore.persist, 'onFinishHydration').mockImplementation((listener) => {
      finishHydration = listener;
      return jest.fn();
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('저장 폭 hydration 전에는 기본 폭의 split shell을 그리지 않는다', () => {
    const screen = render(<SplitLayout />);

    expect(screen.queryByTestId('three-pane-layout')).toBeNull();

    act(() => {
      hydrated = true;
      finishHydration?.(useUIStore.getState());
    });

    expect(screen.getByTestId('three-pane-layout')).toBeTruthy();
  });

  test('이미 hydration이 끝났으면 방향에 맞는 shell을 첫 렌더에 표시한다', () => {
    hydrated = true;
    mockWindow = { width: 1024, height: 1366, scale: 1, fontScale: 1 };

    const screen = render(<SplitLayout />);

    expect(screen.getByTestId('two-pane-layout')).toBeTruthy();
  });

  test('안전 영역 1068 이상에서만 3단을 그린다', () => {
    hydrated = true;
    mockWindow = { width: 1024, height: 768, scale: 1, fontScale: 1 };

    const twoPane = render(<SplitLayout />);
    expect(twoPane.getByTestId('two-pane-layout')).toBeTruthy();
    twoPane.unmount();

    mockWindow = { width: 1068, height: 768, scale: 1, fontScale: 1 };
    const threePane = render(<SplitLayout />);
    expect(threePane.getByTestId('three-pane-layout')).toBeTruthy();
  });

  test('저장소 hydration이 실패하면 기본 폭 shell로 복구한다', async () => {
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(
      new Error('storage unavailable'),
    );
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const screen = render(<SplitLayout />);

    expect(screen.queryByTestId('three-pane-layout')).toBeNull();

    await act(async () => {
      await useUIStore.persist.rehydrate();
    });

    expect(screen.getByTestId('three-pane-layout')).toBeTruthy();
    expect(console.error).toHaveBeenCalledWith(
      '[uiStore] persisted pane width hydration failed',
      expect.any(Error),
    );
  });
});
