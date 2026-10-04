jest.mock('../../../theme/useDeviceType', () => ({ ...jest.requireActual('../../../theme/useDeviceType'), useDeviceType: jest.fn(() => 'phone') }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('../../events/CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: ({ markdown }: any) => require('react').createElement(require('react-native').Text, null, markdown) }));
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: any) => require('react').createElement(require('react-native').Text, null, markdown) }));
jest.mock('../FolderSessionHistory', () => ({ FolderSessionHistory: ({ sessionIds, onOpenSession }: any) => require('react').createElement(require('react-native').Text, { testID: 'sessions', onPress: () => onOpenSession(sessionIds[0]) }, sessionIds.join(',')) }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { StyleSheet, useWindowDimensions } from 'react-native';
import { createSessionVisualRoles, useDeviceType, useTokens } from '../../../theme';
import { CardAssignmentSheet } from '../CardAssignmentSheet';
import { CardDetailContent, CardDetailSheet } from '../CardDetailSheet';
import { CardRow } from '../CardRow';
import { ExecutionSelectionSheet } from '../ExecutionSelectionSheet';
import { reportSummary } from '../CardTimeline';
import { GlassButton } from '../../GlassSurface';
import { CardCreateSheet } from '../CardCreateSheet';
import { TodayCardComposer } from '../TodayCardComposer';
import { cardFixture } from '../../../test-support/cards';
import { useCardStore } from '../../../store/cardStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useUIStore } from '../../../store/uiStore';
const card = cardFixture({ status: 'review', assigneeSessionId: 'root', assigneeKind: 'session' });
const session = { displayName: '담당 세션', agentSessionId: 'root', agentId: 'roselin', agentName: '로젤린', agentPortraitUrl: 'https://test/agent.png', status: 'idle', createdAt: card.createdAt, updatedAt: card.updatedAt };
const detail = { card, sessions: [session], reports: [{ id: 'r1', cardId: card.id, sessionId: 'root', title: '결과', body: '결론\n\n![첫 캡처](https://test/one.png)\n![두 캡처](https://test/two.png)\n![세 캡처](https://test/three.png)', format: 'markdown', createdAt: '2026-09-30T03:00:00Z' }],
  questions: [{ id: 'q1', cardId: card.id, sessionId: 'root', text: '질문 내용', answer: '답 내용', options: null, askedAt: '2026-09-30T01:00:00Z', answeredAt: '2026-09-30T02:00:00Z' }],
  comments: [{ id: 'c1', cardId: card.id, authorKind: 'user', authorId: 'user', sessionId: null, kind: 'spoken', body: '말로 한 지시', createdAt: '2026-09-30T04:00:00Z' }] };
beforeEach(() => {
  jest.mocked(useDeviceType).mockReturnValue('phone');
  useCardStore.setState({ rows: {}, details: {} });
  useSessionStore.setState({ sessions: { root: session }, catalog: { sessions: {}, folders: [{ id: 'folder-1', name: '폴더', projectPageId: 'page-1' }] as any } });
  useSettingsStore.setState({ serverUrl: 'https://cards.test', nodeId: 'node-1', cardAssignments: { 'https://cards.test': { folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' } } });
});
test('세션 → 좌우 말풍선 → 그 밖에 → 고정 입력 순서이며 완료만 보인다', async () => {
  const api = { getCard: jest.fn().mockResolvedValue(detail) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('지시')).toBeTruthy());
  expect(screen.getByLabelText('완료')).toBeTruthy();
  for (const label of ['폴더 변경', '담당 변경', '노드 변경', '모델 변경']) expect(screen.queryByLabelText(label)).toBeNull();
  for (const label of ['반려', '맡기기', '빼기', '더보기', '해석과 경과']) expect(screen.queryByLabelText(label) ?? screen.queryByText(label)).toBeNull();
  expect(screen.getAllByTestId('user-message-bubble')).toHaveLength(3);
  expect(screen.getAllByTestId('assistant-message-bubble')).toHaveLength(2);
  expect(screen.getByText('대화에서')).toBeTruthy();
  expect(screen.queryByText(card.brief)).toBeNull();
  expect(screen.getByTestId('card-timeline').props.children.map((child: any) => child.key)).toEqual(['request', 'question-q1', 'answer-q1', 'report-r1', 'comment-c1']);
  expect(screen.getAllByTestId(/card-report-thumbnail/)).toHaveLength(2);
  const children = screen.UNSAFE_getByType(require('react-native').ScrollView).props.children.filter(Boolean);
  expect(children.map((child: any) => child.props.testID ?? child.type.name)).toEqual(['card-sessions', 'CardTimeline', 'card-other']);
});
test('커멘트는 즉시 표시하고 API 한 건으로 교체한다', async () => {
  let resolve: any;
  const api = { getCard: jest.fn().mockResolvedValue(detail), addCardComment: jest.fn(() => new Promise((done) => { resolve = done; })) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('지시')).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('커멘트'), '새 커멘트');
  await act(async () => fireEvent.press(screen.getByLabelText('커멘트 보내기')));
  expect(api.addCardComment).toHaveBeenCalledWith(card.id, { body: '새 커멘트', idempotencyKey: expect.any(String) });
  expect(screen.getByText('새 커멘트')).toBeTruthy();
  await act(async () => resolve({ ...detail.comments[0], id: 'saved', kind: 'comment', body: '새 커멘트' }));
  expect(screen.getAllByText('새 커멘트')).toHaveLength(1);
});
test('오늘·폴더는 같은 행이고 초상과 완료 캡은 같은 44 토큰이다', () => {
  const screen = render(<><CardRow api={null} card={card} onOpen={jest.fn()} today /><CardRow api={null} card={{ ...card, id: 'other' }} onOpen={jest.fn()} /></>);
  expect(screen.getByText(/폴더 ·/)).toBeTruthy();
  expect(screen.getAllByText(/로젤린 ·/)).toHaveLength(2);
  expect(screen.queryByLabelText('반려')).toBeNull();
  const avatar = StyleSheet.flatten(screen.getByTestId(`card-${card.id}-avatar`).props.style);
  const cap = StyleSheet.flatten(screen.getByTestId(`card-${card.id}-완료-visual`).props.style);
  expect(avatar.width).toBe(44); expect(avatar.height).toBe(cap.height); expect(avatar.width).toBe(cap.width);
});
test.each([null, 'quota_exhausted'])('오늘 전송은 선택한 폴더·노드·모델로 세션을 만들고 카드를 만들지 않는다: %s', async reason => {
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }), listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }] }), listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true, reason }] }), createSession: jest.fn().mockResolvedValue({ agentSessionId: 'new-session' }), createCard: jest.fn() };
  const screen = render(<TodayCardComposer api={api as any} />);
  await waitFor(() => expect(screen.getByText(/로젤린/)).toBeTruthy());
  fireEvent.changeText(screen.getByLabelText('세션 첫 메시지'), '  시작 메시지  ');
  await act(async () => fireEvent.press(screen.getByLabelText('세션 시작')));
  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol', prompt: '  시작 메시지  ' }));
  expect(api.createCard).not.toHaveBeenCalled();
  expect(useSessionStore.getState().sessions['new-session'].agentId).toBe('roselin');
});

