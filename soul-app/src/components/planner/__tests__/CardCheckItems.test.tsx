import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import type { CardCheckItem } from '../../../api/cardTypes';
import { CardCheckItems } from '../CardCheckItems';

function item(id: number, display: CardCheckItem['display'], overrides: Partial<CardCheckItem> = {}): CardCheckItem {
  const state = display === 'doing' ? 'doing' : display === 'dropped' ? 'dropped' : display === 'reported' || display === 'changed' ? 'done' : 'todo';
  return { id, title: `항목 ${id}`, state, result: display === 'dropped' ? '범위에서 뺀 이유' : '확인할 결과',
    evidence: [], caveat: null, rev: 1, confirmed: display === 'confirmed' ? { at: '', rev: 1 } : null,
    fixOpen: display === 'fix' ? 2 : 0, reopened: display === 'changed' ? '다시 확인한 이유' : null,
    from: null, createdAt: '', reportedAt: null, display, ...overrides };
}

test('서버 display 일곱 값을 그대로 표시하고 확인·고칠 점 조작을 항목에 연결한다', async () => {
  const onConfirm = jest.fn().mockResolvedValue(true);
  const onSetTarget = jest.fn();
  const screen = render(<CardCheckItems items={[
    item(1, 'todo'), item(2, 'doing'), item(3, 'reported'), item(4, 'changed'),
    item(5, 'fix'), item(6, 'confirmed'), item(7, 'dropped'),
  ]} pendingConfirmations={{}} onConfirm={onConfirm} onSetTarget={onSetTarget} paneWidth={375} />);
  await act(async () => {});

  for (const label of ['아직', '하는 중', '됐다고 보고', '다시 봐 주세요', '고칠 점 2', '확인함', '뺌']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.getByText('범위에서 뺀 이유')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('1 항목 1 확인'));
  expect(onConfirm).toHaveBeenCalledWith(1, true);
  fireEvent.press(screen.getByLabelText('4 항목 4 고칠 점 남기기'));
  expect(onSetTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
});

test('진입 시 확인된 셋은 묶고 확인 해제하면 미확인 목록으로 돌린다', () => {
  const onConfirm = jest.fn().mockResolvedValue(true);
  const onSetTarget = jest.fn();
  const screen = render(<CardCheckItems items={[item(1, 'confirmed'), item(2, 'confirmed'), item(3, 'confirmed'), item(4, 'todo')]}
    pendingConfirmations={{}} onConfirm={onConfirm} onSetTarget={onSetTarget} paneWidth={375} />);

  fireEvent.press(screen.getByLabelText('확인함 3개 펼치기'));
  fireEvent.press(screen.getByLabelText('1 항목 1 확인 해제'));
  expect(onConfirm).toHaveBeenCalledWith(1, false);
  expect(onSetTarget).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  expect(screen.queryByText('확인함 2개')).toBeNull();
  expect(screen.getByText('항목 1')).toBeTruthy();
  expect(screen.getByText('항목 2')).toBeTruthy();
  expect(screen.getByText('항목 3')).toBeTruthy();
});
