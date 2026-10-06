import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useDraftStore } from '../../../store/draftStore';
jest.mock('../../../theme', () => ({ ...jest.requireActual('../../../theme'), useDeviceType: () => 'phone' }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, renderHook, userEvent, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, FlatList, StyleSheet } from 'react-native';
import type { CardCheckItem, CardDetail, CardDto } from '../../../api/cardTypes';
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
function checkItem(id: number, display: CardCheckItem['display']): CardCheckItem {
  return {
    id, title: `항목 ${id}`, state: display === 'confirmed' || display === 'reported' ? 'done' : 'todo',
    result: null, evidence: [], caveat: null, rev: 1,
    confirmed: display === 'confirmed' ? { at: '2026-10-05T01:00:00Z', rev: 1 } : null,
    fixOpen: 0, reopened: null, from: null, createdAt: '', reportedAt: null, display,
  };
}

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
  expect(screen.getByTestId('card-detail-back-icon').props.name).toBe('chevron-back');
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
  fireEvent.press(screen.getByText('파랑'));
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(api.answerCardQuestion).toHaveBeenCalledWith(card.id, 'question-1', '파랑', expect.any(String));
  expect(screen.getByTestId('settings-segment-card-detail-comments').props.accessibilityState.selected).toBe(true);
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-sessions'));
  expect(screen.getByText('실행 세션')).toBeTruthy();
});

test('탭 밖에서 보낸 뒤 안내는 불투명한 알약 표면으로 목록과 구분한다', async () => {
  const source = { ...detail, card: { ...card, status: 'running' as const, blockedKind: null }, questions: [] };
  const saved = { id: 'notice-comment', cardId: card.id, authorKind: 'user' as const,
    authorId: 'user', sessionId: null, kind: 'comment' as const, body: '보낸 커멘트', createdAt: '' };
  const api = { getCard: jest.fn().mockResolvedValue(source), addCardComment: jest.fn().mockResolvedValue(saved) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-sessions'));
  fireEvent.changeText(screen.getByPlaceholderText('커멘트'), '보낸 커멘트');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(api.addCardComment).toHaveBeenCalled();
  await waitFor(() => expect(screen.getByTestId('card-comment-send-notice-surface')).toBeTruthy());

  const tokens = renderHook(() => useTokens()).result.current;
  const surface = StyleSheet.flatten(screen.getByTestId('card-comment-send-notice-surface').props.style);
  expect(surface.backgroundColor).toBe(tokens.colors.warningBg);
  expect(surface.borderColor).toBe(tokens.colors.warning);
  expect(surface.borderWidth).toBe(StyleSheet.hairlineWidth);
  expect(surface.borderRadius).toBe(tokens.foundation.radius.round);
  expect(surface.height).toBe(tokens.controlHeight.chip + tokens.uiSpacing.xs + tokens.uiSpacing.xxs);
});

test('탭을 오가도 이 상세에서 새로 확인한 항목은 확인함 묶음으로 옮기지 않는다', async () => {
  const items = [checkItem(1, 'confirmed'), checkItem(2, 'confirmed'), checkItem(3, 'todo')];
  const sourceCard = { ...card, items };
  const confirmedCard = { ...sourceCard, version: card.version + 1, items: items.map((item) => item.id === 3
    ? { ...item, display: 'confirmed' as const, confirmed: { at: '2026-10-05T01:00:00Z', rev: item.rev } }
    : item) };
  const api = {
    getCard: jest.fn().mockResolvedValue({ ...detail, card: sourceCard }),
    confirmCardItem: jest.fn().mockResolvedValue({ card: confirmedCard, folderId: card.folderId }),
  };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('card-item-checkbox-3')).toBeTruthy());

  await act(async () => fireEvent.press(screen.getByLabelText('3 항목 3 확인')));
  await waitFor(() => expect(useCardStore.getState().details[card.id]?.card.items?.[2].display).toBe('confirmed'));
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-comments'));
  expect(screen.getByTestId('card-timeline')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-items'));

  expect(screen.getByTestId('card-check-item-3')).toBeTruthy();
  expect(screen.queryByText('확인함 3개')).toBeNull();
});

