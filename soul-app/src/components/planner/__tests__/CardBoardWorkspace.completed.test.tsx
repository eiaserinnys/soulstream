jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('../../../hooks/useCardList', () => ({ useCardList: () => ({ cards: mockCards, loading: false, error: null, refresh: jest.fn() }) }));
import React, { useState } from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { CardBoardWorkspace } from '../CardBoardWorkspace';
import { cardFixture } from '../../../test-support/cards';

let mockCards = [cardFixture({ id: 'done', status: 'done' }), cardFixture({ id: 'todo' })];
function Sample({ folderId }: { folderId?: string }) {
  const [includeCompleted, onChange] = useState(false);
  return <CardBoardWorkspace api={null} folderId={folderId} cardDisplay={{ includeCompleted, onChange }} onOpen={() => {}} />;
}

test.each([undefined, 'folder-1'])('전체/폴더 %s: 기본 완료 숨김은 완료 레인을 제외하고 상단 원형 액션으로 해제한다', (folderId) => {
  mockCards = [cardFixture({ id: 'done', status: 'done' }), cardFixture({ id: 'todo' })];
  const screen = render(<Sample folderId={folderId} />);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(true);
  expect(screen.queryByTestId('postit-card-done')).toBeNull();
  expect(screen.getByTestId('postit-card-todo')).toBeTruthy();
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(5);
  expect(screen.queryByTestId('card-board-column-done')).toBeNull();
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByTestId('postit-card-done')).toBeTruthy();
  expect(screen.getAllByTestId(/^card-board-column-/)).toHaveLength(6);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(false);
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByTestId('postit-card-done')).toBeTruthy();
});

test.each([{ cards: [] }, { cards: [cardFixture({ id: 'done', status: 'done' })] }])('완료 0개/전부 완료에서도 상단 옵션으로 해제한다', ({ cards }) => {
  mockCards = cards;
  const screen = render(<Sample />);
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(true);
  fireEvent.press(screen.getByLabelText('완료 숨김'));
  expect(screen.getByLabelText('완료 숨김').props.accessibilityState.selected).toBe(false);
  if (cards.length) expect(screen.getByTestId('postit-card-done')).toBeTruthy();
});
