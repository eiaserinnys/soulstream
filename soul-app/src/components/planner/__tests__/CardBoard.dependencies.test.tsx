jest.mock('react-native-enriched-markdown', () => ({ EnrichedMarkdownText: (props: any) => require('react').createElement(require('react-native').Text, props, props.markdown) }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { useCardStore } from '../../../store/cardStore';
import { BoardDragCard } from '../BoardDragCard';
import { CardBoard } from '../CardBoard';

const source = cardFixture({ id: 'drag-dep', status: 'queued', assigneeSessionId: 'owner', dependsOn: [
  { id: 'dep', number: 1864, title: '선행', status: 'running', archived: false, met: false }] });
function setup() {
  const accepted = { ...source, status: 'running' as const, version: source.version + 1 };
  const api = {
    getCard: jest.fn().mockResolvedValue({ card: source, reports: [], questions: [], sessions: [] }),
    executeCard: jest.fn().mockResolvedValue({ card: accepted, execution: { requestId: 'r', sessionId: 'owner', state: 'started' } }),
  };
  function Sample() {
    const current = useCardStore(state => state.rows[source.id] ?? source);
    return <CardBoard phone={false} api={api as any} cards={[current]} initialPosition={{ x: 0, lane: 'todo', lanes: {} }} onOpen={() => {}} />;
  }
  const screen = render(<Sample />);
  fireEvent(screen.getByTestId('card-board-frame'), 'layout', { nativeEvent: { layout: { width: 1400, height: 600 } } });
  return { api, screen };
}
const drop = (screen: ReturnType<typeof render>) =>
  act(async () => { screen.UNSAFE_getAllByType(BoardDragCard)[0].props.onDrop({ absoluteX: 650, absoluteY: 200, x: 0, y: 0 }); await Promise.resolve(); await Promise.resolve(); });
const lane = (screen: ReturnType<typeof render>, status: string) => within(screen.getByTestId(`card-board-column-${status}`));

let alert: jest.SpyInstance;
beforeEach(() => { useCardStore.setState({ rows: {}, details: {} }); alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
afterEach(() => alert.mockRestore());

test('실행 중 칸에 놓으면 선행 확인을 거치고 취소하면 요청 없이 원래 칸에 남는다', async () => {
  const { api, screen } = setup();
  expect(lane(screen, 'queued').getByTestId('postit-card-drag-dep')).toBeTruthy();
  await drop(screen);
  expect(alert).toHaveBeenCalledTimes(1);
  expect(alert.mock.calls[0][0]).toBe('선행 카드가 끝나지 않았습니다');
  const cancel = (alert.mock.calls[0][2] as any[]).find(button => button.text === '취소');
  await act(async () => { cancel.onPress(); await Promise.resolve(); await Promise.resolve(); });
  expect(api.executeCard).not.toHaveBeenCalled();
  expect(lane(screen, 'queued').getByTestId('postit-card-drag-dep')).toBeTruthy();
  expect(lane(screen, 'running').queryByTestId('postit-card-drag-dep')).toBeNull();
  expect(alert).toHaveBeenCalledTimes(1);
});

test('지금 시작을 고르면 실행 중 칸으로 옮겨 진다', async () => {
  const { api, screen } = setup();
  await drop(screen);
  const start = (alert.mock.calls[0][2] as any[]).find(button => button.text === '지금 시작');
  await act(async () => { start.onPress(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  expect(api.executeCard).toHaveBeenCalledTimes(1);
  expect(lane(screen, 'running').getByTestId('postit-card-drag-dep')).toBeTruthy();
});
