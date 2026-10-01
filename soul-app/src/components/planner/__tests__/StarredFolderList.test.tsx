import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { StarredFolderList } from '../StarredFolderList';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

const folder = {
  page: {
    id: 'starred-1', title: '별표 업무', dailyDate: null, version: 1,
    archived: false, metadata: { starred: true }, createdAt: '', updatedAt: '',
  },
  blocks: [], folderId: 'task-1', folderSummary: null, status: 'open', assignee: '담당 미확인',
  contextCount: 0, progress: null, projectPageId: null, sessions: [], sessionIds: [],

} as PlannerFolder;

test('별표 full task를 공통 PlannerFolderRow로 렌더하고 direct-open 계약을 전달한다', () => {
  const onSelect = jest.fn();
  const onLongPress = jest.fn();
  const screen = render(
    <StarredFolderList
      folders={[folder]}
      loading={false}
      error={null}
      hasMore={false}
      onLoadMore={jest.fn()}
      onSelect={onSelect}
      onLongPress={onLongPress}
    />,
  );

  const card = screen.getByTestId('planner-task-row-starred-1');
  fireEvent.press(card);
  fireEvent(card, 'longPress');

  expect(onSelect).toHaveBeenCalledWith(folder);
  expect(onLongPress).toHaveBeenCalledWith(folder);
});
