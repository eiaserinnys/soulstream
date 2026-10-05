jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('../../api/client', () => ({ createApiClient: () => mockApi }));
jest.mock('../../components/planner/TodayCardComposer', () => ({ TodayCardComposer: () => require('react').createElement(require('react-native').View, { testID: 'composer-content' }) }));
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { State } from 'react-native-gesture-handler';
import { fireGestureHandler, getByGestureTestId } from 'react-native-gesture-handler/jest-utils';
import { CardHomeScreen } from '../CardHomeScreen';
import { cardFixture } from '../../test-support/cards';
import { useSettingsStore } from '../../store/settingsStore';
import { useCardStore } from '../../store/cardStore';
import { useCardDisplay } from '../../hooks/useCardDisplay';
import { CompletedCardsToggle } from '../../components/planner/CompletedCardsToggle';
import { useUIStore } from '../../store/uiStore';

const mockApi = { listCards: jest.fn(), listCompletedCards: jest.fn(), getCard: jest.fn(), setCardStatus: jest.fn() };
test('home composer floats over the board and measured height reserves lane scroll space only', async () => {
  mockApi.listCards.mockResolvedValue({ cards: [cardFixture({ id: 'composer-review', status: 'review' })] });
  const screen = render(<CardHomeScreen onOpen={() => {}} onSessionCreated={() => {}} />);
  await waitFor(() => expect(mockApi.listCards).toHaveBeenCalled());
  expect(useUIStore.getState().floatingComposerBottomInset).toBe(0);
  const dock = screen.getByTestId('home-session-composer-dock');
  expect(StyleSheet.flatten(dock.props.style)).toMatchObject({ position: 'absolute', left: 16, right: 16, bottom: 12 });
  const board = screen.getByTestId('card-board-frame');
  const style = StyleSheet.flatten(board.props.style);
  fireEvent(dock, 'layout', { nativeEvent: { layout: { height: 100 } } });
  expect(useUIStore.getState().floatingComposerBottomInset).toBe(112);
  expect(screen.getByTestId('card-board-frame')).toBe(board);
  expect(StyleSheet.flatten(board.props.style)).toEqual(style);
  const contentPadding = StyleSheet.flatten(screen.getByTestId('card-board-scroll-review').props.contentContainerStyle).paddingBottom;
  const spacer = StyleSheet.flatten(screen.getByTestId('home-composer-spacer-review').props.style);
  expect(contentPadding).toBe(16);
  expect(spacer).toMatchObject({ height: 112, marginTop: -8 });
  expect(contentPadding + 8 + spacer.marginTop + spacer.height).toBe(128);
  screen.unmount();
  expect(useUIStore.getState().floatingComposerBottomInset).toBe(0);
});
beforeEach(() => {
  useUIStore.setState({ floatingComposerBottomInset: 0 });
  useSettingsStore.setState({ serverUrl: 'https://test.example', cardIncludeCompleted: {} });
  useCardStore.setState({ rows: {}, details: {} });
  mockApi.listCards.mockReset(); mockApi.listCompletedCards.mockReset(); mockApi.listCompletedCards.mockResolvedValue({cards: [], nextCursor: null}); mockApi.getCard.mockReset(); mockApi.setCardStatus.mockReset();
});