test('항목이 없는 카드의 커멘트 탭은 뒤늦게 항목이 와도 선택을 유지한다', async () => {
  const emptyCard = { ...card, items: [] };
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: emptyCard }) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('card-timeline')).toBeTruthy());
  expect(screen.getByTestId('settings-segment-card-detail-comments').props.accessibilityState.selected).toBe(true);

  act(() => useCardStore.getState().putMutationCard({ ...emptyCard, version: card.version + 1, items: [checkItem(1, 'todo')] }));

  expect(screen.getByTestId('settings-segment-card-detail-comments').props.accessibilityState.selected).toBe(true);
  expect(screen.getByTestId('settings-segment-card-detail-items').props.accessibilityState.selected).toBe(false);
  expect(screen.getByTestId('card-timeline')).toBeTruthy();
  expect(screen.queryByTestId('card-check-items')).toBeNull();
});

test.each([{}, { inline: true }])('상세 완료 성공은 store를 갱신한 뒤 기존 닫기로 복귀한다 %s', async (presentation) => {
  const reviewing = { ...detail, questions: [], card: { ...card, status: 'review' as const } };
  const done = { ...card, status: 'done' as const, version: card.version + 1 };
  const api = { getCard: jest.fn().mockResolvedValueOnce(reviewing).mockResolvedValueOnce(reviewing).mockResolvedValue({ ...reviewing, card: done }),
    setCardStatus: jest.fn().mockResolvedValue({ card: done, folderId: card.folderId }) };
  const onClose = jest.fn(() => expect(useCardStore.getState().rows[card.id].status).toBe('done'));
  const screen = render(<CardDetailContent {...presentation} api={api as any} cardId={card.id} onClose={onClose} />);
  await waitFor(() => expect(screen.getByText('원문')).toBeTruthy());
  expect(screen.getByLabelText('상태 변경')).toBeTruthy();
  expect(screen.getByText('검수 대기')).toBeTruthy();
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
    createdAt: '2026-09-29T00:00:00Z', updatedAt: new Date(Date.UTC(2026, 8, 30, 0, index)).toISOString(), callerSessionId: index ? 'run-0' : null }));
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, sessions }),
    getSessionsByIds: jest.fn(async (ids: string[]) => sessions.filter(session => ids.includes(session.agentSessionId))) };
  const onClose = jest.fn();
  const onOpenSession = jest.fn();
  const { result } = renderHook(() => useTokens());
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={onClose} onOpenSession={onOpenSession} />);
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-sessions'));
  await waitFor(() => expect(screen.getByTestId('card-sessions')).toBeTruthy());
  expect(screen.queryByText('31개 더')).toBeNull();
  const list = screen.UNSAFE_getByType(FlatList);
  expect(screen.queryByTestId('card-detail-scroll')).toBeNull();
  expect(list.props.data).toHaveLength(34);
  expect(list.props.data[0].session.updatedAt).toBe(sessions[0].updatedAt);
  const orderBefore = list.props.data.map((row: any) => row.session.agentSessionId);
  expect(orderBefore).toEqual(['run-0', ...sessions.slice(1).reverse().map(session => session.agentSessionId)]);
  expect(list.props.data[1].depth).toBe(1);
  const history = screen.UNSAFE_getByType(FolderSessionHistory);
  expect(history.props.sessionIds).toEqual(sessions.map((session) => session.agentSessionId));
  act(() => list.props.onViewableItemsChanged({ viewableItems: [{ item: list.props.data[0] }], changed: [] }));
  await waitFor(() => expect(screen.getByTestId('task-run-row-run-0')).toBeTruthy());
  expect(api.getSessionsByIds.mock.calls.flatMap(([ids]) => ids)).toContain('run-0');
  expect(api.getSessionsByIds.mock.calls.flatMap(([ids]) => ids)).not.toContain('run-33');
  const lastRow = screen.UNSAFE_getByType(FlatList).props.data.find((row: any) => row.session.agentSessionId === 'run-33');
  act(() => list.props.onViewableItemsChanged({ viewableItems: [{ item: lastRow }], changed: [] }));
  await waitFor(() => expect(useSessionStore.getState().sessions['run-33'].updatedAt).toBe(sessions[33].updatedAt));

  expect(screen.UNSAFE_getByType(FlatList).props.data.map((row: any) => row.session.agentSessionId)).toEqual(orderBefore);
  expect(StyleSheet.flatten(screen.getByTestId('task-run-depth-run-0').props.style).marginLeft).toBe(0);
  await userEvent.press(screen.getByTestId('task-run-row-run-0'));
  expect(onClose).toHaveBeenCalled();
  expect(onOpenSession).toHaveBeenCalledWith('run-0');

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


