import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SearchScreen } from '../SearchScreen';
import { useSearchStore } from '../../store/searchStore';
import { useSessionStore } from '../../store/sessionStore';
import { useSettingsStore } from '../../store/settingsStore';

const mockUseSessionSearch = jest.fn();
const originalFetch = global.fetch;

jest.mock('@expo/vector-icons/Ionicons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return ({ name, ...props }: { name: string }) =>
    React.createElement(Text, props, name);
});

jest.mock('../../hooks/useSessionSearch', () => ({
  useSessionSearch: () => mockUseSessionSearch(),
}));

beforeEach(() => {
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [{
      agentSessionId: 'session-1',
      displayName: 'Alpha session',
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    }],
    sessionMatches: [{
      sessionId: 'session-1',
      title: 'Alpha session',
      excerpt: 'Relevant session excerpt',
      updatedAt: '2026-07-02T00:00:00.000Z',
      folderId: 'linked-folder',
      folderTitle: 'Alpha linked task',
      parentSessionId: null,
      bestMatch: {
        eventId: 44,
        matchSource: 'message',
        excerpt: 'Relevant session excerpt',
      },
      sessionUrl: '/?session=session-1&event=44',
    }],
    searchStatus: {
      queryExpansion: {
        status: 'partial',
        reason: 'configuration',
        latencyMs: 0,
      },
      searchLatencyMs: 150,
      dbCancelFailed: false,
    },
    messageResults: [{
      sessionId: 'session-1',
      eventId: 42,
      eventType: 'turn_summary',
      matchSource: 'turn_summary',
      preview: 'Alpha summary',
      score: 1,
    }, {
      sessionId: 'session-1',
      eventId: 43,
      eventType: 'session_highlight',
      matchSource: 'highlight',
      preview: 'Alpha highlight',
      score: 0.9,
    }],
    navigationResults: [
      {
        kind: 'folder',
        id: 'folder-a',
        title: 'Alpha project',
        folderId: 'folder-a',
        projectPageId: 'project-page-a',
      },
      {
        kind: 'folder',
        id: 'folder-b',
        title: 'Alpha task',
        folderId: 'folder-b',
        projectPageId: 'task-page-a',
      },
    ],
    loading: false,
    expansionPending: false,
    expansionFailed: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
  });
  useSearchStore.getState().reset();
  useSearchStore.getState().setQuery('Alpha');
  useSettingsStore.setState({ serverUrl: 'https://search.test' });
  useSessionStore.getState().setSessions([{
    agentSessionId: 'session-1',
    displayName: 'Alpha session',
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  }]);
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('전체 스코프는 세션·대화 내용 두 섹션을 한 화면에 표시한다', async () => {
  const onOpenSession = jest.fn();
  const onOpenFolder = jest.fn();
  const screen = render(
    <SearchScreen
      onOpenSession={onOpenSession}
      onOpenFolder={onOpenFolder}
      autoFocus={false}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });

  expect(screen.getByText('세션 · 1')).toBeTruthy();
  expect(screen.getByText('대화 내용 · 2')).toBeTruthy();
  expect(screen.getByLabelText('전체 검색')).toBeTruthy();
  expect(screen.getByLabelText(/^세션 결과, Alpha session, 완료/)).toBeTruthy();
  expect(screen.getByText('Relevant session excerpt')).toBeTruthy();
  expect(screen.getByText('폴더 · Alpha linked task')).toBeTruthy();
  expect(screen.getByText('의미 검색을 사용할 수 없어 현재 가능한 검색 결과만 표시합니다.'))
    .toBeTruthy();
  expect(screen.getByText('Alpha summary')).toBeTruthy();
  expect(screen.getByText('Alpha highlight')).toBeTruthy();
  expect(screen.getByText('폴더 · 2')).toBeTruthy();
  expect(screen.getByText('Alpha project')).toBeTruthy();
  expect(screen.getByText('Alpha task')).toBeTruthy();

  const folderStyle = StyleSheet.flatten(screen.getAllByText('폴더')[0].props.style);
  expect(folderStyle.width).toBeGreaterThan(0);
  expect(folderStyle.textAlign).toBe('center');

  fireEvent.press(screen.getAllByTestId('search-message-result')[0]);
  expect(onOpenSession).toHaveBeenCalledWith('session-1', 42);
  fireEvent.press(screen.getByLabelText(/^세션 결과, Alpha session, 완료/));
  expect(onOpenSession).toHaveBeenLastCalledWith('session-1', 44);
  fireEvent.press(screen.getAllByTestId('search-message-result')[1]);
  expect(onOpenSession).toHaveBeenLastCalledWith(
    'session-1',
    undefined,
    expect.any(Number),
  );
  onOpenSession.mockClear();
  act(() => {
    useSearchStore.getState().setSelectedResultIndex(2);
    useSearchStore.getState().requestActivateSelection();
  });
  expect(onOpenSession).toHaveBeenCalledWith(
    'session-1',
    undefined,
    expect.any(Number),
  );
  fireEvent.press(screen.getAllByTestId('search-navigation-result')[0]);
  expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({
    projectPageId: 'project-page-a',
  }));
  fireEvent.press(screen.getAllByTestId('search-navigation-result')[1]);
  expect(onOpenFolder).toHaveBeenCalledWith(expect.objectContaining({
    projectPageId: 'task-page-a',
  }));

  fireEvent.press(screen.getByLabelText('검색 필터'));
  expect(screen.queryByLabelText(/^도구/)).toBeNull();

  fireEvent.press(screen.getByLabelText('턴 요약 포함'));
  fireEvent.press(screen.getByLabelText('하이라이트 포함'));
  fireEvent.press(screen.getByLabelText('줄거리 포함'));
  expect(useSearchStore.getState().filters).toMatchObject({
    includeTurnSummaries: true,
    includeHighlight: true,
    includeStory: true,
  });

  // VirtualizedList batches its next cell update on a timer after the event
  // handlers above; keep that React update inside the test's act boundary.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

