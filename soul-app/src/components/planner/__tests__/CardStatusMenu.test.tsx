jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Alert, Modal } from 'react-native';
import { CardStatusMenu } from '../CardStatusMenu';
import { cardFixture } from '../../../test-support/cards';
import { createCardColorReviewClient } from '../../../component-review/fixture-client';

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

test('취소는 한 번 표시하고 실행 없이 취소 상태만 저장한다', async () => {
  const card = cardFixture({ status: 'todo', version: 3 });
  const api = { getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
    setCardStatus: jest.fn().mockResolvedValue({ card: { ...card, status: 'cancelled', version: 4 } }), executeCard: jest.fn() };
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={api as any} card={card} onClose={close} />);
  await waitFor(() => expect(screen.getAllByLabelText('취소로 이동')).toHaveLength(1));
  await act(async () => fireEvent.press(screen.getByLabelText('취소로 이동')));
  expect(api.setCardStatus).toHaveBeenCalledTimes(1);
  expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'cancelled', 3, expect.any(String), undefined);
  expect(api.executeCard).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test('context 색상 진입은 저장된 색을 표시하고 뒤로는 부모 메뉴 복귀만 요청한다', async () => {
  const fixture = createCardColorReviewClient('success');
  const close = jest.fn(); const back = jest.fn(); const dismissed = jest.fn();
  const screen = render(<CardStatusMenu api={fixture.api} card={fixture.card} entry="color" visible onClose={close}
    onBack={back} onDismiss={dismissed} />);

  await waitFor(() => expect(screen.getByTestId('card-color-option-blue').props.accessibilityState).toMatchObject({ selected: true }));
  expect(screen.queryByLabelText('카드 색상: 하늘')).toBeNull();
  expect(screen.UNSAFE_getByType(Modal).props.onDismiss).toBe(dismissed);
  await act(async () => fireEvent.press(screen.getByTestId('card-color-back')));

  expect(back).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect(fixture.calls).toHaveLength(0);
});

test('컨텍스트에서 선택한 상태는 숨겨진 상태 진입으로 최신 카드에 한 번만 저장한다', async () => {
  const card = cardFixture({ status: 'todo', version: 12 });
  const api = {
    getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
    setCardStatus: jest.fn().mockResolvedValue({ folderId: card.folderId, card: { ...card, status: 'queued', version: 13 } }),
    executeCard: jest.fn(),
  };
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={api as any} card={card} entry="status" visible={false}
    requestedStatus="queued" onClose={close} />);

  await waitFor(() => expect(api.setCardStatus).toHaveBeenCalledTimes(1));
  expect(screen.queryByTestId('card-status-menu')).toBeNull();
  expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'queued', 12, expect.stringMatching(/^soul-app-card-/), undefined);
  expect(api.executeCard).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each(['retry', 'close'])('컨텍스트 상태 첫 조회 실패는 기존 오류 표면을 열고 %s 의도를 지킨다', async (choice) => {
  const card = cardFixture({ status: 'done', version: 12 });
  const fresh = { ...card, version: 19 };
  const api = {
    getCard: jest.fn().mockRejectedValueOnce(new Error('첫 조회 실패')).mockResolvedValue({ card: fresh, reports: [], questions: [], sessions: [] }),
    setCardStatus: jest.fn().mockResolvedValue({ folderId: card.folderId, card: { ...fresh, status: 'queued', version: 20 } }),
    updateCard: jest.fn(), executeCard: jest.fn(),
  };
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={api as any} card={card} visible={false} requestedStatus="queued" onClose={close} />);
  await waitFor(() => expect(screen.getByText('첫 조회 실패')).toBeTruthy());
  expect(screen.UNSAFE_getByType(Modal).props.visible).toBe(true);
  expect(screen.getByLabelText('카드 다시 조회')).toBeTruthy();
  expect(api.setCardStatus).not.toHaveBeenCalled();
  expect(api.updateCard).not.toHaveBeenCalled();
  expect(api.executeCard).not.toHaveBeenCalled();
  if (choice === 'retry') {
    await act(async () => fireEvent.press(screen.getByLabelText('카드 다시 조회')));
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    // Initial/retry reads plus the existing transition preflight and post-save refresh.
    expect(api.getCard).toHaveBeenCalledTimes(4);
    expect(api.setCardStatus).toHaveBeenCalledTimes(1);
    expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'queued', 19, expect.stringMatching(/^soul-app-card-/), undefined);
  } else {
    fireEvent.press(screen.getByLabelText('상태 메뉴 닫기'));
    expect(close).toHaveBeenCalledTimes(1);
    expect(api.getCard).toHaveBeenCalledTimes(1);
    expect(api.setCardStatus).not.toHaveBeenCalled();
  }
  expect(api.updateCard).not.toHaveBeenCalled();
  expect(api.executeCard).not.toHaveBeenCalled();
});

