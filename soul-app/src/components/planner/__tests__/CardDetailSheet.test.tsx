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

// Count the real component boundaries without memoizing the test wrappers.
const mockRenders = { detail: 0, timeline: 0, sessions: 0, images: 0, rows: [] as string[] };
jest.mock('../../../hooks/useCardDetail', () => {
  const actual = jest.requireActual('../../../hooks/useCardDetail');
  return { useCardDetail: (...args: unknown[]) => { mockRenders.detail++; return actual.useCardDetail(...args); } };
});
jest.mock('../CardTimeline', () => {
  const actual = jest.requireActual('../CardTimeline');
  return { ...actual, CardTimeline: (props: unknown) => { mockRenders.timeline++; return require('react').createElement(actual.CardTimeline, props); } };
});
jest.mock('../FolderSessionHistory', () => {
  const actual = jest.requireActual('../FolderSessionHistory');
  return { FolderSessionHistory: (props: unknown) => { mockRenders.sessions++; return require('react').createElement(actual.FolderSessionHistory, props); } };
});
jest.mock('../../AttachmentImage', () => {
  const actual = jest.requireActual('../../AttachmentImage');
  return { AttachmentImage: (props: unknown) => { mockRenders.images++; return require('react').createElement(actual.AttachmentImage, props); } };
});
jest.mock('../../events/UserMessage', () => {
  const actual = jest.requireActual('../../events/UserMessage');
  return { ...actual, UserMessage: (props: any) => { mockRenders.rows.push(props.event.id); return require('react').createElement(actual.UserMessage, props); } };
});
jest.mock('../../events/AssistantMessage', () => {
  const actual = jest.requireActual('../../events/AssistantMessage');
  return { ...actual, AssistantMessage: (props: any) => { mockRenders.rows.push(props.event.id); return require('react').createElement(actual.AssistantMessage, props); } };
});
const mockControlLocks = { input: [] as boolean[], header: [] as boolean[] };
jest.mock('../../chat/ChatComposer', () => {
  const actual = jest.requireActual('../../chat/ChatComposer');
  return { ChatComposer: (props: any) => {
    mockControlLocks.input.push(!!props.disabled);
    return require('react').createElement(actual.ChatComposer, props);
  } };
});
jest.mock('../../CompactTouchTarget', () => {
  const actual = jest.requireActual('../../CompactTouchTarget');
  return { CompactTouchTarget: (props: any) => {
    if (props.accessibilityLabel === '상태 변경') mockControlLocks.header.push(!!props.disabled);
    return require('react').createElement(actual.CompactTouchTarget, props);
  } };
});
function resetRenders() { mockRenders.detail = mockRenders.timeline = mockRenders.sessions = mockRenders.images = 0; mockRenders.rows = []; }

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
  mockControlLocks.input = []; mockControlLocks.header = [];
});
afterEach(() => jest.restoreAllMocks());
test('상세 패널의 기존 상태 진입점에서 같은 색상 선택 메뉴를 연다', async () => {
  const colored = { ...detail, card: { ...card, color: 'blue' } };
  const api = { getCard: jest.fn().mockResolvedValue(colored) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());

  await act(async () => fireEvent.press(screen.getByLabelText('상태 변경')));
  await waitFor(() => expect(screen.getByLabelText('카드 색상: 하늘')).toBeTruthy());
  expect(api.getCard).toHaveBeenCalledWith(card.id);
});

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
  expect(screen.getByLabelText('상태 변경')).toBeTruthy();
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


test.each([{nativeHeader:true},{inline:true}])('완료 상세에서도 기존 메뉴로 사유 없이 재착수한다 %s',async presentation=>{
  const completed={...detail,card:{...card,status:'done' as const},reports:[],questions:[]};
  const api={getCard:jest.fn().mockResolvedValue(completed),executeCard:jest.fn().mockResolvedValue({card:{...completed.card,status:'running'},folderId:card.folderId,execution:{requestId:'resume-card',sessionId:'owner',state:'started'}})};
  const screen=render(<CardDetailContent {...presentation} api={api as any} cardId={card.id} onClose={jest.fn()}/>);
  await waitFor(()=>expect(screen.getByLabelText('상태 변경')).toBeTruthy());
  await act(async()=>fireEvent.press(screen.getByLabelText('상태 변경')));
  await waitFor(()=>expect(screen.getByLabelText('실행 중로 이동')).toBeTruthy());
  await act(async()=>fireEvent.press(screen.getByLabelText('실행 중로 이동')));
  expect(api.executeCard).toHaveBeenCalledWith(card.id,card.version,expect.any(String));
});


