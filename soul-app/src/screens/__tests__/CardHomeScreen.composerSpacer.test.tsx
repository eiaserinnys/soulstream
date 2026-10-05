jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('../../api/client', () => ({ createApiClient: () => mockApi }));
jest.mock('../../components/planner/TodayCardComposer', () => ({
  TodayCardComposer: () => require('react').createElement(require('react-native').View, { testID: 'composer-content' }),
}));
jest.mock('../../components/planner/CardBoardWorkspace', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('../../components/planner/CardBoardWorkspace');
  return {
    ...actual,
    CardBoardWorkspace: ReactModule.forwardRef((props: any, ref: any) => {
      (globalThis as any).__homeComposerRenderCounts.workspace += 1;
      return ReactModule.createElement(actual.CardBoardWorkspace, { ...props, ref });
    }),
  };
});
jest.mock('../../components/planner/CardBoard', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('../../components/planner/CardBoard');
  return {
    ...actual,
    CardBoard: (props: any) => {
      (globalThis as any).__homeComposerRenderCounts.board += 1;
      return ReactModule.createElement(actual.CardBoard, props);
    },
  };
});
jest.mock('../../components/planner/BoardDragCard', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('../../components/planner/BoardDragCard');
  return {
    ...actual,
    BoardDragCard: (props: any) => {
      (globalThis as any).__homeComposerRenderCounts.dragCard += 1;
      return ReactModule.createElement(actual.BoardDragCard, props);
    },
  };
});
jest.mock('../../components/planner/PostItCard', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('../../components/planner/PostItCard');
  return {
    ...actual,
    PostItCard: (props: any) => {
      (globalThis as any).__homeComposerRenderCounts.postIt += 1;
      return ReactModule.createElement(actual.PostItCard, props);
    },
  };
});

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { CardHomeScreen } from '../CardHomeScreen';
import { cardFixture } from '../../test-support/cards';
import { useSettingsStore } from '../../store/settingsStore';
import { useCardStore } from '../../store/cardStore';
import { useUIStore } from '../../store/uiStore';

const mockApi = { listCards: jest.fn(), listCompletedCards: jest.fn(), getCard: jest.fn(), setCardStatus: jest.fn() };
const mockRenderCounts = { workspace: 0, board: 0, dragCard: 0, postIt: 0 };
(globalThis as any).__homeComposerRenderCounts = mockRenderCounts;

beforeEach(() => {
  Object.assign(mockRenderCounts, { workspace: 0, board: 0, dragCard: 0, postIt: 0 });
  useUIStore.setState({ floatingComposerBottomInset: 0 });
  useSettingsStore.setState({ serverUrl: 'https://test.example', cardIncludeCompleted: {} });
  useCardStore.setState({ rows: {}, details: {} });
  mockApi.listCards.mockReset();
  mockApi.listCompletedCards.mockReset().mockResolvedValue({ cards: [], nextCursor: null });
  mockApi.getCard.mockReset();
  mockApi.setCardStatus.mockReset();
});

test('home composer height updates only the spacer and does not render the board or cards again', async () => {
  mockApi.listCards.mockResolvedValue({ cards: [
    cardFixture({ id: 'composer-todo', status: 'todo' }),
    cardFixture({ id: 'composer-queued', status: 'queued' }),
    cardFixture({ id: 'composer-review', status: 'review' }),
  ] });
  const screen = render(<CardHomeScreen onOpen={() => {}} onSessionCreated={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('postit-card-composer-review')).toBeTruthy());

  Object.assign(mockRenderCounts, { workspace: 0, board: 0, dragCard: 0, postIt: 0 });
  const dock = screen.getByTestId('home-session-composer-dock');
  act(() => { fireEvent(dock, 'layout', { nativeEvent: { layout: { height: 100 } } }); });

  expect(mockRenderCounts).toEqual({ workspace: 0, board: 0, dragCard: 0, postIt: 0 });
  expect(useUIStore.getState().floatingComposerBottomInset).toBe(112);
  expect(screen.getByTestId('home-composer-spacer-review').props.style).toMatchObject({ height: 112, marginTop: -8 });

  act(() => { fireEvent(dock, 'layout', { nativeEvent: { layout: { height: 120 } } }); });
  expect(mockRenderCounts).toEqual({ workspace: 0, board: 0, dragCard: 0, postIt: 0 });
  expect(screen.getByTestId('home-composer-spacer-review').props.style).toMatchObject({ height: 132, marginTop: -8 });
});