test('색상 선택은 메뉴에서 실제 PATCH를 보내고 다시 조회한 카드에도 유지한다', async () => {
  const fixture = createCardColorReviewClient('success');
  const initialVersion = fixture.card.version;
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={fixture.api} card={fixture.card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy());

  await act(async () => fireEvent.press(screen.getByLabelText('카드 색상: 하늘')));
  expect(screen.getByTestId('card-color-selection')).toBeTruthy();
  expect(screen.getByTestId('card-color-option-blue').props.accessibilityState).toMatchObject({ selected: true });
  await act(async () => fireEvent.press(screen.getByTestId('card-color-option-lavender')));

  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({
    id: fixture.card.id,
    patch: { color: 'lavender' },
    expectedVersion: initialVersion,
  });
  expect(fixture.calls[0].idempotencyKey).toMatch(/^soul-app-card-/);
  expect((await fixture.api.getCard(fixture.card.id)).card).toMatchObject({ color: 'lavender', status: 'todo', version: initialVersion + 1 });
});

test('뒤로 돌아가면 기존 색을 유지하고 현재 색 선택은 PATCH 없이 닫는다', async () => {
  const fixture = createCardColorReviewClient('success');
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={fixture.api} card={fixture.card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy());

  await act(async () => fireEvent.press(screen.getByLabelText('카드 색상: 하늘')));
  await act(async () => fireEvent.press(screen.getByTestId('card-color-back')));
  expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 색상: 하늘')));
  await act(async () => fireEvent.press(screen.getByTestId('card-color-option-blue')));

  expect(fixture.calls).toHaveLength(0);
  expect(close).toHaveBeenCalledTimes(1);
});

test('저장 실패는 색 선택 화면에 남고 다시 조회하면 서버의 현재 색을 보여준다', async () => {
  const fixture = createCardColorReviewClient('error');
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={fixture.api} card={fixture.card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('카드 색상: 하늘')));
  await act(async () => fireEvent.press(screen.getByTestId('card-color-option-lavender')));

  await waitFor(() => expect(screen.getByText('공개 예시: 색상을 저장하지 못했습니다.')).toBeTruthy());
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByTestId('card-color-selection')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 다시 조회')));
  await waitFor(() => expect(screen.getByTestId('card-color-option-blue').props.accessibilityState).toMatchObject({ selected: true }));
  expect(fixture.calls).toHaveLength(1);
});

test('저장 중에는 색 선택 행을 비활성화하고 추가 PATCH를 막는다', async () => {
  const fixture = createCardColorReviewClient('pending');
  const close = jest.fn();
  const screen = render(<CardStatusMenu api={fixture.api} card={fixture.card} onClose={close} />);
  await waitFor(() => expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('카드 색상: 하늘')));
  await act(async () => fireEvent.press(screen.getByTestId('card-color-option-lavender')));

  await waitFor(() => expect(screen.getByTestId('card-color-option-lavender').props.accessibilityState).toMatchObject({ disabled: true }));
  fireEvent.press(screen.getByTestId('card-color-option-lavender'));
  expect(fixture.calls).toHaveLength(1);
  expect(close).not.toHaveBeenCalled();
});
