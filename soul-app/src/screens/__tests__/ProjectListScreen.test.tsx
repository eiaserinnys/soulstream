import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { Folder } from '../../api/types';
import { useSessionStore } from '../../store/sessionStore';

let mockDimensions = {
  width: 390,
  height: 844,
  scale: 3,
  fontScale: 1,
};

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createRootFolder: jest.fn(), createFolder: jest.fn() }),
}));
jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openProjectMenu: jest.fn() }),
}));

import {
  ProjectHeaderAddButton,
  ProjectListScreen,
  resolveProjectGlassPanelHeight,
} from '../ProjectListScreen';

const folders = [
  { id: 'child', name: 'Child', parentFolderId: 'parent', projectPageId: 'child-page', sortOrder: 0 },
  { id: 'parent', name: '🧪 Parent', parentFolderId: null, projectPageId: 'parent-page', sortOrder: 1 },
] satisfies Folder[];

beforeEach(() => {
  useSessionStore.setState({ catalog: { folders, sessions: {} } });
});

test.each([
  ['phone', 44],
  ['tabletPortrait', 48],
] as const)('%s 프로젝트 header + 버튼은 %ipt 실제 터치 영역을 쓴다', (device, size) => {
  mockDimensions = device === 'phone'
    ? { width: 390, height: 844, scale: 3, fontScale: 1 }
    : { width: 820, height: 1180, scale: 2, fontScale: 1 };
  const screen = render(<ProjectHeaderAddButton />);
  expect(StyleSheet.flatten(screen.getByTestId('project-header-add').props.style)).toMatchObject({
    width: size,
    height: size,
  });
});

test('프로젝트 계층은 기본 접힘이고 disclosure로 부모 바로 아래에 자식을 연다', () => {
  const screen = render(<ProjectListScreen />);
  expect(screen.queryByTestId('project-list-glass-background')).toBeNull();
  expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style))
    .toMatchObject({ position: 'absolute', height: 0 });
  fireEvent(screen.getByTestId('project-list-root'), 'layout', {
    nativeEvent: { layout: { height: 200 } },
  });
  const rootChildren = screen.getByTestId('project-list-root').children
    .filter((child: any) => typeof child !== 'string')
    .map((child: any) => child.props.testID);
  expect(rootChildren).toEqual(['project-list-glass-background', 'project-list-scroll']);
  const glassFrame = StyleSheet.flatten(
    screen.getByTestId('project-list-glass-background').props.style,
  );
  const scrollFrame = StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style);
  expect(glassFrame).toMatchObject({
    position: 'absolute',
    top: 16,
    right: 20,
    left: 20,
    height: 64,
    borderRadius: 18,
  });
  expect(glassFrame.bottom).toBeUndefined();
  expect(scrollFrame).toMatchObject({
    position: 'absolute',
    top: 16,
    right: 20,
    left: 20,
    height: 64,
    borderRadius: 18,
    overflow: 'hidden',
  });
  expect(screen.getByText('🧪')).toBeTruthy();
  expect(screen.getByText('Parent')).toBeTruthy();
  expect(screen.queryByText('Child')).toBeNull();
  expect(screen.queryByText('프로젝트')).toBeNull();
  expect(screen.queryByText('새 프로젝트')).toBeNull();

  fireEvent.press(screen.getByTestId('project-disclosure-parent'));
  expect(screen.getByText('Child')).toBeTruthy();
  const sheet = screen.getByTestId('project-tree-sheet');
  expect(StyleSheet.flatten(sheet.props.style).marginLeft).toBeUndefined();
  expect(StyleSheet.flatten(sheet.props.style).borderColor).toBeUndefined();
  const childContent = screen.getByTestId('project-row-inner-child');
  expect(StyleSheet.flatten(childContent.props.style).paddingLeft).toBe(24);
});

test('프로젝트 고정 글래스는 짧은 콘텐츠 높이를 쓰고 긴 콘텐츠만 안전 높이로 자른다', () => {
  expect(resolveProjectGlassPanelHeight({
    hasRows: false,
    contentHeight: 128,
    viewportHeight: 844,
    verticalInset: 16,
  })).toBe(0);
  expect(resolveProjectGlassPanelHeight({
    hasRows: true,
    contentHeight: 128,
    viewportHeight: 0,
    verticalInset: 16,
  })).toBe(0);
  expect(resolveProjectGlassPanelHeight({
    hasRows: true,
    contentHeight: 128,
    viewportHeight: 844,
    verticalInset: 16,
  })).toBe(128);
  expect(resolveProjectGlassPanelHeight({
    hasRows: true,
    contentHeight: 900,
    viewportHeight: 844,
    verticalInset: 16,
  })).toBe(812);
});

