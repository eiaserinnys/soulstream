import React from 'react';
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import { StyleSheet } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { GroupedGlassSheet } from '../GroupedGlassSheet';
import { PlannerFolderRow } from '../PlannerFolderRow';

const folder: PlannerFolder = {
  page: {
    id: 'task-page',
    title: '🧪 아주 긴 전체 업무 제목은 접근성에 그대로 남는다',
    dailyDate: null,
    version: 1,
    archived: false,
    metadata: { starred: true },
    createdAt: '',
    updatedAt: '',
  },
  blocks: [],
  folderId: 'task-id',
  folderSummary: null,
  status: 'in_progress',
  assignee: '로젤린',
  contextCount: 3,
  progress: 40,
  projectPageId: 'project',
  sessions: [],
  sessionIds: [],

};

test('full task 행은 80pt 최소 높이와 한 줄 계층을 grouped sheet 안에서 공유한다', () => {
  const onPress = jest.fn();
  const screen = render(
    <GroupedGlassSheet testID="task-sheet">
      <PlannerFolderRow folder={folder} onPress={onPress} />
      <PlannerFolderRow folder={{ ...folder, page: { ...folder.page, id: 'plain', title: '이모지 없음' } }} />
    </GroupedGlassSheet>,
  );

  const row = screen.getByTestId('planner-task-row-task-page');
  expect(row.props.accessibilityLabel).toBe(folder.page.title);
  expect(StyleSheet.flatten(row.props.style)).toMatchObject({ minHeight: 80 });
  expect(StyleSheet.flatten(row.props.style).height).toBeUndefined();
  expect(screen.getByTestId('planner-task-leading-task-page')).toHaveStyle({ width: 24, height: 24 });
  expect(screen.getByTestId('planner-task-leading-plain')).toHaveStyle({ width: 24, height: 24 });
  expect(screen.getByTestId('planner-task-title-task-page').props).toMatchObject({
    numberOfLines: 1,
    ellipsizeMode: 'tail',
  });
  expect(screen.getByTestId('planner-task-meta-task-page').props).toMatchObject({
    numberOfLines: 1,
    ellipsizeMode: 'tail',
  });
  expect(String(screen.getByTestId('planner-task-meta-task-page').props.children))
    .toContain('컨텍스트 3');
  expect(StyleSheet.flatten(screen.getByTestId('planner-task-status-task-page').props.style).width)
    .toBeGreaterThan(0);
  expect(screen.getAllByTestId('grouped-glass-divider')).toHaveLength(1);

  fireEvent.press(row);
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('상위 폴더 행은 하위 폴더와 같은 프레임에 캡션과 오른쪽 화살표를 둔다', () => {
  const screen = render(<GroupedGlassSheet>
    <PlannerFolderRow folder={folder} parentNavigation onPress={jest.fn()} />
    <PlannerFolderRow folder={{ ...folder, page: { ...folder.page, id: 'child' } }} />
  </GroupedGlassSheet>);
  const parent = screen.getByTestId('planner-task-row-task-page');
  const child = screen.getByTestId('planner-task-row-child');
  expect(StyleSheet.flatten(parent.props.style)).toMatchObject({
    minHeight: StyleSheet.flatten(child.props.style).minHeight,
    paddingHorizontal: StyleSheet.flatten(child.props.style).paddingHorizontal,
    paddingVertical: StyleSheet.flatten(child.props.style).paddingVertical,
  });
  expect(screen.getByText('상위 폴더')).toBeTruthy();
  expect(StyleSheet.flatten(screen.getByTestId('planner-task-parent-arrow').props.style).alignItems)
    .toBe('flex-end');
});
