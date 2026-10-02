import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ProjectListScreen } from '../../screens/ProjectListScreen';
import { useSessionStore } from '../../store/sessionStore';
import { usePlannerStore } from '../../store/plannerStore';
import { folders as defaultFolders } from '../fixtures';
import { createFolderReviewFixture, installFolderReviewScope } from '../longFolderFixtures';

// Same icon mock as the production ProjectListScreen render suite; font loading
// is outside the height/lifecycle contract being observed here.
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
let mockNativeAvailable = false;
jest.mock('expo-glass-effect', () => ({
  GlassView: (props: unknown) => require('react').createElement(require('react-native').View, props),
  isLiquidGlassAvailable: () => mockNativeAvailable,
  isGlassEffectAPIAvailable: () => mockNativeAvailable,
}));

test('긴 목록은 샘플 안에서만 설치되고 종료하면 기존 목록을 복구한다', () => {
  const catalog = useSessionStore.getState().catalog;
  const starred = usePlannerStore.getState().starred;
  const restore = installFolderReviewScope(createFolderReviewFixture('long'));
  expect(useSessionStore.getState().catalog.folders).toHaveLength(100);
  expect(usePlannerStore.getState().starred.items).toHaveLength(100);
  expect(defaultFolders).toHaveLength(2);
  restore();
  expect(useSessionStore.getState().catalog).toBe(catalog);
  expect(usePlannerStore.getState().starred).toBe(starred);
});

test('운영 프로젝트 목록은 첫 layout 전 콘텐츠 높이이고 layout 후 화면 높이로 제한된다', () => {
  const restore = installFolderReviewScope(createFolderReviewFixture('long'));
  const screen = render(<ProjectListScreen />);
  const background = () => screen.getByTestId('project-list-glass-background');
  const firstHeight = StyleSheet.flatten(background().props.style).height as number;
  expect(firstHeight).toBeGreaterThan(6000);
  const originalInstance = background();
  fireEvent(screen.getByTestId('project-list-root'), 'layout', { nativeEvent: { layout: { height: 844 } } });
  expect(StyleSheet.flatten(background().props.style).height).toBeLessThan(844);
  expect(background()).toBe(originalInstance);
  screen.unmount(); restore();
});

test('네이티브 효과 경로도 첫 layout 전에 전체 높이를 받고 같은 인스턴스를 축소한다', () => {
  mockNativeAvailable = true;
  const restore = installFolderReviewScope(createFolderReviewFixture('long'));
  const screen = render(<ProjectListScreen />);
  const first = screen.getByTestId('project-list-glass-background');
  const firstHeight = StyleSheet.flatten(first.props.style).height;
  expect(first.props.glassEffectStyle).toBe('regular');
  expect(firstHeight).toBeGreaterThan(6000);
  fireEvent(screen.getByTestId('project-list-root'), 'layout', { nativeEvent: { layout: { height: 844 } } });
  const after = screen.getByTestId('project-list-glass-background');
  expect(after).toBe(first);
  expect(StyleSheet.flatten(after.props.style).height).toBe(812);
  console.log('native props observation', { firstHeight, afterHeight: 812, remounted: false, renderer: 'mock View; no UIKit rendering' });
  screen.unmount(); restore(); mockNativeAvailable = false;
});