test.each([{}, {inline:true}])('완료 상세에서도 기존 메뉴로 사유 없이 재착수한다 %s',async presentation=>{
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
 const screen=render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()}/>);
 await waitFor(()=>expect(screen.getByText('원문')).toBeTruthy());
 for(const label of ['폴더 변경','담당 변경','노드 변경','모델 변경'])expect(screen.queryByLabelText(label)).toBeNull();
 expect(screen.getByLabelText('상태 변경')).toBeTruthy();expect(screen.getByLabelText('완료')).toBeTruthy();expect(screen.getByTestId('card-comment-composer')).toBeTruthy();
 fireEvent.press(screen.getByTestId('settings-segment-card-detail-sessions'));
 expect(screen.getByTestId('card-sessions')).toBeTruthy();
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

test('커멘트의 대상 줄은 사용자와 답 모두에 나오고 사라진 항목은 번호만 남는다', async () => {
  const source = { ...detail, reports: [], questions: [], card: { ...card, items: [checkItem(1, 'reported')] },
    comments: [
      { id: 'target-user', cardId: card.id, authorKind: 'user', authorId: 'u', sessionId: null, kind: 'comment', itemId: 1, body: '고쳐 주세요', createdAt: '' },
      { id: 'target-agent', cardId: card.id, authorKind: 'agent', authorId: 'a', sessionId: 's1', kind: 'comment', itemId: 99, body: '고치겠습니다', createdAt: '' },
      { id: 'plain', cardId: card.id, authorKind: 'user', authorId: 'u', sessionId: null, kind: 'comment', body: '일반 글', createdAt: '' },
    ] };
  const screen = render(<CardDetailContent api={{ getCard: jest.fn().mockResolvedValue(source) } as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('card-check-items')).toBeTruthy());
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-comments'));
  expect(screen.getByText('대상: 1 항목 1')).toBeTruthy();
  expect(screen.getByText('대상: 99')).toBeTruthy();
  expect(screen.getAllByTestId(/card-comment-item-target/)).toHaveLength(2);
});


