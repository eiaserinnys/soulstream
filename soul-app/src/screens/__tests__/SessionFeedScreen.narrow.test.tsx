jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openSessionMenu: jest.fn(), sessionSuccession: null, closeSessionSuccession: jest.fn() }),
}));
jest.mock('../../components/planner/SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));
jest.mock('../../components/SessionCard', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { SessionCard: jest.fn(({ session }: { session: Session }) => React.createElement(Text, null, session.agentSessionId)) };
});
jest.mock('../../theme', () => ({ ...jest.requireActual('../../theme'), useDeviceType: () => 'tabletPortrait' }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');

import { act, fireEvent, render } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import { SessionCard } from '../../components/SessionCard';
import { SessionFeedScreen } from '../SessionFeedScreen';
import { useSessionStore } from '../../store/sessionStore';

const settleTimers = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });

test('아이패드 세로 피드(338폭)는 아이폰처럼 상태 배지 열을 편 채로 둔다', async () => {
  useSessionStore.getState().applyFeedSnapshot({
    folders: [],
    sessions: [{ agentSessionId: 'running-1', displayName: '실행 세션', status: 'running',
      createdAt: '2026-07-25T11:00:00Z', updatedAt: '2026-07-25T11:00:00Z' } as Session],
    total: 1, hasMore: false, nextCursor: null,
  });
  const view = render(<SessionFeedScreen active />);
  fireEvent(view.root, 'layout', { nativeEvent: { layout: { width: 338, height: 800 } } });

  const latest = (SessionCard as jest.Mock).mock.calls.at(-1)?.[0];
  expect(latest.session.agentSessionId).toBe('running-1');
  expect(latest.narrow).toBe(false);
  await settleTimers();
});
