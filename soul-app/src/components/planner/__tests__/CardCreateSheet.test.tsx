jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'draft-upload-id') }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, ScrollView } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { CardCreateSheet } from '../CardCreateSheet';
import { useSettingsStore } from '../../../store/settingsStore';
import { useSessionStore } from '../../../store/sessionStore';
import { cardFixture } from '../../../test-support/cards';

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ serverUrl: 'https://cards.test', nodeId: 'node-1', cardAssignments: {
    'https://cards.test': { folderId: 'folder-1', nodeId: 'node-1', agentId: 'roselin', modelPreset: 'sol' },
  } });
  useSessionStore.setState({ catalog: { sessions: {}, folders: [{ id: 'folder-1', name: '폴더' }] as any } });
});
afterEach(() => jest.restoreAllMocks());

test('실제 선택기와 첨부를 사용하며 실패 뒤 모든 입력을 보존하고 todo로 저장한다', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => { void callback(1); });
  jest.mocked(DocumentPicker.getDocumentAsync).mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.png', name: '원본 사진.png', mimeType: 'image/png' }] } as any);
  const card = cardFixture();
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }, { nodeId: 'node-2' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }, { id: 'other', name: '다른 에이전트', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }, { id: 'luna', label: 'Luna', available: true }] }),
    uploadAttachment: jest.fn().mockResolvedValue({ path: '/tmp/upload.png' }),
    createCard: jest.fn().mockRejectedValueOnce(new Error('저장 실패')).mockResolvedValue({ card }),
    getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
  };
  const close = jest.fn();
  const screen = render(<CardCreateSheet api={api as any} onClose={close} />);
  await waitFor(() => expect(screen.getByText('새 카드')).toBeTruthy());
  expect(screen.getByTestId('card-create-header')).toBeTruthy();
  const scroll = screen.UNSAFE_getByType(ScrollView);
  expect(scroll.props.keyboardDismissMode).toBe('interactive');
  fireEvent.changeText(screen.getByLabelText('카드 제목'), '제목');
  const request = '긴 요청 원문\n'.repeat(600);
  fireEvent.changeText(screen.getByLabelText('요청 원문'), request);
  fireEvent.press(screen.getByLabelText('실행 대상 선택'));
  await waitFor(() => expect(screen.getByLabelText('모델 Luna')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('노드 node-2'));
  await waitFor(() => expect(api.listModelPresets).toHaveBeenCalledWith('node-2'));
  fireEvent.press(screen.getByLabelText('에이전트 다른 에이전트'));
  fireEvent.press(screen.getByLabelText('모델 Luna'));
  fireEvent.press(screen.getByLabelText('실행 대상 확인'));
  await act(async () => fireEvent.press(screen.getByLabelText('첨부 추가')));
  expect(screen.getByTestId('card-request-image-0')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(alert).toHaveBeenCalledWith('카드 변경 실패', '저장 실패');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('요청 원문').props.value).toBe(request);
  expect(screen.getByLabelText('카드 제목').props.value).toBe('제목');
  expect(screen.getByText('원본 사진.png')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(api.createCard).toHaveBeenLastCalledWith({ folderId: 'folder-1', title: '제목', request, queue: false,
    nodeId: 'node-2', assignee: { kind: 'agent', agentId: 'other' }, modelPreset: 'luna',
    attachments: [{ nodeId: 'node-2', path: '/tmp/upload.png', name: '원본 사진.png', mimeType: 'image/png' }], idempotencyKey: expect.any(String) });
  expect(close).toHaveBeenCalledTimes(1);
});