test.each([null, 'quota_exhausted'])('실행 시트는 세 목록을 독립 선택하고 노드 변경 시 같은 에이전트를 유지한다: %s', async reason => {
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }, { nodeId: 'node-2' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }, { id: 'other', name: '다른 에이전트', default_preset: 'luna' }] }),
    listModelPresets: jest.fn().mockImplementation((id) => Promise.resolve({ model_presets: [{ id: 'sol', label: 'Sol', available: true, reason }, { id: id === 'node-1' ? 'luna' : 'other-model', label: id === 'node-1' ? 'Luna' : '다른 모델', available: true, reason }] })) };
  const save = jest.fn();
  const screen = render(<ExecutionSelectionSheet api={api as any} value={{ folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' }} onSave={save} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('모델 Luna')).toBeTruthy());
  for (const section of ['execution-agents', 'execution-nodes', 'execution-models']) expect(screen.getByTestId(section)).toBeTruthy();
  for (const id of ['execution-agent-roselin', 'execution-node-node-1', 'execution-model-sol']) {
    expect(StyleSheet.flatten(screen.getByTestId(`${id}-visual`).props.style).height).toBe(32);
    expect(StyleSheet.flatten(screen.getByTestId(id).props.style).minHeight).toBeGreaterThanOrEqual(44);
  }
  fireEvent.press(screen.getByLabelText('에이전트 다른 에이전트'));
  fireEvent.press(screen.getByLabelText('실행 대상 확인'));
  expect(save).toHaveBeenLastCalledWith({ folderId: 'folder-1', nodeId: 'node-1', agentId: 'other', modelPreset: 'luna' });
  fireEvent.press(screen.getByLabelText('실행 대상 확인'));
  expect(save).toHaveBeenCalledTimes(1);
  // Actual callers unmount on confirmation and reopen with the saved assignment.
  screen.unmount();
  const reopened = render(<ExecutionSelectionSheet api={api as any} value={save.mock.calls[0][0]} onSave={save} onClose={jest.fn()} />);
  await waitFor(() => expect(reopened.getByLabelText('노드 node-2')).toBeTruthy());
  fireEvent.press(reopened.getByLabelText('노드 node-2'));
  await waitFor(() => expect(reopened.getByLabelText('모델 다른 모델')).toBeTruthy());
  expect(reopened.queryByLabelText('모델 Luna')).toBeNull();
  fireEvent.press(reopened.getByLabelText('모델 다른 모델'));
  fireEvent.press(reopened.getByLabelText('실행 대상 확인'));
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ folderId: 'folder-1', nodeId: 'node-2', agentId: 'other', modelPreset: 'other-model' });
});
test('+ 카드 시트는 제목·요청 원문을 todo로 저장한다', async () => {
  const saved = cardFixture({ status: 'todo' });
  const api = { listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }), listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
    createCard: jest.fn().mockResolvedValue({ card: saved, folderId: saved.folderId }), getCard: jest.fn().mockResolvedValue({ card: saved, sessions: [], questions: [], reports: [] }) };
  const screen = render(<CardCreateSheet api={api as any} onClose={jest.fn()} />);
  fireEvent.changeText(screen.getByLabelText('카드 제목'), '제목');
  fireEvent.changeText(screen.getByLabelText('요청 원문'), '  요청 원문  ');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(api.createCard).toHaveBeenCalledWith({ folderId: 'folder-1', title: '제목', request: '  요청 원문  ', queue: false,
    nodeId: 'node-1', assignee: { kind: 'agent', agentId: 'roselin' }, modelPreset: 'sol', attachments: [], idempotencyKey: expect.any(String) });
});

