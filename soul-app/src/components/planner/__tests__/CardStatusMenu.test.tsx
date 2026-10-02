jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { CardStatusMenu } from '../CardStatusMenu';
import { cardFixture } from '../../../test-support/cards';

test('menu reason and failure stay visible, successful explicit move closes only after save', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const card = cardFixture({ status: 'review', version: 9 });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
    setCardStatus: jest.fn().mockRejectedValueOnce(new Error('저장 실패')).mockResolvedValue({ card: { ...card, status: 'running', version: 10 } }) };
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={api as any} card={card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('실행 중로 이동')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('실행 중로 이동')));
  fireEvent.changeText(screen.getByLabelText('재실행 사유'), '다시 확인합니다');
  await act(async () => fireEvent.press(screen.getByLabelText('사유와 함께 실행 중으로 이동')));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('재실행 사유').props.value).toBe('다시 확인합니다');
  expect(screen.getByText('저장 실패')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('사유와 함께 실행 중으로 이동')));
  expect(api.setCardStatus).toHaveBeenLastCalledWith(card.id, 'running', 9, expect.any(String), '다시 확인합니다');
  expect(close).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});

 test('상태 목록은 이름만 보여주며 보고/질문 제한은 유지한다', async () => {
  const card = cardFixture({ status: 'todo' });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }), setCardStatus: jest.fn() };
  const screen = render(<CardStatusMenu api={api as any} card={card} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('검수 대기로 이동')).toBeTruthy());
  expect(screen.queryByText(/보고가 필요/)).toBeNull();
  expect(screen.queryByText(/현재/)).toBeNull();
  expect(screen.queryByText(/직접 옮길 수 없/)).toBeNull();
  fireEvent.press(screen.getByLabelText('검수 대기로 이동'));
  expect(api.setCardStatus).not.toHaveBeenCalled();
 });
