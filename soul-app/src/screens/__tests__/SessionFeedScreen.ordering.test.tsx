jest.mock('../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openSessionMenu: jest.fn(),
    sessionSuccession: null,
    closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../../components/planner/SessionSuccessionHost', () => ({
  SessionSuccessionHost: () => null,
}));
jest.mock('../../components/SessionCard', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SessionCard: jest.fn(({ session }: { session: Session }) =>
      React.createElement(Text, null, session.agentSessionId)),
  };
});

import React from 'react';
import { act, fireEvent, render, type RenderAPI } from '@testing-library/react-native';
import type { Session } from '../../api/types';
import { SessionCard } from '../../components/SessionCard';
import { SessionFeedScreen } from '../SessionFeedScreen';
import { useNodeConnectivityStore } from '../../store/nodeConnectivityStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';
import { useUIStore } from '../../store/uiStore';
import { StyleSheet } from 'react-native';

test('floating coverage adds to the feed bottom padding and returns to baseline on hide', () => {
  useUIStore.setState({ floatingComposerBottomInset: 0 });
  const screen = render(<SessionFeedScreen />);
  const baseline = StyleSheet.flatten(screen.getByTestId('phone-feed-body').props.contentContainerStyle).paddingBottom;
  act(() => { useUIStore.getState().setFloatingComposerBottomInset(112); });
  expect(StyleSheet.flatten(screen.getByTestId('phone-feed-body').props.contentContainerStyle).paddingBottom).toBe(baseline + 112);
  act(() => { useUIStore.getState().setFloatingComposerBottomInset(0); });
  expect(StyleSheet.flatten(screen.getByTestId('phone-feed-body').props.contentContainerStyle).paddingBottom).toBe(baseline);
});

const mockSessionCard = SessionCard as jest.Mock;

function session(
  agentSessionId: string,
  updatedAt: string,
  overrides: Partial<Session> = {},
): Session {
  return {
    agentSessionId,
    displayName: agentSessionId,
    status: 'running',
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function seed(sessions: Session[]) {
  const store = useSessionStore.getState();
  store.setCatalog({ folders: [], sessions: {} });
  store.setSessions(sessions);
}

function renderedSessionIds(view: RenderAPI): string[] {
  const rows = view.getByTestId('phone-feed-body').props.data as Array<{
    kind: string;
    sessionId?: string;
    session?: Session;
  }>;
  return rows
    .filter((row) => row.kind === 'session')
    .map((row) => row.sessionId ?? row.session?.agentSessionId ?? '');
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    feedScopeTombstoneIds: {},
    catalogReady: false,
    catalogLoadState: 'loading',
    catalogRetryRequest: 0,
    feedSessionIds: [],
    sessionChangeSerial: 0,
    lastChangedSessionId: null,
  });
  useSettingsStore.setState({ serverUrl: '' });
  useNodeConnectivityStore.getState().reset();
  mockSessionCard.mockClear();
});

test('catalog loading·failure·empty를 구분하고 실패 화면의 재시도는 새 요청을 시작한다', () => {
  useSessionStore.setState({
    catalogLoadState: 'loading',
    catalogRetryRequest: 0,
  });
  const view = render(<SessionFeedScreen />);
  expect(view.getByText('세션을 불러오는 중입니다.')).toBeTruthy();

  act(() => {
    useSessionStore.getState().markCatalogLoadFailed();
  });
  expect(view.getByText('세션 목록을 불러오지 못했습니다.')).toBeTruthy();

  fireEvent.press(view.getByTestId('session-feed-retry'));
  expect(useSessionStore.getState().catalogLoadState).toBe('loading');
  expect(useSessionStore.getState().catalogRetryRequest).toBe(1);

  act(() => {
    useSessionStore.getState().setCatalog({ folders: [], sessions: {} });
    useSessionStore.getState().setSessions([]);
  });
  expect(view.queryByText('세션을 불러오는 중입니다.')).toBeNull();
  expect(view.queryByText('세션 목록을 불러오지 못했습니다.')).toBeNull();
  expect(view.getAllByText('해당 세션이 없습니다.')).toHaveLength(3);
});

test('raw session_updated가 updatedAt만 바꿔도 메시지 활동 순서는 흔들리지 않는다', () => {
  seed([
    session('old', '2026-07-25T10:00:00Z'),
    session('new', '2026-07-25T11:00:00Z'),
  ]);
  const view = render(<SessionFeedScreen />);

  expect(renderedSessionIds(view)).toEqual(['new', 'old']);

  act(() => {
    useSessionStore.getState().updateSession('old', {
      updatedAt: '2026-07-25T12:00:00Z',
    });
  });

  expect(renderedSessionIds(view)).toEqual(['new', 'old']);
});

test('session_created 신규 세션은 Record 삽입 위치와 무관하게 피드 맨 위에 온다', () => {
  seed([session('existing', '2026-07-25T10:00:00Z')]);
  const view = render(<SessionFeedScreen />);

  act(() => {
    useSessionStore.getState().upsertSession(
      session('created', '2026-07-25T12:00:00Z'),
    );
  });

  expect(renderedSessionIds(view)).toEqual(['created', 'existing']);
});

test('gap refetch mergeSessions가 최신 유효 메시지를 가져오면 활동순을 회복한다', () => {
  seed([
    session('new', '2026-07-25T11:00:00Z'),
    session('old', '2026-07-25T10:00:00Z'),
  ]);
  const view = render(<SessionFeedScreen />);

  act(() => {
    useSessionStore.getState().mergeSessions([
      session('old', '2026-07-25T10:00:00Z', {
        updatedAt: '2026-07-25T12:00:00Z',
        lastMessage: {
          type: 'assistant_message',
          preview: 'gap에서 복구한 최신 응답',
          timestamp: '2026-07-25T12:00:00Z',
        },
      }),
    ]);
  });

  expect(renderedSessionIds(view)).toEqual(['old', 'new']);
});