test.each(['폴더 변경', '담당 변경', '노드 변경', '모델 변경'])('배정 전 %s 칩은 같은 시트에서 설정을 원자적으로 저장한다', async (label) => {
  const unassigned = { ...card, assigneeSessionId: null, assigneeKind: 'agent' as const };
  const moved = { ...unassigned, folderId: 'folder-2', version: card.version + 1 };
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: unassigned, sessions: [] }), saveCardExecutionSettings: jest.fn().mockResolvedValue({ card: moved, folderId: moved.folderId }), moveCard: jest.fn(), updateCard: jest.fn() };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText(label)).toBeTruthy());
  fireEvent.press(screen.getByLabelText(label));
  const assignment = screen.UNSAFE_getByType(CardAssignmentSheet);
  expect(assignment.props.mode).toBe('edit');
  expect(assignment.props.includeFolder).not.toBe(false);
  await act(async () => assignment.props.onSave({ folderId: 'folder-2', nodeId: 'node-2', agentId: 'other', modelPreset: 'luna' }));
  expect(api.saveCardExecutionSettings).toHaveBeenCalledWith(card.id, { folderId: 'folder-2', nodeId: 'node-2', agentId: 'other', modelPreset: 'luna' }, card.version, expect.any(String));
  expect(api.moveCard).not.toHaveBeenCalled();
  expect(api.updateCard).not.toHaveBeenCalled();
});
test('긴 지시를 펼치면 기존 첨부 이미지와 파일 링크를 표시한다', async () => {
  const request = '한 문단 지시 '.repeat(60) + '\n\n첨부: 이미지(https://test/capture.png)\n첨부: 파일(https://test/file.pdf)';
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: { ...card, request } }) };
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('request 더 보기')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('request 더 보기'));
  expect(screen.getByTestId('card-request-image-0')).toBeTruthy();
  expect(screen.getByRole('link', { name: '파일' })).toBeTruthy();
});

