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

test('긴 운영 목록은 미측정 배경 없이 시작하고 부모 layout 후 화면 높이로 제한된다', () => {
  const restore = installFolderReviewScope(createFolderReviewFixture('long'));
  const screen = render(<ProjectListScreen />);
  const background = () => screen.getByTestId('project-list-glass-background');
  expect(screen.queryByTestId('project-list-glass-background')).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style))
    .toMatchObject({ position: 'absolute', height: 0 });
  fireEvent(screen.getByTestId('project-list-scroll'), 'contentSizeChange', 350, 6500);
  expect(screen.queryByTestId('project-list-glass-background')).toBeNull();
  fireEvent(screen.getByTestId('project-list-root'), 'layout', { nativeEvent: { layout: { height: 844 } } });
  expect(StyleSheet.flatten(background().props.style).height).toBe(812);
  screen.unmount(); restore();
});

test('네이티브 배경은 실측 후에 생성되고 부모 크기 변경에도 같은 인스턴스로 제한된다', () => {
  mockNativeAvailable = true;
  const restore = installFolderReviewScope(createFolderReviewFixture('long'));
  const screen = render(<ProjectListScreen />);
  expect(screen.queryByTestId('project-list-glass-background')).toBeNull();
  fireEvent(screen.getByTestId('project-list-root'), 'layout', { nativeEvent: { layout: { height: 844 } } });
  const first = screen.getByTestId('project-list-glass-background');
  expect(first.props.glassEffectStyle).toBe('regular');
  expect(StyleSheet.flatten(first.props.style).height).toBe(812);
  for (const [viewportHeight, panelHeight] of [[400, 368], [1180, 1148]]) {
    fireEvent(screen.getByTestId('project-list-root'), 'layout', { nativeEvent: { layout: { height: viewportHeight } } });
    const after = screen.getByTestId('project-list-glass-background');
    expect(after).toBe(first);
    expect(StyleSheet.flatten(after.props.style).height).toBe(panelHeight);
    expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style).height).toBe(panelHeight);
  }
  screen.unmount(); restore(); mockNativeAvailable = false;
});