test('프로젝트 패널과 ScrollView는 콘텐츠 실측과 viewport clamp를 같은 높이로 공유한다', () => {
  const screen = render(<ProjectListScreen />);
  fireEvent(screen.getByTestId('project-list-root'), 'layout', {
    nativeEvent: { layout: { height: 200 } },
  });
  fireEvent(screen.getByTestId('project-list-scroll'), 'contentSizeChange', 350, 400);

  expect(StyleSheet.flatten(
    screen.getByTestId('project-list-glass-background').props.style,
  ).height).toBe(168);
  expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style).height)
    .toBe(168);

  fireEvent(screen.getByTestId('project-list-scroll'), 'contentSizeChange', 350, 96);
  expect(StyleSheet.flatten(
    screen.getByTestId('project-list-glass-background').props.style,
  ).height).toBe(96);
  expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style).height)
    .toBe(96);
});

test('프로젝트가 없으면 빈 글래스 패널을 만들지 않는다', () => {
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
  const screen = render(<ProjectListScreen />);
  expect(screen.queryByTestId('project-list-glass-background')).toBeNull();
  expect(screen.getByText('프로젝트가 없습니다.')).toBeTruthy();
});

test.each([
  ['phone', 1, 390, 844, 44],
  ['phone-large-text', 2, 390, 844, 44],
  ['iPad', 1, 820, 1180, 48],
  ['iPad-large-text', 2, 820, 1180, 48],
] as const)(
  '%s 프로젝트 트리는 fontScale %d에서 고정 높이 없이 열 계약을 실제 렌더한다',
  (_label, fontScale, width, height, actionSize) => {
    mockDimensions = { width, height, scale: 2, fontScale };
    const screen = render(<ProjectListScreen />);
    expect(StyleSheet.flatten(screen.getByTestId('project-list-scroll').props.style))
      .toMatchObject({ left: 20, right: 20 });
    expect(StyleSheet.flatten(
      screen.getByTestId('project-list-scroll').props.contentContainerStyle,
    )).toMatchObject({ paddingHorizontal: 0 });
    expect(StyleSheet.flatten(screen.getByText('Parent').props.style)).toMatchObject({
      fontSize: 16,
      lineHeight: 22,
    });
    const row = screen.getByTestId('project-card-content-parent');
    expect(row.props.accessibilityLabel).toBe('🧪 Parent');
    const rowStyle = StyleSheet.flatten(row.props.style);
    expect(rowStyle).toMatchObject({
      minHeight: 64,
      paddingHorizontal: 12,
      paddingVertical: 8,
    });
    expect(rowStyle.height).toBeUndefined();
    expect(screen.getByText('Parent').props.allowFontScaling).not.toBe(false);
    expect(StyleSheet.flatten(screen.getByTestId('project-leading-parent').props.style))
      .toMatchObject({ width: 24, height: 24 });
    expect(StyleSheet.flatten(screen.getByTestId('project-menu-parent').props.style))
      .toMatchObject({ minWidth: actionSize, minHeight: actionSize });
    expect(StyleSheet.flatten(screen.getByTestId('project-chevron-parent').props.style))
      .toMatchObject({ width: 24, height: 24 });

    const columns = screen.getByTestId('project-row-inner-parent').children
      .filter((child: any) => typeof child !== 'string')
      .map((child: any) => child.props.testID);
    expect(columns).toEqual([
      'project-disclosure-slot-parent',
      'project-leading-parent',
      'project-title-column-parent',
      'project-menu-parent',
      'project-chevron-parent',
    ]);
    expect(StyleSheet.flatten(screen.getByTestId('project-disclosure-slot-parent').props.style))
      .toMatchObject({ width: 16, height: 24 });
    expect(StyleSheet.flatten(screen.getByTestId('project-disclosure-parent').props.style))
      .toMatchObject({ width: actionSize, height: actionSize });

    const pageInset = StyleSheet.flatten(
      screen.getByTestId('project-list-scroll').props.style,
    ).left;
    const rowPadding = rowStyle.paddingHorizontal;
    const rootInner = StyleSheet.flatten(screen.getByTestId('project-row-inner-parent').props.style);
    const disclosureWidth = StyleSheet.flatten(
      screen.getByTestId('project-disclosure-slot-parent').props.style,
    ).width;
    const leadingWidth = StyleSheet.flatten(
      screen.getByTestId('project-leading-parent').props.style,
    ).width;
    expect(pageInset + rowPadding + rootInner.paddingLeft
      + disclosureWidth + rootInner.gap + leadingWidth + rootInner.gap).toBe(88);

    fireEvent.press(screen.getByTestId('project-disclosure-parent'));
    const childRow = StyleSheet.flatten(screen.getByTestId('project-card-content-child').props.style);
    const childInner = StyleSheet.flatten(screen.getByTestId('project-row-inner-child').props.style);
    const childDisclosure = StyleSheet.flatten(
      screen.getByTestId('project-disclosure-slot-child').props.style,
    );
    const childLeading = StyleSheet.flatten(screen.getByTestId('project-leading-child').props.style);
    expect(pageInset + childRow.paddingHorizontal + childInner.paddingLeft
      + childDisclosure.width + childInner.gap + childLeading.width + childInner.gap).toBe(112);
    expect(screen.queryByTestId('project-disclosure-child')).toBeNull();
  },
);