test('assigned settings disappear while native status/complete and sessions remain',async()=>{
 const assigned={...card,assigneeKind:'session' as const,assigneeSessionId:'s1'};
 const api={getCard:jest.fn().mockResolvedValue({...detail,card:assigned})};
 const screen=render(<CardDetailContent api={api as any} cardId={card.id} nativeHeader onClose={jest.fn()}/>);
 await waitFor(()=>expect(screen.getByText('원문')).toBeTruthy());
 for(const label of ['폴더 변경','담당 변경','노드 변경','모델 변경'])expect(screen.queryByLabelText(label)).toBeNull();
 expect(screen.getByLabelText('상태 변경')).toBeTruthy();expect(screen.getByLabelText('완료')).toBeTruthy();expect(screen.getByTestId('card-sessions')).toBeTruthy();expect(screen.getByTestId('card-comment-composer')).toBeTruthy();
});

test.each(['todo','queued'] as const)('상세 %s 시작은 접수 후 화면을 유지하고 실패 알림 없이 시작 중을 보인다',async status=>{
 jest.useFakeTimers();
 const source={...card,id:`start-detail-${status}`,status};const current={...detail,card:source,questions:[]};
 const result={card:{...source,status:'running',version:5},folderId:source.folderId,execution:{requestId:`detail-${status}`,sessionId:'owner',state:'pending'}};
 const api={getCard:jest.fn().mockResolvedValue(current),executeCard:jest.fn().mockResolvedValue(result),getCardExecution:jest.fn().mockResolvedValue({...result,execution:{...result.execution,state:'started'}})};
 const alert=jest.spyOn(Alert,'alert').mockImplementation(()=>{}),onClose=jest.fn();
 const screen=render(<CardDetailContent api={api as any} cardId={source.id} onClose={onClose}/>);
 await act(async()=>{await Promise.resolve();});
 await act(async()=>fireEvent.press(screen.getByLabelText('시작하기')));
 expect(api.executeCard).toHaveBeenCalledTimes(1);expect(screen.getByLabelText('시작 중…')).toBeTruthy();expect(onClose).not.toHaveBeenCalled();expect(alert).not.toHaveBeenCalled();
 await act(async()=>{await jest.advanceTimersByTimeAsync(1000);});
 expect(screen.queryByLabelText('시작 중…')).toBeNull();expect(onClose).not.toHaveBeenCalled();jest.useRealTimers();
});

function commentDetail(count: number): CardDetail {
  return { ...detail, reports: [], questions: [], comments: Array.from({ length: count }, (_, index) => ({
    id: `comment-${index}`, cardId: card.id, authorKind: 'user', authorId: 'user', sessionId: null, kind: 'comment',
    body: `내용 ${index}` + (index % 3 === 0 ? '\n\n![그림](https://card.example/image.png)' : ''), createdAt: `2026-10-01T00:00:${String(index).padStart(2, '0')}Z`,
  })) };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test.each([10, 50, 100])('커멘트 %i개에서 입력·줄바꿈·삭제는 상세와 기존 타임라인을 재실행하지 않는다', async count => {
  const current = commentDetail(count);
  const api = { getCard: jest.fn().mockResolvedValue(current) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('내용 1')).toBeTruthy());
  resetRenders();
  const input = screen.getByPlaceholderText('커멘트');
  for (const text of ['글', '글을 입력합니다\n두 번째 줄입니다', '']) fireEvent.changeText(input, text);
  expect(mockRenders).toEqual({ detail: 0, timeline: 0, sessions: 0, images: 0, rows: [] });
});

