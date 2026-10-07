jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'draft-upload-id') }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { ActionSheetIOS, Alert, StyleSheet } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useCardStore } from '../../../store/cardStore';
import { useDraftStore } from '../../../store/draftStore';
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../sheets/useNewSessionSelection', () => ({ useNewSessionSelection: () => ({ selectedAgentName: '로젤린', selectedModelPresetName: 'Sol 6.1', agents: [] }) }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
import { CardComposer } from '../CardComposer';
import { ChatComposer } from '../../chat/ChatComposer';

beforeEach(() => {
  useCardStore.setState({ rows: {}, details: {} });
  useAuthStore.setState({ jwt: null });
  useDraftStore.setState({ drafts: {} });
  useSettingsStore.setState({ serverUrl: 'https://cards.test', cardAssignments: {
    'https://cards.test': { folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' },
  } });
});
afterEach(() => jest.restoreAllMocks());

async function seedPersistentDraft(role: string, target: string[], value: string) {
  await Promise.all([
    useAuthStore.persist.rehydrate(),
    useSettingsStore.persist.rehydrate(),
    useDraftStore.persist.rehydrate(),
  ]);
  const token = Buffer.from(JSON.stringify({ email: 'composer@example.com', exp: 9999999999 })).toString('base64url');
  useAuthStore.setState({ jwt: ['header', token, 'signature'].join('.') });
  useSettingsStore.setState({ serverUrl: 'https://cards.test' });
  const key = JSON.stringify(['https://cards.test', 'composer@example.com', role, target]);
  useDraftStore.setState({ drafts: { [key]: value } });
  return key;
}

test('마지막 조합으로 원문을 보존해 대기열에 맡기고 저장 후 입력을 비운다', async () => {
  const card = cardFixture({ status: 'queued' });
  const api = { createCard: jest.fn().mockResolvedValue({ card, folderId: card.folderId }), getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }) };
  const screen = render(<CardComposer api={api as any} />);
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '  한 줄 요청  ');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 맡기기')));
  expect(api.createCard).toHaveBeenCalledWith(expect.objectContaining({ title: '한 줄 요청', request: '  한 줄 요청  ',
    queue: true, folderId: 'folder-1', nodeId: 'node-1', modelPreset: 'sol', assignee: { kind: 'agent', agentId: 'roselin' } }));
  expect(screen.getByLabelText('맡길 일').props.value).toBe('');
});

test('저장 실패는 원문을 유지해 다시 보낼 수 있게 한다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const api = { createCard: jest.fn().mockRejectedValue(new Error('network')) };
  const screen = render(<CardComposer api={api as any} />);
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '남길 요청');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 맡기기')));
  expect(screen.getByLabelText('맡길 일').props.value).toBe('남길 요청');
  expect(Alert.alert).toHaveBeenCalledWith('카드 변경 실패', 'network');
});

