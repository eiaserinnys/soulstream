jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'draft-upload-id') }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import { ActionSheetIOS, Alert } from 'react-native';
import { cardFixture } from '../../../test-support/cards';
import { useSettingsStore } from '../../../store/settingsStore';
import { useCardStore } from '../../../store/cardStore';
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('../../sheets/useNewSessionSelection', () => ({ useNewSessionSelection: () => ({ selectedAgentName: '로젤린', selectedModelPresetName: 'Sol 6.1', agents: [] }) }));
jest.mock('../CardAssignmentSheet', () => ({ CardAssignmentSheet: () => null }));
import { CardComposer } from '../CardComposer';
import { ChatComposer } from '../../chat/ChatComposer';

beforeEach(() => {
  useCardStore.setState({ rows: {}, details: {} });
  useSettingsStore.setState({ serverUrl: 'https://cards.test', cardAssignments: {
    'https://cards.test': { folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' },
  } });
});
afterEach(() => jest.restoreAllMocks());

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

test('오늘 입력창은 채팅과 같은 한 줄 시작과 글자 크기이며 칩만 줄바꿈한다', () => {
  const { StyleSheet } = require('react-native');
  const screen = render(<CardComposer api={null} today />);
  const input = screen.getByLabelText('세션 첫 메시지');
  expect(input.props.placeholder).toBe('무엇을 시작할까요');
  expect(input.props.multiline).toBe(true);
  expect(input.props.textAlignVertical).toBe('center');
  expect(StyleSheet.flatten(input.props.style).height).toBeUndefined();
  fireEvent(input, 'contentSizeChange', { nativeEvent: { contentSize: { height: 48 } } });
  fireEvent(input, 'contentSizeChange', { nativeEvent: { contentSize: { height: 120 } } });
  expect(screen.getByLabelText('세션 첫 메시지').props.textAlignVertical).toBe('top');
  expect(StyleSheet.flatten(screen.getByTestId('card-composer-chips').props.style)).toMatchObject({ flex: 1, flexWrap: 'wrap' });
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


test.each([false, true])('today=%s 입력은 ChatComposer를 쓰고 리턴은 줄바꿈이며 버튼으로만 전송한다', async (today) => {
  const api = { getCard: jest.fn().mockResolvedValue({ card: cardFixture(), reports: [], questions: [], sessions: [] }), createCard: jest.fn().mockResolvedValue({ card: cardFixture() }), createSession: jest.fn().mockResolvedValue({ agentSessionId: 'new' }) };
  const screen = render(<CardComposer today={today} api={api as any} />);
  expect(screen.UNSAFE_getByType(ChatComposer)).toBeTruthy();
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
  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(api.uploadAttachment).toHaveBeenCalledWith('draft-upload-id', 'node-1', expect.objectContaining({ name: '사진.png' }));
  expect(screen.getByText('사진.png')).toBeTruthy();
  fireEvent.changeText(screen.getByLabelText('맡길 일'), '첨부를 봐주세요');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 맡기기')));
  expect(api.createCard).toHaveBeenCalledWith(expect.objectContaining({ title: '첨부를 봐주세요', request: '첨부를 봐주세요', queue: true,
    attachments: [{ nodeId: 'node-1', path: '/tmp/사진.png', name: '사진.png', mimeType: 'image/png' }] }));
  expect(screen.queryByText('사진.png')).toBeNull();
});
