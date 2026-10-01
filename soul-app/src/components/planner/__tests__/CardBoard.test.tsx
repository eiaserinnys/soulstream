jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import React, { useState } from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import { cardFixture } from '../../../test-support/cards';
import { CardBoard } from '../CardBoard';
import { FolderCardList } from '../FolderCardList';
import { CompletedCardsToggle } from '../CompletedCardsToggle';
import { ReviewBoardActions } from '../../../component-review/ReviewBoardActions';

const cards = (['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'] as const)
  .map((status) => cardFixture({ id: status, title: status, status }));

test('6열 순서와 개수를 유지하고 보관·취소는 보드에서 제외한다', () => {
  const screen = render(<CardBoard api={null} cards={[...cards, cardFixture({ id: 'archived', archived: true })]} onOpen={() => {}} />);
  expect(screen.getAllByTestId(/^card-board-column-/).map((column) => column.props.testID))
    .toEqual(['todo', 'queued', 'running', 'blocked', 'review', 'done'].map((status) => `card-board-column-${status}`));
  expect(screen.getAllByText('드래프트')).toHaveLength(2);
  expect(screen.getAllByText('검수 대기')).toHaveLength(2);
  expect(screen.queryByTestId('card-row-cancelled')).toBeNull();
  expect(screen.queryByTestId('card-row-archived')).toBeNull();
  expect(screen.getByTestId('card-board-count-done').props.children).toBe(1);
});

test('폴더 행/보드의 같은 controlled 옵션은 완료만 숨기고 숨김 열 액션으로 켜진다', () => {
  function Sample() {
    const [include, setInclude] = useState(false);
    return <><CompletedCardsToggle includeCompleted={include} completedCount={1} onChange={setInclude} />
      <FolderCardList api={null} cards={cards} includeCompleted={include} onOpen={() => {}} />
      <CardBoard api={null} cards={cards} includeCompleted={include} onIncludeCompletedChange={setInclude} onOpen={() => {}} /></>;
  }
  const screen = render(<Sample />);
  expect(screen.queryByTestId('card-row-done')).toBeNull();
  expect(screen.getByTestId('card-row-cancelled')).toBeTruthy();
  expect(screen.getAllByText('완료 1개 숨김')).toHaveLength(2);
  fireEvent.press(screen.getByLabelText('숨긴 완료 카드 보기'));
  expect(screen.getAllByTestId('card-row-done')).toHaveLength(2);
  expect(screen.getByLabelText('완료 포함').props.accessibilityState.checked).toBe(true);
});

test.each([{ items: [] }, { items: cards.filter((card) => card.status === 'done') }])('완료 0개/전부 완료의 빈 상태에도 6열이 남는다', ({ items }) => {
  const screen = render(<CardBoard api={null} cards={items} includeCompleted={false} onIncludeCompletedChange={() => {}} onOpen={() => {}} />);
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(6);
  expect(screen.queryByTestId('card-row-done')).toBeNull();
  expect(screen.getAllByText('카드가 없습니다.').length).toBeGreaterThanOrEqual(5);
});

test('목록 활동 원문과 요청을 표시하고 상세는 카드 탭 전까지 조회하지 않는다', async () => {
  const getCard = jest.fn();
  const setCardStatus = jest.fn();
  const open = jest.fn();
  const card = cardFixture({ request: '요청 원문', latestActivity: { kind: 'instruction', body: '새 지시 원문', format: 'markdown', createdAt: '2026-10-01' } });
  const screen = render(<CardBoard api={{ getCard, setCardStatus } as unknown as ApiClient} cards={[card]} onOpen={open} />);
  expect(screen.getByText('요청 원문')).toBeTruthy();
  expect(screen.getByText('새 지시 원문')).toBeTruthy();
  await waitFor(() => expect(getCard).not.toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText('카드 제목 카드 상세'));
  expect(open).toHaveBeenCalledWith(card.id);
  expect(setCardStatus).not.toHaveBeenCalled();
});

test('보드의 시간과 완료 액션은 보조정보 옆 한 행이며 같은 본문 비교를 좁은 pane에도 렌더한다', () => {
  const screen = render(<ReviewBoardActions />);
  const actionRow = screen.getByTestId('card-compare-review-board-actions');
  expect(actionRow.props.style.flexDirection).toBe('row');
  expect(screen.getAllByText('같은 본문입니다. 버튼 유무에 따라 본문 시작과 카드 높이가 달라지지 않습니다.')).toHaveLength(2);
  fireEvent.press(screen.getByLabelText('좁은 iPad pane'));
  expect(screen.getByTestId('card-row-compare-review')).toBeTruthy();
  expect(screen.getByTestId('card-row-compare-running')).toBeTruthy();
});
