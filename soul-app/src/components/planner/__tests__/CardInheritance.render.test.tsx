jest.mock('../../../theme/useDeviceType', () => ({ ...jest.requireActual('../../../theme/useDeviceType'), useDeviceType: jest.fn(() => 'phone') }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('../../events/CopyableAssistantMarkdown', () => ({ CopyableAssistantMarkdown: () => null }));
jest.mock('../PlannerMarkdownText', () => ({ PlannerMarkdownText: ({ markdown }: any) => require('react').createElement(require('react-native').Text, null, markdown) }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
jest.mock('../../../hooks/usePlannerReads', () => ({ usePlannerFolderSessions: () => ({ data: null, loading: false, error: null }) }));
jest.mock('../../sheets/useNewSessionSelection', () => ({ useNewSessionSelection: () => ({ selectedAgentName: '로젤린', selectedNodeName: '', selectedModelPresetName: '자동 선택', agents: [] }) }));
jest.mock('../../useSessionCardAnimation', () => ({ useSessionCardAnimation: () => {
  const { Animated } = require('react-native');
  return { pulse: new Animated.Value(0), shimmer: new Animated.Value(0), reducedMotion: true, appActive: true, animationEnabled: false };
} }));
import React from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Platform, StyleSheet, useWindowDimensions } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { CardRow } from '../CardRow';
import { CardDetailContent } from '../CardDetailSheet';
import { TodayCardComposer } from '../TodayCardComposer';
import { ChatComposer } from '../../chat/ChatComposer';
import { SessionCard } from '../../SessionCard';
import { FolderSessionHistory } from '../FolderSessionHistory';
import { makeFolderWorkspaceStyles } from '../FolderWorkspace.styles';
import { cardFixture } from '../../../test-support/cards';
import { useTokens, useDeviceType, createSessionVisualRoles } from '../../../theme';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useCardStore } from '../../../store/cardStore';
import { useNodeConnectivityStore } from '../../../store/nodeConnectivityStore';
const card = cardFixture({ status: 'review', assigneeSessionId: 'root', nodeId: 'node-1' });
const root = { agentSessionId: 'root', displayName: '담당 세션', agentId: 'roselin', nodeId: 'node-1', modelPreset: 'sol', status: 'idle', createdAt: '', updatedAt: '' };
const child = { ...root, agentSessionId: 'child', displayName: '작업 세션', callerSessionId: 'root' };
const detail = { card, sessions: [root, child], questions: [], comments: [], reports: [{ id: 'r', cardId: card.id, title: '보고', body: '결론\n![사진](https://test/one.png)\n![사진2](https://test/two.png)', format: 'markdown', createdAt: '' }] };
beforeEach(() => {
  jest.mocked(useDeviceType).mockReturnValue('phone');
  useSettingsStore.setState({ serverUrl: 'https://cards.test', nodeId: 'node-1', cardAssignments: { 'https://cards.test': { folderId: card.folderId, nodeId: null, agentId: 'roselin', modelPreset: null } } });
  useNodeConnectivityStore.getState().reset();
  useCardStore.setState({ rows: {}, details: {} });
  useSessionStore.setState({ sessions: { root, child }, catalog: { sessions: {}, folders: [{ id: card.folderId, name: '폴더' }] as any } });
});
afterEach(() => jest.restoreAllMocks());
const flat = (style: any) => StyleSheet.flatten(style);
async function content(api: any = { getCard: jest.fn().mockResolvedValue(detail) }) {
  const screen = render(<CardDetailContent api={api} cardId={card.id} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('지시')).toBeTruthy());
  return screen;
}
test.each(['phone', 'tabletLandscape'] as const)('%s 카드 행은 세션 카드의 프레임과 높이 합계를 상속한다', device => {
  jest.mocked(useDeviceType).mockReturnValue(device);
  const screen = render(<><SessionCard embedded session={root} onPress={jest.fn()} /><CardRow today api={null} card={card} onOpen={jest.fn()} /></>);
  const row = flat(screen.getByTestId(`card-row-${card.id}-layout`).props.style);
  const session = flat(screen.getByTestId('session-card-pressable').props.style);
  // A disabled session pulse retains shadow metadata with zero opacity; it
  // does not alter the shared frame or its visible static surface.
  const { shadowColor, shadowOffset, shadowRadius, ...staticSession } = session;
  expect(row).toEqual(staticSession);
  expect(session.shadowOpacity).toBe(0);
  const avatar = flat(screen.getByTestId(`card-${card.id}-avatar`).props.style);
  expect(avatar.height).toBe(flat(screen.getByTestId('session-card-agent-avatar').props.style).height);
  const cardTitle = flat(screen.getByText(card.title).props.style);
  const meta = flat(screen.getByText(/폴더 ·/).props.style);
  const preview = flat(screen.getByTestId(`card-${card.id}-preview`).props.style);
  expect(cardTitle.lineHeight + meta.lineHeight + preview.lineHeight).toBe(['session-card-title', 'session-card-identity', 'session-card-context'].reduce((sum, id) => sum + flat(screen.getByTestId(id).props.style).lineHeight, 0));
  const cardContent = Math.max(avatar.height, cardTitle.lineHeight + meta.lineHeight + preview.lineHeight, flat(screen.getByLabelText('완료').props.style).minHeight);
  const sessionContent = Math.max(avatar.height, ['session-card-title', 'session-card-identity', 'session-card-context'].reduce((sum, id) => sum + flat(screen.getByTestId(id).props.style).lineHeight, 0));
  expect(Math.max(row.minHeight, cardContent + row.paddingVertical * 2)).toBe(Math.max(session.minHeight, sessionContent + session.paddingVertical * 2));
});
test('카드 배경은 폴더 컨테이너이고 small은 폴더 히스토리의 여백·초상·간격을 상속한다', async () => {
  const screen = await content();
  const { result } = renderHook(() => useTokens());
  expect(flat(screen.getByTestId('card-detail-container').props.style)).toMatchObject(makeFolderWorkspaceStyles(result.current).container);
  expect(screen.UNSAFE_getByType(FolderSessionHistory).props.compact).toBeUndefined();
  expect(screen.UNSAFE_getByType(FolderSessionHistory).props.small).toBe(true);
  const small = flat(screen.getByTestId('task-run-row-root').props.style);
  expect(small.minHeight).toBeUndefined();
  expect(small.paddingVertical).toBe(16);
  expect(flat(screen.getByTestId('task-run-avatar-root').props.style).height).toBe(44);
  expect(screen.queryByTestId('session-card-context-row')).toBeNull();
  expect(screen.getAllByTestId('session-card-identity')[0].props.children).toContain('node-1 · sol');
  expect(flat(screen.getByTestId('task-run-history-list').props.style).gap).toBe(result.current.cardLayout.gap);
  expect(flat(screen.getByTestId('task-run-depth-child').props.style).marginLeft).toBe(result.current.spacing.md);
});
test('카드 셋째 줄은 최신 보고 제목 → 최신 커멘트 → 요청 순서이다', () => {
  const screen = render(<CardRow api={null} card={card} onOpen={jest.fn()} />);
  expect(screen.getByTestId(`card-${card.id}-preview`).props.children).toBe(card.request.split('\n')[0]);
  act(() => useCardStore.getState().putDetail({ ...detail, reports: [], comments: [{ id: 'c', cardId: card.id, body: '커멘트 첫 줄\n다음 줄', createdAt: '', authorKind: 'user', authorId: null, sessionId: null, kind: 'comment' }] }));
  expect(screen.getByTestId(`card-${card.id}-preview`).props.children).toBe('커멘트 첫 줄');
  act(() => useCardStore.getState().putDetail({ ...detail, reports: [{ ...detail.reports[0], title: '최신 보고 제목' }] } as any));
  expect(screen.getByTestId(`card-${card.id}-preview`).props.children).toBe('최신 보고 제목');
});
test('커멘트 입력은 ChatComposer이고 업로드 URL을 본문으로 전송한다', async () => {
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://one.png', name: '사진.png', mimeType: 'image/png' }] } as any);
  const api = { getCard: jest.fn().mockResolvedValue(detail), uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/사진.png' }), addCardComment: jest.fn().mockResolvedValue({ id: 'saved', body: '본문', authorKind: 'user', createdAt: '' }) };
  const screen = await content(api);
  expect(screen.UNSAFE_getByType(ChatComposer).props.placeholder).toBe('커멘트');
  const contentRow = screen.getByTestId('chat-composer-content-row');
  expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  expect(React.Children.toArray(contentRow.props.children).map((child: any) => child.props.testID))
    .toEqual(['chat-composer-attach-slot', 'chat-composer-text-input', 'chat-composer-controls-spacer', undefined]);
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-attach-button')));
  expect(api.uploadAttachment).toHaveBeenCalledWith('root', 'node-1', expect.objectContaining({ name: '사진.png' }));
  fireEvent.changeText(screen.getByTestId('chat-composer-text-input'), '본문');
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-send-button')));
  expect(api.addCardComment).toHaveBeenCalledWith(card.id, expect.objectContaining({ body: '본문\n\n![사진.png](https://cards.test/api/attachments/files?nodeId=node-1&path=%2Ftmp%2F%EC%82%AC%EC%A7%84.png)' }));
});
test('담당 세션이 없으면 첨부 캡은 곧 지원 안내를 연다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const screen = await content({ getCard: jest.fn().mockResolvedValue({ ...detail, card: { ...card, assigneeSessionId: null } }) });
  fireEvent.press(screen.getByTestId('chat-composer-attach-button'));
  expect(Alert.alert).toHaveBeenCalledWith('곧 지원', expect.any(String));
});
test('오늘 입력은 ChatComposer의 한 줄 시작·폰트·버튼을 상속하고 기본 노드를 표시한다', () => {
  const screen = render(<TodayCardComposer api={null} />);
  expect(screen.UNSAFE_getByType(ChatComposer)).toBeTruthy();
  const contentRow = screen.getByTestId('chat-composer-content-row');
  expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  expect(screen.queryByTestId('chat-composer-controls-row')).toBeNull();
  const input = screen.getByTestId('chat-composer-text-input');
  const { result: t } = renderHook(useTokens);
  const { result: dimensions } = renderHook(useWindowDimensions);
  const composer = createSessionVisualRoles(t.current).chat.composer;
  const lineHeight = t.current.chatFontSize.body * t.current.lineHeightRatio * dimensions.current.fontScale;
  // iOS style contract only: this renderer does not exercise native text layout.
  expect(flat(input.props.style).minHeight).toBe(Math.max(composer.contentMinHeight, lineHeight + composer.inputPaddingVertical * 2));
  expect(flat(input.props.style).height).toBe(flat(input.props.style).minHeight);
  expect(input.props.textAlignVertical).toBe('center');
  expect(screen.getByText(/로젤린 · node-1 · 자동 선택/)).toBeTruthy();
  expect(screen.getAllByTestId('chat-composer-send-button')).toHaveLength(1);
});
test('말풍선 전체 탭으로 접고 펼치며 별도 더 보기 터치 프레임이 없다', async () => {
  const screen = await content();
  expect(flat(screen.getByTestId('card-fold-request').props.style)?.minHeight).toBeUndefined();
  const fold = screen.getByLabelText('report-r 자세히');
  fireEvent.press(fold);
  expect(screen.getByLabelText('report-r 접기')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('report-r 접기'));
  expect(screen.getByLabelText('report-r 자세히')).toBeTruthy();
});
test('보고 썸네일은 공용 AttachmentImage이며 탭하면 확대·페이징 뷰어가 열린다', async () => {
  const screen = await content();
  expect(screen.UNSAFE_getAllByType(require('../../AttachmentImage').AttachmentImage)).toHaveLength(2);
  fireEvent.press(screen.getByLabelText('보고 캡처 2'));
  const viewer = screen.getByTestId('image-viewer-pages');
  expect(viewer.props.pagingEnabled).toBe(true);
  expect(viewer.props.contentOffset.x).toBeGreaterThan(0);
  expect(screen.getAllByTestId('image-viewer-zoom')).toHaveLength(2);
  expect(screen.getAllByTestId('image-viewer-zoom')[0].props.maximumZoomScale).toBeGreaterThan(1);
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  expect(screen.queryByTestId('image-viewer-pages')).toBeNull();
});

test('아이폰 카드 입력은 기존 키보드 padding 회피를 상속한다', async () => {
  const screen = await content();
  expect(screen.UNSAFE_getByType(require('../../AppKeyboardAvoidingView').AppKeyboardAvoidingView).props.behavior)
    .toBe(Platform.OS === 'ios' ? 'padding' : undefined);
});
test('커멘트의 마크다운 첨부는 공용 썸네일과 파일 링크로 열린다', async () => {
  const screen = await content({ getCard: jest.fn().mockResolvedValue({ ...detail, reports: [], comments: [{
    id: 'c', cardId: card.id, body: '본문\n![사진](https://test/photo.png)\n[자료](https://test/file.pdf)',
    createdAt: '', authorKind: 'user', kind: 'comment', sessionId: null,
  }] }) });
  expect(screen.queryByText(/!\[사진\]/)).toBeNull();
  fireEvent.press(screen.getByLabelText('사진'));
  expect(screen.getByTestId('image-viewer-pages')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('이미지 닫기'));
  const browser = jest.spyOn(require('expo-web-browser'), 'openBrowserAsync').mockResolvedValue({});
  fireEvent.press(screen.getByLabelText('자료'));
  expect(browser).toHaveBeenCalledWith('https://test/file.pdf');
});
