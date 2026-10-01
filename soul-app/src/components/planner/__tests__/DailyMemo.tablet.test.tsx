jest.mock('../../../theme', () => ({
  ...jest.requireActual('../../../theme'),
  useDeviceType: () => 'tabletPortrait',
}));
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: ({ markdown, testID }: { markdown: string; testID?: string }) => (
      React.createElement(Text, { testID }, markdown)
    ),
  };
});

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { PlannerBlock } from '../../../api/plannerTypes';
import { DailyMemo } from '../DailyMemo';
import { useAuthStore } from '../../../store/authStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

const block = {
  id: 'memo-1',
  pageId: 'daily-1',
  parentId: null,
  positionKey: 'a',
  blockType: 'paragraph',
  text: '# 마크다운 메모',
  properties: {},
  collapsed: false,
} as PlannerBlock;

beforeEach(() => {
  useAuthStore.getState().setJwt('account-a');
  resetAuthScopeForTest();
});

test('iPad 데일리 설명은 markdown read/plain edit이며 refetch 중 dirty draft를 보존한다', () => {
  const screen = render(<DailyMemo blocks={[block]} onSave={jest.fn()} />);

  expect(screen.getByTestId('daily-memo-memo-1-markdown')).toHaveTextContent('# 마크다운 메모');
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-edit-action'));
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), '작성 중');
  screen.rerender(<DailyMemo blocks={[{ ...block }]} onSave={jest.fn()} />);

  expect(screen.getByDisplayValue('작성 중')).toBeTruthy();
  expect(screen.getByTestId('daily-memo-memo-1-input').props.multiline).toBe(true);
  expect(screen.getByTestId('daily-memo-memo-1-save-action')).toBeTruthy();
});

test('iPad 데일리 저장 성공 후 새 markdown을 읽기 상태로 표시하고 dirty 액션을 숨긴다', async () => {
  const save = jest.fn(async () => undefined);
  const screen = render(<DailyMemo blocks={[block]} onSave={save} />);
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-edit-action'));
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), '저장된 메모');
  await act(async () => {
    fireEvent.press(screen.getByTestId('daily-memo-memo-1-save-action'));
  });

  await waitFor(() => expect(save).toHaveBeenCalledWith('memo-1', '저장된 메모'));
  await waitFor(() => expect(screen.getByTestId('daily-memo-memo-1-markdown'))
    .toHaveTextContent('저장된 메모'));
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-edit-action'));
  expect(screen.queryByTestId('daily-memo-memo-1-save-action')).toBeNull();
});

test('iPad 데일리 저장 중 추가 입력은 제출 snapshot 뒤에도 dirty draft로 남는다', async () => {
  let release!: () => void;
  const save = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const screen = render(<DailyMemo blocks={[block]} onSave={save} />);
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-edit-action'));
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), '첫 제출');
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-save-action'));
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), '저장 중 추가 입력');

  await act(async () => { release(); });

  expect(save).toHaveBeenCalledWith('memo-1', '첫 제출');
  expect(screen.getByDisplayValue('저장 중 추가 입력')).toBeTruthy();
  expect(screen.getByTestId('daily-memo-memo-1-save-action')).toBeTruthy();
});

test('A 저장의 늦은 성공은 generation 전환 뒤 B draft/serverValues를 변경하지 않는다', async () => {
  let release!: () => void;
  const save = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
  const screen = render(<DailyMemo blocks={[block]} onSave={save} />);
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-edit-action'));
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), 'A 제출');
  fireEvent.press(screen.getByTestId('daily-memo-memo-1-save-action'));

  const blockB = { ...block, text: '# B 계정 메모' };
  await act(async () => {
    useAuthStore.getState().setJwt('account-b');
    screen.rerender(<DailyMemo blocks={[blockB]} onSave={save} />);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId('daily-memo-memo-1-markdown'))
    .toHaveTextContent('# B 계정 메모'));

  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.getByTestId('daily-memo-memo-1-markdown'))
    .toHaveTextContent('# B 계정 메모');
});
