jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { CardStatusMenu } from '../CardStatusMenu';
import { cardFixture } from '../../../test-support/cards';

test('menu failure stays visible, successful explicit move closes only after save', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const card = cardFixture({ status: 'review', version: 9 });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
    executeCard: jest.fn().mockRejectedValueOnce(new Error('저장 실패')).mockResolvedValue({ card: { ...card, status: 'running', version: 10 }, execution: {requestId:'request',sessionId:'session',state:'started'} }) };
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={api as any} card={card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('실행 중로 이동')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('실행 중로 이동')));
  expect(close).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('재실행 사유')).toBeNull();
  const reason = '연결을 확인한 뒤 다시 시도해 주세요.';
  expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  expect(screen.queryByText('저장 실패')).toBeNull();
  expect(Alert.alert).toHaveBeenCalledWith('카드 변경 실패', reason);
  const firstRequest = api.executeCard.mock.calls[0];
  await act(async () => fireEvent.press(screen.getByText('다시 시도')));
  expect(api.executeCard).toHaveBeenCalledTimes(2);
  expect(api.executeCard).toHaveBeenLastCalledWith(...firstRequest);
  expect(close).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});

 test('상태 목록에서 보고 없이 검수를 선택한다', async () => {
  const card = cardFixture({ status: 'todo' });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }), setCardStatus: jest.fn().mockResolvedValue({card: {...card,status:'review'}}) };
  const screen = render(<CardStatusMenu api={api as any} card={card} onClose={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('검수 대기로 이동')).toBeTruthy());
  expect(screen.queryByText(/보고가 필요/)).toBeNull();
  expect(screen.queryByText(/현재/)).toBeNull();
  expect(screen.queryByText(/직접 옮길 수 없/)).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('검수 대기로 이동')));
  expect(api.setCardStatus).toHaveBeenCalled();
 });
