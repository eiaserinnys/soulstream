import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { PlannerBlock } from '../../../api/plannerTypes';
import { DailyMemo } from '../DailyMemo';
import { StyleSheet, TextInput } from 'react-native';

jest.mock('../../../theme', () => ({
  ...jest.requireActual('../../../theme'),
  useDeviceType: () => 'phone',
}));

test('드래프트 편집 중 refetch로 block identity가 바뀌어도 입력을 보존한다', () => {
  const block = {
    id: 'memo-1', pageId: 'daily-1', parentId: null, positionKey: 'a',
    blockType: 'paragraph', text: '서버 값', properties: {},
    collapsed: false, archived: false, createdAt: '', updatedAt: '',
  } as PlannerBlock;
  const onSave = jest.fn();
  const screen = render(<DailyMemo blocks={[block]} onSave={onSave} />);

  fireEvent.changeText(screen.getByDisplayValue('서버 값'), '작성 중인 값');
  screen.rerender(<DailyMemo blocks={[{ ...block }]} onSave={onSave} />);

  expect(screen.getByDisplayValue('작성 중인 값')).toBeTruthy();
  expect(onSave).not.toHaveBeenCalled();
});


test('빈 폰 메모는 제목·추가 버튼 없이 높이 56의 한 입력 상자다', () => {
  const screen = render(<DailyMemo blocks={[]} onSave={jest.fn()} />);
  expect(screen.queryByText('메모')).toBeNull();
  expect(screen.queryByTestId('daily-memo-add-action')).toBeNull();
  expect(screen.getByPlaceholderText('오늘 기억해 둘 내용을 적으세요.')).toBeTruthy();
  expect(screen.UNSAFE_getAllByType(TextInput)).toHaveLength(1);
  expect(StyleSheet.flatten(screen.getByTestId('daily-memo-box').props.style))
    .toMatchObject({ minHeight: 56, paddingHorizontal: 16, paddingVertical: 0 });
});

test.each(['submitEditing', 'blur'])('폰 새 메모는 %s로 저장하고 입력을 비운다', async (event) => {
  const onSave = jest.fn(async () => undefined);
  const screen = render(<DailyMemo blocks={[]} onSave={onSave} />);
  fireEvent.changeText(screen.getByTestId('daily-memo-new-input'), '기억할 내용');
  await act(async () => { fireEvent(screen.getByTestId('daily-memo-new-input'), event); });
  expect(onSave).toHaveBeenCalledWith(null, '기억할 내용');
  expect(screen.getByTestId('daily-memo-new-input').props.value).toBe('');
});

test.each(['submitEditing', 'blur'])('폰 기존 메모는 %s로 저장하고 마지막에 새 입력 줄을 둔다', async (event) => {
  const block = { id: 'memo-1', text: '기존 메모' } as PlannerBlock;
  const onSave = jest.fn(async () => undefined);
  const screen = render(<DailyMemo blocks={[block]} onSave={onSave} />);
  fireEvent.changeText(screen.getByTestId('daily-memo-memo-1-input'), '수정한 메모');
  await act(async () => { fireEvent(screen.getByTestId('daily-memo-memo-1-input'), event); });
  expect(onSave).toHaveBeenCalledWith('memo-1', '수정한 메모');
  const inputs = screen.UNSAFE_getAllByType(TextInput);
  expect(inputs.map((input) => input.props.testID))
    .toEqual(['daily-memo-memo-1-input', 'daily-memo-new-input']);
});
