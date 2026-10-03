jest.mock('expo-crypto', () => { let serial = 0; return { randomUUID: jest.fn(() => `draft-id-${++serial}`) }; });
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));
jest.mock('expo-image-picker', () => ({ requestMediaLibraryPermissionsAsync: jest.fn(), launchImageLibraryAsync: jest.fn() }));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
import React from 'react';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, Modal, ScrollView } from 'react-native';
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
  expect(screen.getByText('카드를 저장하지 못했습니다. 입력을 유지했습니다. 다시 저장해 주세요.')).toBeTruthy();
  expect(alert).not.toHaveBeenCalled();
  expect(screen.getByLabelText('요청 원문').props.editable).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('요청 원문').props.value).toBe(request);
  expect(screen.getByLabelText('카드 제목').props.value).toBe('제목');
  expect(screen.getByText('원본 사진.png')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(api.createCard).toHaveBeenLastCalledWith({ folderId: 'folder-1', title: '제목', request, queue: false,
    nodeId: 'node-2', assignee: { kind: 'agent', agentId: 'other' }, modelPreset: 'luna',
    attachments: [{ nodeId: 'node-2', path: '/tmp/upload.png', name: '원본 사진.png', mimeType: 'image/png' }], idempotencyKey: expect.any(String) });
  expect(api.createCard.mock.calls[1][0]).toEqual(api.createCard.mock.calls[0][0]);
  expect(close).toHaveBeenCalledTimes(1);
});


test('폴더 범위와 드래프트 목적을 밝히고 필수 요청 옆에 첨부를 둔다', async () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
  };
  const screen = render(<CardCreateSheet api={api as any} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Sol')).toBeTruthy());
  expect(screen.getByText('드래프트 저장')).toBeTruthy();
  expect(screen.getByLabelText('카드 폴더 선택')).toBeTruthy();
  expect(screen.getAllByText('필수')).toHaveLength(2);
  expect(within(screen.getByTestId('card-create-request-section')).getByLabelText('첨부 추가')).toBeTruthy();
  expect(screen.getByLabelText('카드 저장')).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('카드 제목'), '제목만 있는 카드');
  expect(screen.getByLabelText('카드 저장')).toBeDisabled();
  fireEvent.changeText(screen.getByLabelText('요청 원문'), '수행할 요청');
  await waitFor(() => expect(screen.getByLabelText('카드 저장')).toBeEnabled());
  const sections = screen.UNSAFE_getByType(ScrollView).props.children.filter(Boolean)
    .map((child: any) => child.props.testID);
  expect(sections.indexOf('card-create-request-section')).toBeLessThan(sections.indexOf('card-create-execution-group'));
});

test('요약된 실행 대상에서도 사용할 수 없는 모델의 사유는 숨기지 않는다', async () => {
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: false }] }),
  };
  const screen = render(<CardCreateSheet api={api as any} onClose={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('선택한 모델을 이 노드에서 사용할 수 없습니다. 모델을 다시 선택해 주세요.')).toBeTruthy());
  expect(screen.getByLabelText('실행 대상 선택')).toBeEnabled();
  expect(screen.getByLabelText('카드 저장')).toBeDisabled();
});


test('카드 생성 대기 중 연속 저장과 사용자 닫기를 막고 성공하면 한 번 닫는다', async () => {
  const card = cardFixture();
  let resolveCreate!: (value: { card: typeof card }) => void;
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
    createCard: jest.fn(() => new Promise<{ card: typeof card }>(resolve => { resolveCreate = resolve; })),
    getCard: jest.fn().mockResolvedValue({ card, reports: [], questions: [], sessions: [] }),
  };
  const close = jest.fn();
  const screen = render(<CardCreateSheet api={api as any} onClose={close} />);
  fireEvent.changeText(screen.getByLabelText('카드 제목'), '대기 중인 카드');
  fireEvent.changeText(screen.getByLabelText('요청 원문'), '요청을 보존합니다');
  await waitFor(() => expect(screen.getByLabelText('카드 저장')).toBeEnabled());
  const nativeClose = screen.UNSAFE_getByType(Modal).props.onRequestClose;
  act(() => {
    fireEvent.press(screen.getByLabelText('카드 저장'));
    fireEvent.press(screen.getByLabelText('카드 저장'));
    nativeClose();
  });
  expect(api.createCard).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('카드 작성 취소')).toBeDisabled();
  act(() => {
    fireEvent.press(screen.getByLabelText('카드 작성 취소'));
    screen.UNSAFE_getByType(Modal).props.onRequestClose();
  });
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByLabelText('요청 원문').props.value).toBe('요청을 보존합니다');
  await act(async () => { resolveCreate({ card }); });
  expect(api.createCard).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});

test('명시적 거절 후 같은 제출은 같은 키이고 입력을 고친 제출만 새 키를 쓴다', async () => {
  const { ApiHttpError } = require('../../../api/clientCore');
  const api = {
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'node-1' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', default_preset: 'sol' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [{ id: 'sol', label: 'Sol', available: true }] }),
    createCard: jest.fn().mockRejectedValue(new ApiHttpError('HTTP 422 password=synthetic-secret', 422, '')),
  };
  const screen = render(<CardCreateSheet api={api as any} onClose={jest.fn()} />);
  fireEvent.changeText(screen.getByLabelText('카드 제목'), '제목');
  fireEvent.changeText(screen.getByLabelText('요청 원문'), '첫 요청');
  await waitFor(() => expect(screen.getByText('Sol')).toBeTruthy());
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-secret');
  fireEvent.press(screen.getByLabelText('기술 상세'));
  expect(JSON.stringify(screen.toJSON())).not.toContain('synthetic-secret');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(api.createCard.mock.calls[1][0]).toEqual(api.createCard.mock.calls[0][0]);
  fireEvent.changeText(screen.getByLabelText('요청 원문'), '고친 요청');
  await act(async () => fireEvent.press(screen.getByLabelText('카드 저장')));
  expect(api.createCard.mock.calls[2][0].idempotencyKey).not.toBe(api.createCard.mock.calls[0][0].idempotencyKey);
  expect(api.createCard.mock.calls[2][0].request).toBe('고친 요청');
});