test('/api/sessions/stream의 live resume 갱신 뒤 running 한 행만 렌더한다', () => {
  seed([
    session('resumed', '2026-08-11T10:00:00Z', {
      status: 'completed',
      reviewState: 'needs_review',
      reviewRequired: true,
    }),
  ]);
  const view = render(<SessionFeedScreen />);

  act(() => {
    useSessionStore.getState().updateSession('resumed', {
      status: 'running',
      reviewState: 'not_required',
      reviewRequired: false,
      updatedAt: '2026-08-11T10:01:00Z',
    });
  });

  expect(renderedSessionIds(view)).toEqual(['resumed']);
});

test('불법 running+needs_review 입력도 running 한 행만 렌더한다', () => {
  seed([
    session('illegal-combination', '2026-08-11T10:00:00Z', {
      status: 'running',
      reviewState: 'needs_review',
      reviewRequired: true,
    }),
  ]);

  const view = render(<SessionFeedScreen />);

  expect(renderedSessionIds(view)).toEqual(['illegal-combination']);
});

test('pending attention은 비실행 세션도 첫 응답 필요 그룹에 한 번만 표시한다', () => {
  seed([
    session('running', '2026-08-11T10:00:00Z'),
    session('attention', '2026-08-11T09:00:00Z', {
      status: 'completed',
      reviewState: 'needs_review',
      reviewRequired: true,
      pendingAttentions: [{
        id: 'input_request:req-7',
        sourceEventId: 1001,
        sessionId: 'attention',
        kind: 'input_request',
        requestedAt: '2026-08-11T10:01:00Z',
        title: '입력 요청',
        body: '배포할까요?',
        requiresDetail: false,
      }],
      attentionRevision: 1001,
    }),
  ]);

  const view = render(<SessionFeedScreen />);
  const data = view.getByTestId('phone-feed-body').props.data as Array<{
    kind: string;
    title?: string;
    sessionId?: string;
  }>;
  expect(data.filter((row) => row.kind === 'heading').map((row) => row.title))
    .toEqual(['응답 필요', '실행 중', '검수 대기']);
  expect(renderedSessionIds(view)).toEqual(['attention', 'running']);
});

test('유효한 메시지·createdAt·legacy updatedAt이 모두 없으면 피드에서 제외한다', () => {
  seed([
    session('broken', ''),
    session('valid', '2026-07-25T10:00:00Z'),
  ]);

  const view = render(<SessionFeedScreen />);

  expect(renderedSessionIds(view)).toEqual(['valid']);
});

test('한 세션의 유효 메시지 순서가 바뀌어도 변경되지 않은 카드는 다시 렌더하지 않는다', () => {
  seed([
    session('old', '2026-07-25T10:00:00Z'),
    session('new', '2026-07-25T11:00:00Z'),
  ]);
  render(<SessionFeedScreen />);
  mockSessionCard.mockClear();

  act(() => {
    useSessionStore.getState().updateSession('old', {
      updatedAt: '2026-07-25T12:00:00Z',
      lastMessage: {
        type: 'user_message',
        preview: '최신 질문',
        timestamp: '2026-07-25T12:00:00Z',
      },
    });
  });

  const renderedIds = mockSessionCard.mock.calls.map(
    ([props]) => (props as { session: Session }).session.agentSessionId,
  );
  expect(renderedIds).toContain('old');
  expect(renderedIds).not.toContain('new');
});

test.each([1, 5, 10])(
  '유효 메시지가 있는 실행 세션 %i개의 metadata-only patch는 목록을 다시 만들지 않고 mount된 대상 카드만 갱신한다',
  (count) => {
    const affectedIds = Array.from(
      { length: count },
      (_, index) => `affected-${index + 1}`,
    );
    seed([
      session('unaffected', '2026-07-25T11:00:00Z', {
        lastMessage: {
          type: 'assistant_message',
          preview: '기존 응답',
          timestamp: '2026-07-25T11:00:00Z',
        },
      }),
      ...affectedIds.map((id) => session(id, '2026-07-25T10:00:00Z', {
        lastMessage: {
          type: 'assistant_message',
          preview: '표시 중인 응답',
          timestamp: '2026-07-25T10:00:00Z',
        },
      })),
    ]);
    render(<SessionFeedScreen />);
    mockSessionCard.mockClear();
    const beforeIds = useSessionStore.getState().feedSessionIds;
    let storeCommits = 0;
    let listInvalidations = 0;
    const unsubscribe = useSessionStore.subscribe((state, previous) => {
      storeCommits += 1;
      if (state.feedSessionIds !== previous.feedSessionIds) listInvalidations += 1;
    });

    act(() => {
      affectedIds.forEach((id, index) => {
        useSessionStore.getState().updateSession(id, {
          lastEventId: index + 1,
          updatedAt: '2026-07-25T12:00:00Z',
        });
      });
    });
    unsubscribe();

    const renderedIds = mockSessionCard.mock.calls.map(
      ([props]) => (props as { session: Session }).session.agentSessionId,
    );
    expect(storeCommits).toBe(count);
    expect(listInvalidations).toBe(0);
    expect(useSessionStore.getState().feedSessionIds).toBe(beforeIds);
    expect(renderedIds).not.toHaveLength(0);
    expect(renderedIds.every((id) => affectedIds.includes(id))).toBe(true);
    expect(renderedIds).not.toContain('unaffected');
  },
);