test('커멘트 접수 때 비우고 추가·저장 교체는 해당 항목만 렌더한다', async () => {
  const current = commentDetail(10), saved = deferred<any>();
  const api = { getCard: jest.fn().mockResolvedValue(current), addCardComment: jest.fn(() => saved.promise) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('내용 1')).toBeTruthy());
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '새 커멘트');
  resetRenders();
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(screen.getByPlaceholderText('커멘트').props.editable).toBe(false);
  expect([...new Set(mockRenders.rows)]).toHaveLength(1);
  expect(mockRenders.rows[0]).not.toMatch(/^comment-comment-/);
  resetRenders();
  await act(async () => saved.resolve({ ...current.comments![0], id: 'saved', body: '새 커멘트' }));
  expect([...new Set(mockRenders.rows)]).toEqual(['comment-saved']);
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
});

test('선택지 답변은 저장·상세 재조회 대기 동안 비고 재조회에서 바뀐 항목만 렌더한다', async () => {
  const save = deferred<any>(), refresh = deferred<CardDetail>();
  const api = { getCard: jest.fn().mockResolvedValueOnce(detail).mockImplementation(() => refresh.promise), answerCardQuestion: jest.fn(() => save.promise) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('파랑')).toBeTruthy());
  fireEvent.press(screen.getByText('파랑'));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('파랑');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
  expect(useDraftStore.getState().drafts).toEqual({});
  await act(async () => save.resolve({ card: { ...card, version: 5 }, folderId: card.folderId }));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
  resetRenders();
  const updated = JSON.parse(JSON.stringify(detail));
  updated.card.version = 5;
  updated.questions[0].answer = '파랑'; updated.questions[0].answeredAt = '2026-10-05';
  await act(async () => refresh.resolve(updated));
  expect([...new Set(mockRenders.rows)].sort()).toEqual(['answer-question-1', 'question-question-1']);
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
});

test.each([false, true])('전송 실패는 원문을 복원하고 새 글이 있으면 합친다: %s', async hasNewText => {
  const saved = deferred<any>(), alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const api = { getCard: jest.fn().mockResolvedValue(commentDetail(10)), addCardComment: jest.fn(() => saved.promise) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('내용 1')).toBeTruthy());
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '보낸 원문');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
  // Model a new draft arriving while the native control is locked; editing stays disabled.
  if (hasNewText) act(() => screen.getByPlaceholderText('커멘트').props.onChangeText('새 글'));
  await act(async () => saved.reject(new Error('연결 실패')));
  expect(alert).toHaveBeenCalledWith('커멘트 저장 실패', '연결 실패');
  const text = hasNewText ? '보낸 원문\n\n새 글' : '보낸 원문';
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe(text);
  expect(Object.values(useDraftStore.getState().drafts)).toEqual([text]);
});

test('내용이 같은 상세 재조회는 항목을 유지하고 변경된 커멘트만 표시한다', async () => {
  const current = commentDetail(10), api = { getCard: jest.fn().mockResolvedValue(current) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('내용 1')).toBeTruthy());
  resetRenders();
  await act(async () => useCardStore.getState().putDetail(JSON.parse(JSON.stringify(current))));
  expect(mockRenders.rows).toEqual([]);
  const changed = JSON.parse(JSON.stringify(current)); changed.comments[1].body = '수정된 내용';
  await act(async () => useCardStore.getState().putDetail(changed));
  expect(mockRenders.rows).toEqual(['comment-comment-1']);
  expect(screen.getByText('수정된 내용')).toBeTruthy();
});