test('최근 세션은 캐시에 없는 id만 한 번에 받아 오고 피드 후보를 늘리지 않는다', async () => {
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [], sessionMatches: [], searchStatus: null, messageResults: [],
    navigationResults: [], loading: false, expansionPending: false, expansionFailed: false,
    error: null, hasMore: false, loadMore: jest.fn(),
  });
  const missingRows = ['recent-missing-1', 'recent-missing-2'].map((agentSessionId) => ({
    agentSessionId,
    displayName: `Hydrated ${agentSessionId}`,
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  }));
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ sessions: missingRows }),
    text: async () => JSON.stringify({ sessions: missingRows }),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  });
  global.fetch = fetchMock;
  useSearchStore.getState().reset();
  useSearchStore.setState({ query: '', recentSessionIds: ['cached-recent', ...missingRows.map((row) => row.agentSessionId)] });
  useSessionStore.setState({
    sessions: {
      'cached-recent': {
        agentSessionId: 'cached-recent', displayName: 'Cached recent', status: 'completed',
        createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z',
      },
    },
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedSessionIds: [],
  });

  const screen = render(
    <SearchScreen onOpenSession={jest.fn()} autoFocus={false} />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  await screen.findByText('Hydrated recent-missing-1');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.getAll('session_id')).toEqual(['recent-missing-1', 'recent-missing-2']);
  expect(useSessionStore.getState().feedMembership).toEqual({});
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);
});

test('인증 범위가 바뀌면 최근 세션의 늦은 응답은 버리고 같은 id를 다시 조회한다', async () => {
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [], sessionMatches: [], searchStatus: null, messageResults: [],
    navigationResults: [], loading: false, expansionPending: false, expansionFailed: false,
    error: null, hasMore: false, loadMore: jest.fn(),
  });
  const sessionId = 'recent-scope-switch';
  const oldRow = {
    agentSessionId: sessionId,
    displayName: 'Old account session',
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
  const currentRow = { ...oldRow, displayName: 'Current account session' };
  let resolveOld!: (response: Response) => void;
  let resolveCurrent!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
  const currentResponse = new Promise<Response>((resolve) => { resolveCurrent = resolve; });
  const fetchMock = jest.fn()
    .mockImplementationOnce(() => oldResponse)
    .mockImplementationOnce(() => currentResponse);
  global.fetch = fetchMock;
  useSearchStore.getState().reset();
  useSearchStore.setState({ query: '', recentSessionIds: [sessionId] });
  useSessionStore.setState({
    sessions: {},
    catalog: { folders: [], sessions: {} },
    feedMembership: {},
    feedSessionIds: [],
  });

  const screen = render(<SearchScreen onOpenSession={jest.fn()} autoFocus={false} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    useSettingsStore.setState({ serverUrl: 'https://search-b.test' });
    useSessionStore.setState({ sessions: {}, feedMembership: {}, feedSessionIds: [] });
  });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(new URL(fetchMock.mock.calls[0][0]).origin).toBe('https://search.test');
  expect(new URL(fetchMock.mock.calls[1][0]).origin).toBe('https://search-b.test');

  const responseFor = (row: typeof oldRow): Response => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ sessions: [row] }),
    text: async () => JSON.stringify({ sessions: [row] }),
    headers: new Headers({ 'Content-Type': 'application/json' }),
  } as Response);
  await act(async () => {
    resolveOld(responseFor(oldRow));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(useSessionStore.getState().sessions[sessionId]).toBeUndefined();

  resolveCurrent(responseFor(currentRow));
  await waitFor(() => expect(useSessionStore.getState().sessions[sessionId]?.displayName)
    .toBe('Current account session'));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(useSessionStore.getState().feedMembership).toEqual({});
  expect(useSessionStore.getState().feedSessionIds).toEqual([]);
  screen.unmount();
});

