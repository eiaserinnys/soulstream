import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useDraftStore } from '../../../store/draftStore';
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
import { CardCreateSheet } from '../CardCreateSheet';
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

beforeEach(async () => {
  await useAuthStore.persist.rehydrate();
  await useSettingsStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useAuthStore.setState({ jwt: `header.${Buffer.from(JSON.stringify({ email: 'card@example.com' })).toString('base64url')}.signature` });
  useSettingsStore.setState({ serverUrl: 'https://card.example' });
  useDraftStore.setState({ drafts: {} });
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

test.each([{ nativeHeader: true }, { inline: true }])('상세 완료 성공은 store를 갱신한 뒤 기존 닫기로 복귀한다 %s', async (presentation) => {
  const reviewing = { ...detail, questions: [], card: { ...card, status: 'review' as const } };
  const done = { ...card, status: 'done' as const, version: card.version + 1 };
  const api = { getCard: jest.fn().mockResolvedValueOnce(reviewing).mockResolvedValueOnce(reviewing).mockResolvedValue({ ...reviewing, card: done }),
    setCardStatus: jest.fn().mockResolvedValue({ card: done, folderId: card.folderId }) };
  const onClose = jest.fn(() => expect(useCardStore.getState().rows[card.id].status).toBe('done'));
  const screen = render(<CardDetailContent {...presentation} api={api as any} cardId={card.id} onClose={onClose} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  expect(screen.queryByLabelText('상태 변경')).toBeNull();
  if (!('nativeHeader' in presentation)) expect(screen.getByText('검수')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('완료')));
  expect(api.setCardStatus).toHaveBeenCalledWith(card.id, 'done', card.version, expect.any(String), undefined);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('완료 저장 중·실패 시 상세를 유지하고 중복 저장을 막는다', async () => {
  const reviewing = { ...detail, questions: [], card: { ...card, status: 'review' as const } };
  let reject!: (error: Error) => void;
  const api = { getCard: jest.fn().mockResolvedValue(reviewing), setCardStatus: jest.fn(() => new Promise((_resolve, fail) => { reject = fail; })) };
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const onClose = jest.fn();
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={onClose} />);
  await waitFor(() => expect(screen.getByLabelText('완료')).toBeTruthy());
  await act(async () => { fireEvent.press(screen.getByLabelText('완료')); });
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('완료'));
  expect(api.setCardStatus).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('저장 실패')));
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByTestId('card-detail-container')).toBeTruthy();
  expect(alert).toHaveBeenCalledWith('카드 변경 실패', '저장 실패');
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

test('커멘트 초안은 실패와 상세 닫기 후 복원되고 성공할 때만 삭제된다', async () => {
  const resolvedDetail = { ...detail, questions: [] };
  const api = { getCard: jest.fn().mockResolvedValue(resolvedDetail),
    addCardComment: jest.fn().mockRejectedValueOnce(new Error('연결 실패')).mockResolvedValue({ id: 'saved-comment', cardId: card.id, body: '나중에 이어 쓸 내용', authorKind: 'user' }) };
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const props = { api: api as any, cardId: card.id, onClose: jest.fn() };
  const screen = render(<CardDetailContent {...props} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '나중에 이어 쓸 내용');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(Object.values(useDraftStore.getState().drafts)).toContain('나중에 이어 쓸 내용');
  screen.unmount();
  const reopened = render(<CardDetailContent {...props} />);
  await waitFor(() => expect(reopened.getByDisplayValue('나중에 이어 쓸 내용')).toBeTruthy());
  await act(async () => fireEvent.press(reopened.getByLabelText('커멘트 보내기')));
  expect(useDraftStore.getState().drafts).toEqual({});
});


test('카드 생성은 요청 본문만 복원하고 제목은 기존 빈 값으로 시작한다', async () => {
  useSettingsStore.setState({ nodeId: 'node-1', cardAssignments: {
    'https://card.example': { folderId: card.folderId, nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' },
  } });
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
    createCard: jest.fn().mockResolvedValue({ card, folderId: card.folderId }), getCard: jest.fn().mockResolvedValue(detail),
  };
  const props = { api: api as any, folderId: card.folderId, onClose: jest.fn() };
  const first = render(<CardCreateSheet {...props} />);
  fireEvent.changeText(first.getByLabelText('카드 제목'), '저장하지 않을 제목');
  fireEvent.changeText(first.getByLabelText('요청 원문'), '이어 쓸 긴 요청');
  first.unmount();
  const next = render(<CardCreateSheet {...props} />);
  expect(next.getByLabelText('카드 제목').props.value).toBe('');
  expect(next.getByLabelText('요청 원문').props.value).toBe('이어 쓸 긴 요청');
  expect(Object.values(useDraftStore.getState().drafts)).toEqual(['이어 쓸 긴 요청']);
  fireEvent.changeText(next.getByLabelText('카드 제목'), '제출 제목');
  await waitFor(() => expect(next.getByLabelText('카드 저장')).toBeEnabled());
  await act(async () => fireEvent.press(next.getByLabelText('카드 저장')));
  expect(api.createCard).toHaveBeenCalledWith(expect.objectContaining({ title: '제출 제목', request: '이어 쓸 긴 요청',
    nodeId: 'node-1', assignee: { kind: 'agent', agentId: 'roselin' }, modelPreset: 'sol', queue: false, attachments: [] }));
  expect(useDraftStore.getState().drafts).toEqual({});
});