test.each([false, true])('첨부 업로드·삭제·실패 복원은 입력창 경계에서 유지된다: 질문 %s', async question => {
  const current = { ...(question ? detail : commentDetail(10)), card: { ...card, assigneeSessionId: 's1' } };
  const saved = deferred<any>();
  const api = { getCard: jest.fn().mockResolvedValue(current), uploadAttachment: jest.fn().mockResolvedValue({ path: '/capture.png' }),
    addCardComment: jest.fn(() => saved.promise), answerCardQuestion: jest.fn(() => saved.promise) };
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
  const picker = require('expo-document-picker');
  const picked = { canceled: false, assets: [{ uri: 'file:///capture.png', name: 'capture.png', mimeType: 'image/png' }] };
  const selection = deferred<any>();
  picker.getDocumentAsync.mockReturnValueOnce(selection.promise).mockResolvedValue(picked);
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-attach-button')));
  expect(screen.getByPlaceholderText('커멘트').props.editable).toBe(false);
  await act(async () => selection.resolve(picked));
  await waitFor(() => expect(screen.getByLabelText('capture.png 첨부 제거')).toBeTruthy());
  expect(api.uploadAttachment).toHaveBeenCalledWith('s1', 'node-1', expect.objectContaining({ name: 'capture.png' }));
  fireEvent.press(screen.getByLabelText('capture.png 첨부 제거'));
  expect(screen.queryByLabelText('capture.png 첨부 제거')).toBeNull();
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-attach-button')));
  await waitFor(() => expect(screen.getByLabelText('capture.png 첨부 제거')).toBeTruthy());
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '첨부 원문');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('');
  expect(screen.queryByLabelText('capture.png 첨부 제거')).toBeNull();
  await act(async () => saved.reject(new Error('첨부 저장 실패')));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('첨부 원문');
  expect(screen.getByLabelText('capture.png 첨부 제거')).toBeTruthy();
  expect(Alert.alert).toHaveBeenCalledWith(question ? '카드 변경 실패' : '커멘트 저장 실패', '첨부 저장 실패');
});


test('카드 로딩 중 입력은 유지하고 보내기만 막으며 첨부 안내를 띄우지 않는다', async () => {
  const load = deferred<CardDetail>();
  const api = { getCard: jest.fn(() => load.promise), addCardComment: jest.fn() };
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  expect(screen.getByPlaceholderText('커멘트').props.editable).toBe(true);
  resetRenders();
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '받아오는 동안 친 글');
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('받아오는 동안 친 글');
  expect(mockRenders).toEqual({ detail: 0, timeline: 0, sessions: 0, images: 0, rows: [] });
  expect(screen.getByLabelText('커멘트 보내기').props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByLabelText('커멘트 보내기'));
  fireEvent.press(screen.getByTestId('chat-composer-attach-button'));
  expect(api.addCardComment).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  await act(async () => load.resolve(commentDetail(10)));
  expect(screen.getByPlaceholderText('커멘트').props.value).toBe('받아오는 동안 친 글');
  expect(screen.getByLabelText('커멘트 보내기').props.accessibilityState.disabled).toBe(false);
  resetRenders();
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '받아오는 동안 친 글 이어서');
  expect(mockRenders).toEqual({ detail: 0, timeline: 0, sessions: 0, images: 0, rows: [] });
  fireEvent.press(screen.getByTestId('chat-composer-attach-button'));
  expect(alert).toHaveBeenCalledWith('곧 지원', '담당 세션이 연결되면 첨부를 올릴 수 있습니다.');
});

test('준비된 초안으로 상세를 열면 첫 렌더부터 머리 버튼과 입력창을 잠그지 않는다', () => {
  useCardStore.getState().putDetail(commentDetail(10));
  const load = deferred<CardDetail>();
  const screen = render(<CardDetailContent api={{ getCard: () => load.promise } as any} cardId={card.id} onClose={jest.fn()} />);
  expect(mockControlLocks.input.length).toBeGreaterThan(0);
  expect(mockControlLocks.header.length).toBeGreaterThan(0);
  expect(mockControlLocks.input.every(locked => !locked)).toBe(true);
  expect(mockControlLocks.header.every(locked => !locked)).toBe(true);
  expect(screen.getByPlaceholderText('커멘트').props.editable).toBe(true);
});

test('초안 저장소 준비 전에는 입력창 자체 busy가 입력과 전송을 막는다', () => {
  jest.spyOn(useDraftStore.persist, 'hasHydrated').mockReturnValue(false);
  useCardStore.getState().putDetail(commentDetail(10));
  const load = deferred<CardDetail>();
  const api = { getCard: () => load.promise, addCardComment: jest.fn() };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  expect(screen.getByPlaceholderText('커멘트').props.editable).toBe(false);
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '저장소 준비 전 글');
  fireEvent.press(screen.getByLabelText('커멘트 보내기'));
  expect(useDraftStore.getState().drafts).toEqual({});
  expect(api.addCardComment).not.toHaveBeenCalled();
});