test('메인 입력은 세션 응답을 기다리지 않고 초안을 비우고 실패하면 원문을 복원한다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const draftKey = await seedPersistentDraft('main-composer', [], '보낼 원문');
  let rejectRequest!: (cause: Error) => void;
  const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const api = { createSession: jest.fn(() => request) };
  const screen = render(<CardComposer today api={api as any} />);

  await act(async () => {
    fireEvent.press(screen.getByLabelText('세션 시작'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('');
  expect(useDraftStore.getState().drafts[draftKey]).toBeUndefined();

  await act(async () => {
    rejectRequest(new Error('network'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('보낼 원문');
  expect(useDraftStore.getState().drafts[draftKey]).toBe('보낼 원문');
  expect(Alert.alert).toHaveBeenCalledWith('세션 시작 실패', 'network');
});

test('폴더 입력은 카드 생성 응답을 기다리지 않고 초안을 비우고 실패하면 원문을 복원한다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const draftKey = await seedPersistentDraft('folder-compose', ['folder-1'], '맡길 원문');
  let rejectRequest!: (cause: Error) => void;
  const request = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const api = { createCard: jest.fn(() => request) };
  const screen = render(<CardComposer api={api as any} folderId="folder-1" />);
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '맡길 원문');

  await act(async () => {
    fireEvent.press(screen.getByLabelText('카드 맡기기'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('맡길 일').props.value).toBe('');
  expect(useDraftStore.getState().drafts[draftKey]).toBeUndefined();

  await act(async () => {
    rejectRequest(new Error('network'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('맡길 일').props.value).toBe('맡길 원문');
  expect(useDraftStore.getState().drafts[draftKey]).toBe('맡길 원문');
  expect(Alert.alert).toHaveBeenCalledWith('카드 변경 실패', 'network');
});

test('폴더와 담당 선택 시트를 여는 분기는 입력을 비우지 않는다', () => {
  useSettingsStore.setState({ serverUrl: 'https://cards.test', cardAssignments: {
    'https://cards.test': { folderId: 'folder-1', nodeId: 'node-1', agentId: null, modelPreset: null },
  } });
  const screen = render(<CardComposer api={{ createCard: jest.fn() } as any} />);
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '선택 뒤 보낼 원문');

  fireEvent.press(screen.getByLabelText('카드 맡기기'));

  expect(screen.getByLabelText('맡길 일').props.value).toBe('선택 뒤 보낼 원문');
});

test('오늘 입력창의 iOS 높이·칩 배치 계약과 콘텐츠 이벤트 수신 후 정렬 계산', () => {
  const { StyleSheet } = require('react-native');
  const screen = render(<CardComposer api={{} as any} today />);
  const input = screen.getByLabelText('세션 첫 메시지');
  expect(input.props.placeholder).toBe('무엇을 시작할까요');
  expect(input.props.multiline).toBe(true);
  expect(input.props.textAlignVertical).toBe('center');
  const initialHeight = StyleSheet.flatten(input.props.style).minHeight;
  expect(StyleSheet.flatten(input.props.style).height).toBe(initialHeight);
  expect(initialHeight).toBeGreaterThanOrEqual(48);
  fireEvent.changeText(input, '첫 줄\n둘째 줄');
  // This checks alignment after event receipt, not native event delivery or growth.
  fireEvent(screen.getByLabelText('세션 첫 메시지'), 'contentSizeChange', {
    nativeEvent: { contentSize: { width: 200, height: initialHeight * 2 } },
  });
  expect(StyleSheet.flatten(screen.getByLabelText('세션 첫 메시지').props.style).height).toBeUndefined();
  expect(screen.getByLabelText('세션 첫 메시지').props.textAlignVertical).toBe('top');
  expect(StyleSheet.flatten(screen.getByTestId('card-composer-chips').props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  const chips = screen.getByTestId('card-composer-chips');
  const frame = screen.getByTestId('card-composer-layout');
  expect(React.Children.toArray(frame.props.children)[0]).toEqual(expect.objectContaining({ props: expect.objectContaining({ testID: 'card-composer-chips' }) }));
  const layout = StyleSheet.flatten(frame.props.style);
  const chipFrame = StyleSheet.flatten(screen.getByTestId('card-folder-chip').props.style);
  const chipSurface = StyleSheet.flatten(screen.getByTestId('card-folder-chip-visual').props.style);
  const surfaceInset = (chipFrame.minHeight - chipSurface.height) / 2;
  expect(layout.paddingTop + surfaceInset).toBe(layout.paddingBottom);
  expect(layout.gap + surfaceInset).toBeLessThan(layout.paddingBottom);
  expect(StyleSheet.flatten(screen.getByTestId('chat-composer-row').props.style)).toMatchObject({ paddingTop: 0, paddingBottom: 0 });
  fireEvent.changeText(screen.getByLabelText('세션 첫 메시지'), '');
  expect(StyleSheet.flatten(screen.getByLabelText('세션 첫 메시지').props.style).minHeight).toBe(initialHeight);
  expect(screen.getByLabelText('세션 시작').props.accessibilityState.disabled).toBe(true);
});


test('오늘 첨부는 채팅 picker·upload 경로와 세션 생성의 attachment payload를 쓴다', async () => {
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.png', name: '사진.png', mimeType: 'image/png' }] } as any);
  const api = { uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/사진.png' }), createSession: jest.fn().mockResolvedValue({ agentSessionId: 'new' }) };
  const screen = render(<CardComposer today api={api as any} />);
  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(api.uploadAttachment).toHaveBeenCalledWith(expect.any(String), 'node-1', { uri: 'file://photo.png', name: '사진.png', type: 'image/png' });
  expect(screen.getByText('사진.png')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('사진.png 첨부 제거'));
  expect(screen.queryByText('사진.png')).toBeNull();
  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  fireEvent.changeText(screen.getByLabelText('세션 첫 메시지'), '  그림을 봐주세요  ');
  await act(async () => fireEvent.press(screen.getByLabelText('세션 시작')));
  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: '  그림을 봐주세요  \n\n[첨부 파일 로컬 경로: /tmp/사진.png]', attachmentPaths: ['/tmp/사진.png'] }));
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('');
  expect(screen.queryByText('사진.png')).toBeNull();
});

test('오늘 입력은 첨부와 함께 비우고 실패 시 복원해 첨부를 포함해 다시 보낸다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.png', name: '사진.png', mimeType: 'image/png' }] } as any);
  let rejectRequest!: (cause: Error) => void;
  const firstRequest = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const api = {
    uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/사진.png' }),
    createSession: jest.fn().mockImplementationOnce(() => firstRequest).mockResolvedValueOnce({ agentSessionId: 'retry' }),
  };
  const screen = render(<CardComposer today api={api as any} />);

  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(screen.getByText('사진.png')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('세션 첫 메시지'), '첨부를 확인해줘');

  await act(async () => {
    fireEvent.press(screen.getByLabelText('세션 시작'));
    await Promise.resolve();
  });
  const requestPayload = expect.objectContaining({
    prompt: '첨부를 확인해줘\n\n[첨부 파일 로컬 경로: /tmp/사진.png]',
    attachmentPaths: ['/tmp/사진.png'],
  });
  expect(api.createSession).toHaveBeenNthCalledWith(1, requestPayload);
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('');
  expect(screen.queryByText('사진.png')).toBeNull();

  await act(async () => {
    rejectRequest(new Error('network'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('첨부를 확인해줘');
  expect(screen.getByText('사진.png')).toBeTruthy();
  expect(Alert.alert).toHaveBeenCalledWith('세션 시작 실패', 'network');

  await act(async () => fireEvent.press(screen.getByLabelText('세션 시작')));
  expect(api.createSession).toHaveBeenNthCalledWith(2, requestPayload);
  expect(screen.getByLabelText('세션 첫 메시지').props.value).toBe('');
  expect(screen.queryByText('사진.png')).toBeNull();
});


test.each([false, true])('today=%s 입력은 ChatComposer를 쓰고 리턴은 줄바꿈이며 버튼으로만 전송한다', async (today) => {
  const api = { getCard: jest.fn().mockResolvedValue({ card: cardFixture(), reports: [], questions: [], sessions: [] }), createCard: jest.fn().mockResolvedValue({ card: cardFixture() }), createSession: jest.fn().mockResolvedValue({ agentSessionId: 'new' }) };
  const screen = render(<CardComposer today={today} api={api as any} />);
  expect(screen.UNSAFE_getByType(ChatComposer)).toBeTruthy();
  const contentRow = screen.getByTestId('chat-composer-content-row');
  expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  expect(React.Children.toArray(contentRow.props.children).map((child: any) => child.props.testID))
    .toEqual(['chat-composer-attach-slot', 'chat-composer-input-row', 'chat-composer-controls-row']);
  expect(screen.getByTestId('chat-composer-input-row').props.collapsable).toBe(false);
  expect(screen.getByTestId('chat-composer-controls-row').props.collapsable).toBe(false);
  const input = screen.getByTestId('chat-composer-text-input');
  expect(input.props.multiline).toBe(true);
  expect(input.props.onSubmitEditing).toBeUndefined();
  expect(input.props.returnKeyType).toBeUndefined();
  fireEvent.changeText(input, '첫 줄\n둘째 줄');
  expect(screen.getByTestId('chat-composer-text-input').props.value).toBe('첫 줄\n둘째 줄');
  expect(api.createCard).not.toHaveBeenCalled();
  expect(api.createSession).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('chat-composer-send-button')));
  expect(today ? api.createSession : api.createCard).toHaveBeenCalledWith(expect.objectContaining(today
    ? { prompt: '첫 줄\n둘째 줄' } : { title: '첫 줄', request: '첫 줄\n둘째 줄' }));
});

test('폴더 카드 입력은 원문과 구조화 첨부를 분리하고 성공 시 비운다', async () => {
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.png', name: '사진.png', mimeType: 'image/png' }] } as any);
  const api = { getCard: jest.fn().mockResolvedValue({ card: cardFixture(), reports: [], questions: [], sessions: [] }), uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/사진.png' }), createCard: jest.fn().mockResolvedValue({ card: cardFixture() }) };
  const screen = render(<CardComposer api={api as any} />);
  const contentRow = screen.getByTestId('chat-composer-content-row');
  expect(StyleSheet.flatten(contentRow.props.style)).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap' });
  expect(React.Children.toArray(contentRow.props.children).map((child: any) => child.props.testID))
    .toEqual(['chat-composer-attach-slot', 'chat-composer-input-row', 'chat-composer-controls-row']);
  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(api.uploadAttachment).toHaveBeenCalledWith('draft-upload-id', 'node-1', expect.objectContaining({ name: '사진.png' }));
  expect(screen.getByText('사진.png')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '첨부를 봐주세요');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 맡기기')));
  expect(api.createCard).toHaveBeenCalledWith(expect.objectContaining({ title: '첨부를 봐주세요', request: '첨부를 봐주세요', queue: true,
    attachments: [{ nodeId: 'node-1', path: '/tmp/사진.png', name: '사진.png', mimeType: 'image/png' }] }));
  expect(screen.queryByText('사진.png')).toBeNull();
});

test('폴더 입력은 첨부와 함께 비우고 실패 시 복원해 첨부를 포함해 다시 보낸다', async () => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.png', name: '사진.png', mimeType: 'image/png' }] } as any);
  let rejectRequest!: (cause: Error) => void;
  const firstRequest = new Promise((_resolve, reject) => { rejectRequest = reject; });
  const api = {
    getCard: jest.fn().mockResolvedValue({ card: cardFixture(), reports: [], questions: [], sessions: [] }),
    uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/사진.png' }),
    createCard: jest.fn().mockImplementationOnce(() => firstRequest).mockResolvedValueOnce({ card: cardFixture() }),
  };
  const screen = render(<CardComposer api={api as any} />);

  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(screen.getByText('사진.png')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '첨부를 확인해줘');

  await act(async () => {
    fireEvent.press(screen.getByLabelText('카드 맡기기'));
    await Promise.resolve();
  });
  const request = expect.objectContaining({ request: '첨부를 확인해줘', attachments: [
    { nodeId: 'node-1', path: '/tmp/사진.png', name: '사진.png', mimeType: 'image/png' },
  ] });
  expect(api.createCard).toHaveBeenNthCalledWith(1, request);
  expect(screen.getByLabelText('맡길 일').props.value).toBe('');
  expect(screen.queryByText('사진.png')).toBeNull();

  await act(async () => {
    rejectRequest(new Error('network'));
    await Promise.resolve();
  });
  expect(screen.getByLabelText('맡길 일').props.value).toBe('첨부를 확인해줘');
  expect(screen.getByText('사진.png')).toBeTruthy();
  expect(Alert.alert).toHaveBeenCalledWith('카드 변경 실패', 'network');

  await act(async () => fireEvent.press(screen.getByLabelText('카드 맡기기')));
  expect(api.createCard).toHaveBeenNthCalledWith(2, request);
  expect(screen.getByLabelText('맡길 일').props.value).toBe('');
  expect(screen.queryByText('사진.png')).toBeNull();
});
