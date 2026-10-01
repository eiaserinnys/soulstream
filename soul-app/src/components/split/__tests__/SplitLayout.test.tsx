import React from 'react';
import { act, render } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUIStore } from '../../../store/uiStore';
import { SplitLayout } from '../SplitLayout';

let mockDevice: 'tabletLandscape' | 'tabletPortrait' = 'tabletLandscape';

jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDevice,
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
    mockDevice = 'tabletLandscape';
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
    mockDevice = 'tabletPortrait';

    const screen = render(<SplitLayout />);

    expect(screen.getByTestId('two-pane-layout')).toBeTruthy();
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
