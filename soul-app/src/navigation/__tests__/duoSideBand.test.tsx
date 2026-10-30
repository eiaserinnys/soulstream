import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { DuoSideBandContext } from '../tabContract';
import { hasDuoSideBand, useDuoSideBand } from '../duoSideBand';

test('듀오 띠는 iOS 오른쪽 비대칭 안전 영역에서만 감지한다', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const insets = { top: 24, bottom: 24, left: 0, right: 84 };
  expect(hasDuoSideBand(insets)).toBe(true);
  expect(hasDuoSideBand({ ...insets, left: 59, right: 59 })).toBe(false);
  expect(hasDuoSideBand({ ...insets, right: 0 })).toBe(false);
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  expect(hasDuoSideBand(insets)).toBe(false);
  Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
});

test('폰의 원래 판정이 전달되면 덮인 안전 영역보다 우선한다', () => {
  const insets = { top: 24, bottom: 24, left: 0, right: 0 };
  const result = renderHook(() => useDuoSideBand(), { wrapper: ({ children }) =>
    <SafeAreaInsetsContext.Provider value={insets}>
      <DuoSideBandContext.Provider value={true}>{children}</DuoSideBandContext.Provider>
    </SafeAreaInsetsContext.Provider> });
  expect(result.result.current).toBe(true);
  result.unmount();
});