test('카드 행은 세션 프레임·완료 캡만 쓰며 질문은 행으로 연다', () => {
  const open = jest.fn();
  const screen = render(<><CardRow api={null} card={card} onOpen={open} /><CardRow api={null} card={{ ...card, id: 'question-card', status: 'blocked', blockedKind: 'question' }} onOpen={open} /></>);
  expect(StyleSheet.flatten(screen.getByTestId(`card-row-${card.id}-layout`).props.style).minHeight).toBe(112);
  expect(screen.UNSAFE_getAllByType(GlassButton)).toHaveLength(1);
  expect(screen.queryByLabelText('질문 확인')).toBeNull();
  expect(screen.queryByLabelText('답하기')).toBeNull();
  fireEvent.press(screen.getAllByLabelText(`${card.title} 카드 상세`)[1]);
  expect(open).toHaveBeenCalled();
});
test('보고 미리보기는 HTML과 markdown의 전체 문단을 유지한 채 세 줄로 접는다', async () => {
  const reports = [{ ...detail.reports[0], body: '첫 문단\n\n두 번째 문단' }, { ...detail.reports[0], id: 'html', format: 'html', body: '<p>HTML 첫 문단</p><p>HTML 두 번째 문단</p>' }];
  expect(reportSummary(reports[0] as any)).toContain('두 번째 문단');
  expect(reportSummary(reports[1] as any)).toContain('HTML 두 번째 문단');
  const screen = render(<CardDetailContent api={{ getCard: jest.fn().mockResolvedValue({ ...detail, reports }) } as any} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText(/HTML 두 번째 문단/)).toBeTruthy());
  expect(screen.getByText(/HTML 두 번째 문단/).props.numberOfLines).toBe(3);
  const { result: t } = renderHook(useTokens);
  const { result: dimensions } = renderHook(useWindowDimensions);
  const composer = createSessionVisualRoles(t.current).chat.composer;
  const lineHeight = t.current.chatFontSize.body * t.current.lineHeightRatio * dimensions.current.fontScale;
  const inputStyle = StyleSheet.flatten(screen.getByLabelText('커멘트').props.style);
  // iOS style contract only: this renderer does not exercise native text layout.
  expect(inputStyle.minHeight).toBe(Math.max(composer.contentMinHeight, lineHeight + composer.inputPaddingVertical * 2));
  expect(inputStyle.height).toBe(inputStyle.minHeight);
});

test('드래프트 상세는 시작하기와 상태 메뉴를 노출하고 시작 뒤에도 열린다', async () => {
  const source = { ...card, status: 'todo' };
  const started = { ...source, status: 'running', version: source.version + 1 };
  const api = { getCard: jest.fn().mockResolvedValue({ ...detail, card: source }),
    executeCard: jest.fn().mockResolvedValue({ card: started, execution: { requestId: 'ux-request', sessionId: 'root', state: 'started' } }) };
  const close = jest.fn();
  const screen = render(<CardDetailContent api={api as any} cardId={card.id} onClose={close} />);
  await waitFor(() => expect(screen.getByText('할 일')).toBeTruthy());
  expect(screen.getByLabelText('시작하기')).toBeTruthy();
  expect(screen.queryByLabelText('완료')).toBeNull();
  expect(screen.getByLabelText('상태 변경')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('시작하기')));
  expect(api.executeCard).toHaveBeenCalledWith(card.id, source.version, expect.any(String));
  expect(screen.getByLabelText('완료')).toBeTruthy();
  expect(useCardStore.getState().rows[card.id].status).toBe('running');
  expect(close).not.toHaveBeenCalled();
});


test.each(['phone', 'tabletLandscape'] as const)('%s 카드 행은 실제 자식 높이와 상하 패딩을 합산해 세션 프레임 112를 쓴다', (device) => {
  jest.mocked(useDeviceType).mockReturnValue(device);
  const screen = render(<CardRow api={null} card={card} onOpen={jest.fn()} />);
  const row = StyleSheet.flatten(screen.getByTestId(`card-row-${card.id}-layout`).props.style);
  const open = StyleSheet.flatten(screen.getByLabelText(`${card.title} 카드 상세`).props.style);
  const avatar = StyleSheet.flatten(screen.getByTestId(`card-${card.id}-avatar`).props.style);
  const cap = StyleSheet.flatten(screen.getByTestId(`card-${card.id}-완료-visual`).props.style);
  const capTouch = StyleSheet.flatten(screen.getByLabelText('완료').props.style);
  const title = StyleSheet.flatten(screen.getByText(card.title).props.style);
  const status = StyleSheet.flatten(screen.getByText('검수').props.style);
  const metadata = StyleSheet.flatten(screen.getByText(/ · /).props.style);
  const preview = StyleSheet.flatten(screen.getByTestId(`card-${card.id}-preview`).props.style);
  const copyHeight = Math.max(title.lineHeight, status.lineHeight) + metadata.lineHeight + preview.lineHeight;
  const contentHeight = Math.max(avatar.height, copyHeight, cap.height, capTouch.minHeight);
  const renderedHeight = Math.max(row.minHeight, contentHeight + row.paddingVertical * 2);
  expect(avatar.height).toBe(44);
  expect(cap.height).toBe(44);
  expect(capTouch.minHeight).toBe(device === 'phone' ? 44 : 48);
  expect(renderedHeight).toBe(112);
});