test('모두 확인 띠와 머리 완료는 저장 중 함께 잠기고 띠의 저장 성공도 닫기로 복귀한다', async () => {
  const reviewing = { ...detail, questions: [], card: { ...card, status: 'review' as const,
    now: { text: '확인 끝', turn: 'user' as const, ask: '봐 주세요', updatedAt: card.updatedAt, sessionId: 's1' },
    items: [checkItem(1, 'confirmed')] } };
  const saved = deferred<any>();
  const api = { getCard: jest.fn().mockResolvedValue(reviewing), setCardStatus: jest.fn(() => saved.promise) };
  const onClose = jest.fn();
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={onClose} />);
  await waitFor(() => expect(screen.getByTestId('card-now-complete')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByTestId('card-now-complete')));
  expect(screen.getByTestId('card-now-complete').props.accessibilityState.disabled).toBe(true);
  expect(screen.getAllByLabelText('완료').every(button => button.props.accessibilityState.disabled)).toBe(true);
  fireEvent.press(screen.getByTestId('card-now-complete'));
  expect(api.setCardStatus).toHaveBeenCalledTimes(1);
  await act(async () => saved.resolve({ card: { ...reviewing.card, status: 'done', version: card.version + 1 }, folderId: card.folderId }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('읽기 요약은 기존 요청과 경과 결과만 보여 주고 카드 열기 콜백을 부른다', async () => {
  const sourceCard = { ...card, number: 412, request: '요청 첫 단락\n\n요청 둘째 단락', attachments: [
    { nodeId: 'test-node', path: 'cards/test/screen.pdf', name: '화면 설계.pdf', mimeType: 'application/pdf' },
  ], now: {
    text: '현재 경과', turn: 'agent' as const, ask: null, updatedAt: card.updatedAt, sessionId: 's1',
  }, items: [{ ...checkItem(1, 'reported'), result: '사용자에게 보이는 결과' }] };
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: sourceCard, reports: [], questions: [] }) };
  const onOpenCard = jest.fn();
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()}
    variant="readSummary" onOpenCard={onOpenCard} />);
  await waitFor(() => expect(screen.getByTestId('card-read-summary-title')).toBeTruthy());

  expect(screen.getByTestId('card-read-summary-title').props.numberOfLines).toBe(2);
  expect(screen.getByTestId('card-read-summary-title').props.ellipsizeMode).toBe('tail');
  expect(screen.getByText('#412')).toBeTruthy();
  expect(screen.getByLabelText('화면 설계.pdf')).toBeTruthy();
  expect(screen.getByText('요청')).toBeTruthy();
  expect(screen.getByText('요청 첫 단락\n요청 둘째 단락')).toBeTruthy();
  expect(screen.getByText('요청 첫 단락\n요청 둘째 단락').props.numberOfLines).toBe(4);
  expect(StyleSheet.flatten(screen.getByText('요청 첫 단락\n요청 둘째 단락').props.style).color)
    .toBe(renderHook(() => useTokens()).result.current.colors.textMuted);
  expect(screen.getByText('경과')).toBeTruthy();
  expect(screen.getByText('현재 경과')).toBeTruthy();
  expect(screen.getByText('사용자에게 보이는 결과')).toBeTruthy();
  expect(screen.queryByLabelText('상태 변경')).toBeNull();
  expect(screen.queryByLabelText('시작하기')).toBeNull();
  expect(screen.queryByPlaceholderText('커멘트')).toBeNull();
  expect(screen.queryByTestId('settings-segment-card-detail-items')).toBeNull();
  expect(screen.queryByTestId('card-detail-dock')).toBeNull();
  expect(within(screen.getByTestId('card-read-summary-scroll')).queryByTestId('card-read-summary-open')).toBeNull();
  expect(screen.getByTestId('card-read-summary-footer')).toBeTruthy();

  screen.root.find((node) => node.props.testID === 'card-read-summary-open' && typeof node.props.onPress === 'function').props.onPress();
  expect(onOpenCard).toHaveBeenCalledTimes(1);
});

test('읽기 요약은 요청·경과가 없는 카드에서 해당 구역과 번호를 생략한다', async () => {
  const sourceCard = { ...card, number: null, request: '', attachments: [], now: null, items: [] };
  const screen = render(<CardDetailContent api={{ getCard: jest.fn().mockResolvedValue({ ...detail, card: sourceCard }) } as any}
    cardId={card.id} onClose={jest.fn()} variant="readSummary" onOpenCard={jest.fn()} />);
  await waitFor(() => expect(screen.getByTestId('card-read-summary-title')).toBeTruthy());

  expect(screen.queryByTestId('card-read-summary-number')).toBeNull();
  expect(screen.queryByTestId('card-read-summary-request')).toBeNull();
  expect(screen.queryByTestId('card-read-summary-progress')).toBeNull();
  expect(screen.getByTestId('card-read-summary-open')).toBeTruthy();
});

