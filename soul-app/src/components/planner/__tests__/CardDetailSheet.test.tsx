jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => 'phone' }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, renderHook, userEvent, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, StyleSheet } from 'react-native';
import type { CardDetail, CardDto } from '../../../api/cardTypes';
import { useCardStore } from '../../../store/cardStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
import { FolderSessionHistory } from '../FolderSessionHistory';
import { useTokens } from '../../../theme';

jest.mock('../../events/CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: () => null }));
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: { markdown: string }) => require('react').createElement(require('react-native').Text, null, markdown) }));
jest.mock('react-native-webview', () => ({ WebView: (props: unknown) => require('react').createElement(require('react-native').View, props) }));
jest.mock('../../../hooks/usePlannerReads', () => ({ usePlannerFolderSessions: jest.fn(() => ({ data: null, loading: false, error: null })) }));
jest.mock('../../useSessionCardAnimation', () => ({ useSessionCardAnimation: () => {
  const { Animated } = require('react-native');
  return { pulse: new Animated.Value(0), shimmer: new Animated.Value(0), reducedMotion: true, appActive: true, animationEnabled: false };
} }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
import { CardDetailContent, CardDetailSheet } from '../CardDetailSheet';

const card: CardDto = { id: 'card-1', folderId: 'folder-1', title: '요청 제목', request: '원문', brief: '# 경과',
  status: 'blocked', blockedKind: 'question', blockedDetail: '선택 필요', assigneeKind: 'agent', assigneeAgentId: 'roselin',
  assigneeSessionId: null, assigneeUserId: null, nodeId: 'node-1', modelPreset: 'sol',
  positionKey: 'a', queuePositionKey: null, archived: false, version: 4, createdAt: '', updatedAt: '' };
const detail: CardDetail = { card, reports: [
  { id: 'latest', cardId: card.id, title: '최신 보고', body: '<p>최신</p>', format: 'html', createdAt: '2026-09-30' },
  { id: 'older', cardId: card.id, title: '이전 보고', body: '이전 본문', format: 'markdown', createdAt: '2026-09-29' },
], questions: [{ id: 'question-1', cardId: card.id, sessionId: 's1', text: '어떤 색?', options: ['파랑', '빨강'], answer: null, askedAt: '' }],
  sessions: [{ agentSessionId: 's1', displayName: '실행 세션', status: 'idle', createdAt: '', updatedAt: '' }] };

beforeEach(() => {
  useCardStore.setState({ rows: {}, details: {} });
  useSessionStore.setState({ sessions: { s1: detail.sessions[0] } });
  useNodeConnectivityStore.getState().reset();
});
afterEach(() => jest.restoreAllMocks());
test('질문 옵션을 고정 입력에 채우고 답을 전송하며 보고는 접혀 있다', async () => {
  const api = { getCard: jest.fn().mockResolvedValue(detail), answerCardQuestion: jest.fn().mockResolvedValue({ card, folderId: card.folderId }) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  expect(screen.queryByText('# 경과')).toBeNull();
  expect(screen.queryByTestId('card-report-html-latest')).toBeNull();
  fireEvent.press(screen.getByLabelText('report-latest 자세히'));
  expect(screen.getByTestId('card-report-html-latest')).toBeTruthy();
  expect(screen.getByText('실행 세션')).toBeTruthy();
  fireEvent.press(screen.getByText('파랑'));
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(api.answerCardQuestion).toHaveBeenCalledWith(card.id, 'question-1', '파랑', expect.any(String));
});

test('검수 상태는 단어로만 표시하고 완료 캡만 기존 API를 부른다', async () => {
  const reviewing = { ...detail, questions: [], card: { ...card, status: 'review' as const } };
  const api = { getCard: jest.fn().mockResolvedValue(reviewing), setCardStatus: jest.fn().mockResolvedValue({ card, folderId: card.folderId }) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  expect(screen.queryByLabelText('상태 변경')).toBeNull();
  expect(screen.getByText('검수')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('완료')));
  expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'done', card.version, expect.any(String), undefined);
});

test('카드의 루트 1개·자식 33개를 폴더 정본 컴포넌트로 hydrate하고 트리·탐색을 보존한다', async () => {
  useSessionStore.setState({ sessions: {} });
  const sessions = Array.from({ length: 34 }, (_, index) => ({ agentSessionId: `run-${index}`, displayName: `세션 ${index}`, status: 'completed',
    createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z', callerSessionId: index ? 'run-0' : null }));
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, sessions: sessions.map(({ callerSessionId, ...session }) => session) }),
    getSessionsByIds: jest.fn().mockResolvedValue(sessions) };
  const onClose = jest.fn();
  const onOpenSession = jest.fn();
  const { result } = renderHook(() => useTokens());
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={onClose} onOpenSession={onOpenSession} />);
  await waitFor(() => expect(screen.getByText('31개 더')).toBeTruthy());
  fireEvent.press(screen.getByText('31개 더'));
  await waitFor(() => expect(screen.getByTestId('task-run-row-run-33')).toBeTruthy());
  expect(screen.UNSAFE_getByType(FolderSessionHistory).props.sessionIds).toEqual(sessions.map((session) => session.agentSessionId));
  expect(api.getSessionsByIds.mock.calls.flatMap(([ids]) => ids)).toEqual(sessions.map((session) => session.agentSessionId));
  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-run-0').props.style).marginLeft).toBe(0);
  for (let index = 1; index < 34; index++) {
    expect(StyleSheet.flatten(screen.getByTestId(`task-run-depth-run-${index}`).props.style).marginLeft).toBe(result.current.spacing.md);
  }
  await userEvent.press(screen.getByTestId('task-run-row-run-33'));
  expect(onClose).toHaveBeenCalled();
  expect(onOpenSession).toHaveBeenCalledWith('run-33');
  expect(useSessionStore.getState().sessions['run-33'].updatedAt).toBe('2026-09-30T00:00:00Z');
});
