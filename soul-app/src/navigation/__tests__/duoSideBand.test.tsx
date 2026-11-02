import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { DuoSideBandContext, DuoTopBandContext } from '../tabContract';
import { DUO_RAIL_END_INSET, getDuoRailTopOffset, hasDuoSideBand, hasDuoTopBand, splitDuoRailBackAction, useDuoSideBand, useDuoTopBand } from '../duoSideBand';

test('듀오 레일의 상단 위치와 시스템 영역 중심에 맞는 가로 정렬', () => {
  expect((84 - DUO_RAIL_END_INSET) / 2).toBe(36);
  expect(getDuoRailTopOffset(466, 678)).toBe(228);
  expect(getDuoRailTopOffset(678, 466)).toBe(114);
  expect(getDuoRailTopOffset(951, 669)).toBe(200);
  const back = { id: 'back' }, next = { id: 'next' };
  expect(splitDuoRailBackAction([back, next])).toEqual({ backAction: back, mainActions: [next] });
  expect(splitDuoRailBackAction([{ id: 'close' }])).toEqual({ backAction: { id: 'close' }, mainActions: [] });
  expect(splitDuoRailBackAction([next, back])).toEqual({ backAction: null, mainActions: [next, back] });
});

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

test('듀오 상단 띠는 iOS 안쪽 세로 safe area에서만 감지한다', () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  const portrait = { top: 82, bottom: 24, left: 0, right: 0 };
  expect(hasDuoTopBand(portrait)).toBe(true);
  expect(hasDuoTopBand({ ...portrait, top: 24 })).toBe(false);
  expect(hasDuoTopBand({ ...portrait, right: 84 })).toBe(false);
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  expect(hasDuoTopBand(portrait)).toBe(false);
  Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
});

test('상단 띠 harness 값이 safe area 자동 판정보다 우선한다', () => {
  const result = renderHook(() => useDuoTopBand(), { wrapper: ({ children }) =>
    <SafeAreaInsetsContext.Provider value={{ top: 82, bottom: 24, left: 0, right: 0 }}>
      <DuoTopBandContext.Provider value={false}>{children}</DuoTopBandContext.Provider>
    </SafeAreaInsetsContext.Provider> });
  expect(result.result.current).toBe(false);
  result.unmount();
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