test('전체 홈과 폴더 선호를 따로 유지하고 홈 재마운트에도 보존한다', async () => {
  mockApi.listCards.mockResolvedValue({ cards: [] });
  mockApi.listCompletedCards.mockResolvedValue({cards:[cardFixture({status:'done',completedAt:new Date().toISOString()})],nextCursor:null});
  function FolderOption() {
    const display = useCardDisplay('folder-1');
    return <CompletedCardsToggle {...display} completedCount={1} />;
  }
  let screen = render(<CardHomeScreen onOpen={() => {}} />);
  await waitFor(() => expect(mockApi.listCards).toHaveBeenCalled());
  expect(screen.queryByTestId('postit-card-card-1')).toBeNull();
  fireEvent.press(screen.getByLabelText('완료·취소 숨김'));
  await waitFor(()=>expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  screen.unmount();
  screen = render(<FolderOption />);
  expect(screen.getByLabelText('완료·취소 숨김').props.accessibilityState.selected).toBe(true);
  screen.unmount();
  screen = render(<CardHomeScreen onOpen={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  expect(screen.getByLabelText('완료·취소 숨김').props.accessibilityState.selected).toBe(false);
});

test('완료 표시 중 드롭 저장 후 숨김·재마운트·다시 표시해도 완료 상태를 보존한다', async () => {
  const card = cardFixture({ status: 'review', version: 7 });
  const existingCompleted = cardFixture({ id: 'existing-done', status: 'done', completedAt: new Date().toISOString() });
  mockApi.listCards.mockResolvedValue({ cards: [card] });
  mockApi.listCompletedCards.mockResolvedValue({ cards: [existingCompleted], nextCursor: null });
  mockApi.getCard.mockResolvedValue({ card, reports: [], questions: [], sessions: [] });
  mockApi.setCardStatus.mockImplementation(async()=>{const done={...card,status:'done',version:8,completedAt:new Date().toISOString()};mockApi.listCards.mockResolvedValue({cards:[]});mockApi.listCompletedCards.mockResolvedValue({cards:[done],nextCursor:null});mockApi.getCard.mockResolvedValue({card:done,reports:[],questions:[],sessions:[]});return {card:done,folderId:card.folderId};});
  let screen = render(<CardHomeScreen onOpen={() => {}} />);
  await waitFor(() => expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('완료·취소 숨김'));
  await waitFor(() => expect(screen.getByTestId('card-board-column-done')).toBeTruthy());
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 1210, height: 600 } } });
  const contentStyle = StyleSheet.flatten(screen.getByTestId('card-board').props.contentContainerStyle);
  const columns = screen.getAllByTestId(/^card-board-column-/);
  const widths = columns.map(column => StyleSheet.flatten(column.props.style).width as number);
  const doneIndex = columns.findIndex(column => column.props.testID === 'card-board-column-done');
  expect(doneIndex).toBeGreaterThanOrEqual(0);
  const width = widths[doneIndex];
  const laneStart = widths.slice(0, doneIndex).reduce((total, laneWidth) => total + laneWidth + contentStyle.gap, 0);
  const maxScroll = Math.max(0, widths.reduce((total, laneWidth) => total + laneWidth, 0)
    + contentStyle.gap * (widths.length - 1) + contentStyle.paddingHorizontal * 2 - 1210);
  const doneX = contentStyle.paddingHorizontal + laneStart - maxScroll + width / 2;
  fireEvent.scroll(screen.getByTestId('card-board'), { nativeEvent: { contentOffset: { x: maxScroll, y: 0 } } });
  await act(async () => fireGestureHandler(getByGestureTestId('board-drag-card-1'), [
    { state: State.BEGAN }, { state: State.ACTIVE, absoluteX: doneX, absoluteY: 100 },
    { state: State.END, absoluteX: doneX, absoluteY: 100, translationX: 80, translationY: 0 },
  ]));
  await waitFor(() => expect(mockApi.setCardStatus).toHaveBeenCalledWith(card.id, 'done', 7, expect.any(String), undefined));
  fireEvent.press(screen.getByLabelText('완료·취소 숨김'));
  expect(screen.queryByTestId('postit-card-card-1')).toBeNull();
  screen.unmount();
  screen = render(<CardHomeScreen onOpen={() => {}} />);
  await waitFor(() => expect(screen.getByLabelText('완료·취소 숨김')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('완료·취소 숨김'));
  await waitFor(()=>expect(screen.getByTestId('postit-card-card-1')).toBeTruthy());
  expect(useCardStore.getState().rows[card.id].status).toBe('done');
});