test('의미 확장이 부분 실패하고 결과가 없으면 완료된 0건으로 표시하지 않는다', () => {
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [],
    sessionMatches: [],
    searchStatus: {
      queryExpansion: { status: 'partial', reason: 'timeout', latencyMs: 3000 },
      searchLatencyMs: 3000,
      dbCancelFailed: false,
    },
    messageResults: [],
    navigationResults: [],
    loading: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
  });
  useSearchStore.getState().setQuery('Alpha');

  const screen = render(
    <SearchScreen onOpenSession={jest.fn()} autoFocus={false} />,
  );

  expect(screen.getByText('검색을 완료하지 못했습니다')).toBeTruthy();
  expect(screen.queryByText('검색 결과가 없습니다')).toBeNull();
});

test('일부 검색 경로가 실패하면 다른 경로 결과가 있어도 오류를 표시한다', async () => {
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [{
      agentSessionId: 'session-1',
      displayName: 'Alpha session',
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
    }],
    sessionMatches: [],
    searchStatus: null,
    messageResults: [],
    navigationResults: [],
    loading: false,
    error: '대화 검색 실패',
    hasMore: false,
    loadMore: jest.fn(),
  });
  useSearchStore.getState().setQuery('Alpha');

  const screen = render(
    <SearchScreen onOpenSession={jest.fn()} autoFocus={false} />,
  );
  await act(async () => {
    await Promise.resolve();
  });

  expect(screen.getByText('일부 검색 경로를 불러오지 못했습니다: 대화 검색 실패'))
    .toBeTruthy();
});

test('세션 수화 전에도 lexical projection을 열고 확장 순위 변경 뒤 선택 ID를 보존한다', async () => {
  const matches = [
    {
      sessionId: 'session-a', title: 'Alpha', excerpt: 'first hit', updatedAt: null,
      folderTitle: null, parentSessionId: null,
      bestMatch: { eventId: 81, matchSource: 'message', excerpt: 'first hit' },
      sessionUrl: '/?session=session-a&event=81',
    },
    {
      sessionId: 'session-b', title: 'Beta', excerpt: 'second hit', updatedAt: null,
      folderTitle: null, parentSessionId: null,
      bestMatch: { eventId: 82, matchSource: 'message', excerpt: 'second hit' },
      sessionUrl: '/?session=session-b&event=82',
    },
  ];
  useSessionStore.getState().setSessions([]);
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [],
    sessionMatches: matches,
    searchStatus: null,
    messageResults: [],
    navigationResults: [],
    loading: false,
    expansionPending: true,
    expansionFailed: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
  });
  const onOpenSession = jest.fn();
  const screen = render(
    <SearchScreen tablet onOpenSession={onOpenSession} autoFocus={false} />,
  );

  expect(screen.getByLabelText('세션 결과, Alpha')).toBeTruthy();
  expect(screen.getByText('의미 검색 중…')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('세션 결과, Beta'));
  expect(onOpenSession).toHaveBeenCalledWith('session-b', 82);

  await act(async () => {
    useSearchStore.getState().setSelectedResultIndex(1);
  });
  mockUseSessionSearch.mockReturnValue({
    sessionResults: [],
    sessionMatches: [...matches].reverse(),
    searchStatus: null,
    messageResults: [],
    navigationResults: [],
    loading: false,
    expansionPending: false,
    expansionFailed: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
  });
  await act(async () => {
    screen.rerender(<SearchScreen tablet onOpenSession={onOpenSession} autoFocus={false} />);
  });

  expect(useSearchStore.getState().selectedResultIndex).toBe(0);

  mockUseSessionSearch.mockReturnValue({
    sessionResults: [],
    sessionMatches: [matches[0]!],
    searchStatus: null,
    messageResults: [],
    navigationResults: [],
    loading: false,
    expansionPending: false,
    expansionFailed: false,
    error: null,
    hasMore: false,
    loadMore: jest.fn(),
  });
  await act(async () => {
    screen.rerender(<SearchScreen tablet onOpenSession={onOpenSession} autoFocus={false} />);
  });
  expect(useSearchStore.getState().selectedResultIndex).toBe(1);
  expect(screen.getByLabelText('세션 결과, Beta')).toBeTruthy();

  onOpenSession.mockClear();
  await act(async () => {
    useSearchStore.getState().requestActivateSelection();
  });
  expect(onOpenSession).toHaveBeenCalledWith('session-b', 82);
});