test('표시 이름이 없는 세션 담당은 세션 ID 기반 이름과 글자 초상을 남긴다', async () => {
  const assigneeSession = {
    agentSessionId: 'assigned-session', displayName: null, status: 'idle', createdAt: '', updatedAt: '',
    agentName: null, agentId: null, agentPortraitUrl: null, nodeId: null,
  };
  const sourceCard = { ...card, assigneeKind: 'session' as const, assigneeSessionId: assigneeSession.agentSessionId,
    assigneeAgentId: null, number: 412 };
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: sourceCard, sessions: [assigneeSession] }) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()}
    variant="readSummary" onOpenCard={jest.fn()} />);

  await waitFor(() => expect(screen.getByTestId('card-read-summary-title')).toBeTruthy());

  expect(screen.getByTestId('card-read-summary-assignee')).toBeTruthy();
  expect(screen.getByText('assigned')).toBeTruthy();
  expect(screen.getByTestId('card-read-summary-avatar').props.children.props.children).toBe('a');
});

test('읽기 요약의 실패와 불러오는 중은 본문 inset과 카드 행 높이를 유지한다', async () => {
  const failure = render(<CardDetailContent api={{ getCard: jest.fn().mockRejectedValue(new Error('읽기 실패')) } as any}
    cardId={card.id} onClose={jest.fn()} variant="readSummary" onOpenCard={jest.fn()} />);
  await waitFor(() => expect(failure.getByTestId('card-read-summary-error-state')).toBeTruthy());
  const tokens = renderHook(() => useTokens()).result.current;
  expect(StyleSheet.flatten(failure.getByTestId('card-read-summary-error-state').props.style))
    .toMatchObject({ padding: tokens.foundation.pageInset, minHeight: tokens.foundation.minHeight.row });

  const loading = render(<CardDetailContent api={{ getCard: jest.fn(() => new Promise(() => {})) } as any}
    cardId="loading-card" onClose={jest.fn()} variant="readSummary" onOpenCard={jest.fn()} />);
  expect(StyleSheet.flatten(loading.getByTestId('card-read-summary-loading-state').props.style))
    .toMatchObject({ padding: tokens.foundation.pageInset, minHeight: tokens.foundation.minHeight.row });
});

test('PAS 위에서 기본 카드 상세와 연결 세션 탭을 읽어도 활성 세션·표시 설정·채팅 이벤트를 바꾸지 않는다', async () => {
  const { useChatStore } = require('../../../store/chatStore');
  const { useUIStore } = require('../../../store/uiStore');
  useUIStore.setState({ activeSessionId: 'pas-preserved' });
  useChatStore.setState({ persistentDisplaySettings: { sessionId: 'pas-preserved', requestId: 27,
    settings: { show_character: true, animate_character: true, show_generation_separator: true, show_jev_candidates: true, show_turn_usage: true } } });
  const chatBefore = useChatStore.getState();
  const onOpenSession = jest.fn();
  const source = { ...detail, card: { ...card, assigneeKind: 'session' as const, assigneeSessionId: 's1' } };
  const api = { getCard: jest.fn().mockResolvedValue(source) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} onOpenSession={onOpenSession} />);
  await waitFor(() => expect(screen.getByTestId('card-detail-frame')).toBeTruthy());
  fireEvent.press(screen.getByTestId('settings-segment-card-detail-sessions'));
  await waitFor(() => expect(screen.getByTestId('task-run-row-s1')).toBeTruthy());
  expect(onOpenSession).not.toHaveBeenCalled();
  expect(useUIStore.getState().activeSessionId).toBe('pas-preserved');
  expect(useChatStore.getState()).toBe(chatBefore);
  fireEvent.press(screen.getByTestId('task-run-row-s1'));
  expect(onOpenSession).toHaveBeenCalledWith('s1');
});
