jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import React, { useState } from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import { cardFixture } from '../../../test-support/cards';
import { CardBoard } from '../CardBoard';
import { FolderCardList } from '../FolderCardList';
import { CompletedCardsToggle } from '../CompletedCardsToggle';
import { ReviewBoardActions } from '../../../component-review/ReviewBoardActions';
import { useCardStore } from '../../../store/cardStore';

const cards = (['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'] as const)
  .map((status) => cardFixture({ id: status, title: status, status }));

test('7열 순서와 개수를 유지하고 보관은 보드에서 제외한다', () => {
  const screen = render(<CardBoard api={null} cards={[...cards, cardFixture({ id: 'archived', archived: true })]} onOpen={() => {}} />);
  expect(screen.getAllByTestId(/^card-board-column-/).map((column) => column.props.testID))
    .toEqual(['todo', 'queued', 'running', 'blocked', 'review', 'done', 'cancelled'].map((status) => `card-board-column-${status}`));
  expect(screen.queryByTestId('card-board-stages')).toBeNull();
  for (const [status, label] of [['todo', '드래프트'], ['review', '검수 대기']] as const) {
    const lane = within(screen.getByTestId(`card-board-column-${status}`));
    const count = lane.getByTestId(`card-board-count-${status}`);
    // The lane contains its heading and this fixture card's status badge;
    // removed navigation tabs must not contribute another status label.
    expect(lane.getAllByText(new RegExp(label))).toHaveLength(2);
    expect(count.props.children).toBe(status === 'todo' ? '1개' : 1);
    expect(lane.getByTestId(`postit-card-${status}`)).toBeTruthy();
  }
  expect(screen.getByTestId('postit-card-cancelled')).toBeTruthy();
  expect(screen.queryByTestId('postit-card-archived')).toBeNull();
  expect(screen.getByTestId('card-board-count-done').props.children).toBe('1개 표시');
});

test('폴더 행/보드의 같은 controlled 옵션은 완료만 숨기고 숨김 열 액션으로 켜진다', () => {
  function Sample() {
    const [include, setInclude] = useState(false);
    return <><CompletedCardsToggle includeCompleted={include} completedCount={1} onChange={setInclude} />
      <FolderCardList api={null} cards={cards} includeCompleted={include} onOpen={() => {}} />
      <CardBoard api={null} cards={cards} includeCompleted={include} onOpen={() => {}} /></>;
  }
  const screen = render(<Sample />);
  expect(screen.queryByTestId('card-row-done')).toBeNull();
  expect(screen.getByTestId('card-row-cancelled')).toBeTruthy();
  expect(screen.queryByTestId('card-board-column-done')).toBeNull();
  expect(screen.queryByTestId('card-board-column-cancelled')).toBeNull();
  fireEvent.press(screen.getByLabelText('완료·취소 숨김'));
  expect(screen.getByTestId('card-row-done')).toBeTruthy();
  expect(screen.getByTestId('postit-card-done')).toBeTruthy();
  expect(screen.getByTestId('postit-card-cancelled')).toBeTruthy();
  expect(screen.getByLabelText('완료·취소 숨김').props.accessibilityState.selected).toBe(false);
});

test.each([{ items: [] }, { items: cards.filter((card) => card.status === 'done') }])('완료 0개/전부 완료의 빈 상태에도 5열이 남는다', ({ items }) => {
  const screen = render(<CardBoard api={null} cards={items} includeCompleted={false} onOpen={() => {}} />);
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(5);
  expect(screen.queryByTestId('postit-card-done')).toBeNull();
  expect(screen.getAllByText('카드가 없습니다.').length).toBeGreaterThanOrEqual(5);
});

test('목록 활동 원문과 요청을 표시하고 상세는 카드 탭 전까지 조회하지 않는다', async () => {
  const getCard = jest.fn();
  const setCardStatus = jest.fn();
  const open = jest.fn();
  const card = cardFixture({ request: '요청 원문', latestActivity: { kind: 'instruction', body: '새 지시 원문', format: 'markdown', createdAt: '2026-10-01' } });
  const screen = render(<CardBoard api={{ getCard, setCardStatus } as unknown as ApiClient} cards={[card]} onOpen={open} />);
  expect(screen.queryByText('요청 원문')).toBeNull();
  expect(screen.getByText(/새 지시 원문/)).toBeTruthy();
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


test('drop execute pending shows acceptance then observes the same request in the running lane',async()=>{
  const {Alert}=require('react-native');
  const {act}=require('@testing-library/react-native');
  const {BoardDragCard}=require('../BoardDragCard');
  const source=cardFixture({id:'drop-pending'});
  const accepted={...source,status:'running' as const,version:source.version+1,assigneeKind:'session' as const,assigneeSessionId:'drop-session'};
  const api={getCard:jest.fn().mockResolvedValue({card:source,reports:[],questions:[],sessions:[]}),
    executeCard:jest.fn().mockResolvedValue({card:accepted,execution:{requestId:'drop-request',sessionId:'drop-session',state:'pending'}}),
    getCardExecution:jest.fn().mockResolvedValue({card:accepted,execution:{requestId:'drop-request',sessionId:'drop-session',state:'started'}})};
  const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{});
  // Board cards are controlled by the same store updated by execution results.
  function Sample(){const current=useCardStore(state=>state.rows[source.id]??source);return <CardBoard phone={false} api={api as any} cards={[current]} onOpen={()=>{}}/>;}
  jest.useFakeTimers();
  try {
    const screen=render(<Sample/>);
    fireEvent(screen.getByTestId('card-board-frame'),'layout',{nativeEvent:{layout:{width:1400,height:600}}});
    await act(async()=>screen.UNSAFE_getAllByType(BoardDragCard)[0].props.onDrop({absoluteX:650,absoluteY:200,x:0,y:0}));
    expect(api.executeCard).toHaveBeenCalledTimes(1);
    expect(api.getCardExecution).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
    expect(within(screen.getByTestId('card-board-column-todo')).queryByTestId('postit-card-drop-pending')).toBeNull();
    const lane=within(screen.getByTestId('card-board-column-running'));
    expect(lane.getByTestId('postit-card-drop-pending')).toBeTruthy();
    expect(lane.getByText('시작 중…')).toBeTruthy();
    await act(async()=>jest.advanceTimersByTimeAsync(1000));
    expect(api.getCardExecution).toHaveBeenCalledWith(source.id,'drop-request');
    expect(api.executeCard).toHaveBeenCalledTimes(1);
    expect(lane.queryByText('시작 중…')).toBeNull();
    expect(lane.getByTestId('postit-card-drop-pending')).toBeTruthy();
    expect(useCardStore.getState().rows[source.id].assigneeSessionId).toBe('drop-session');
    expect(alert).not.toHaveBeenCalled();
  } finally {jest.useRealTimers();alert.mockRestore();}
});
