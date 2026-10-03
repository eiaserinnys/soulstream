import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS } from 'react-native';
import type { ApiClient } from '../../../api/client';
import type { Folder } from '../../../api/types';
import type { PlannerFolder } from '../../../api/plannerTypes';

let mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockDimensions,
}));

let mockPageDetailResult = {
  data: { blocks: [] },
  loading: false,
  error: null,
} as any;
const mockUsePlannerPageDetail = jest.fn(() => mockPageDetailResult);
const mockCreateFolderSession = jest.fn();
const mockPickAttachment = jest.fn();
const mockRemoveAttachment = jest.fn();
const mockClearAttachments = jest.fn();
let mockAttachments: Array<{ path: string; name: string }> = [];
let mockUploading = false;
let mockModelPresetSelectionInvalid = false;
const mockUseChatAttachments = jest.fn((_input?: unknown) => ({
  attachments: mockAttachments,
  uploading: mockUploading,
  attachmentsReady: !mockUploading && mockAttachments.every(file => Boolean(file.path)),
  pickAttachment: mockPickAttachment,
  uploadAttachment: jest.fn(),
  removeAttachment: mockRemoveAttachment,
  clearAttachments: mockClearAttachments,
}));
const mockUseNewSessionSelection = jest.fn((_input?: unknown) => ({
  selectedFolderId: null,
  setSelectedFolderId: jest.fn(),
  selectedNodeId: 'node-a',
  setSelectedNodeId: jest.fn(),
  nodes: [{ nodeId: 'node-a' }],
  agents: [{ id: 'agent-a', name: 'Agent A' }],
  agentId: 'agent-a',
  setAgentId: jest.fn(),
  modelPresets: [],
  selectedModelPresetId: null,
  setSelectedModelPresetId: jest.fn(),
  effectiveModelPresetId: null,
  selectedModelPresetName: '자동 선택',
  selectedModelPresetUsageWarning: false,
  modelPresetSelectionInvalid: mockModelPresetSelectionInvalid,
  effectiveNodeId: 'node-a',
  sortedFolders: [],
  selectedFolderName: '폴더 미지정',
  selectedAgentName: 'Agent A',
  selectedNodeName: 'node-a',
}));

jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerPageDetail: () => mockUsePlannerPageDetail(),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({ createFolderSession: mockCreateFolderSession }),
}));
jest.mock('../../../hooks/useChatAttachments', () => ({
  useChatAttachments: (input: unknown) => mockUseChatAttachments(input),
}));
jest.mock('../../sheets/useNewSessionSelection', () => ({
  useNewSessionSelection: (input: unknown) => mockUseNewSessionSelection(input),
}));

import { NewFolderSheet } from '../NewFolderSheet';
import { SessionSuccessionSheet } from '../SessionSuccessionSheet';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';

const folders: Folder[] = [{
  id: 'project-folder',
  name: '프로젝트',
  sortOrder: 0,
  projectPageId: 'project-page',
}];

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockDimensions = { width: 390, height: 844, scale: 3, fontScale: 1 };
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  mockPageDetailResult = { data: { blocks: [] }, loading: false, error: null };
  mockAttachments = [];
  mockUploading = false;
  mockModelPresetSelectionInvalid = false;
});

test.each([
  ['phone/fontScale1', { width: 390, height: 844, scale: 3, fontScale: 1 }, 44, 52],
  ['iPad/fontScale2', { width: 1024, height: 1366, scale: 2, fontScale: 2 }, 48, 60],
] as const)('N5 sheets keep %s safe-area, keyboard, 20pt inset and semantic controls', (
  _label,
  dimensions,
  hitTarget,
  headerMinHeight,
) => {
  mockDimensions = dimensions;
  const newFolder = render(<NewFolderSheet
    visible
    api={null}
    folders={folders}
    dailyDate="2026-07-18"
    onClose={jest.fn()}
    onSubmit={jest.fn().mockResolvedValue(undefined)}
  />);
  expect(newFolder.getByTestId('new-task-safe-area')).toBeTruthy();
  expect(newFolder.getByTestId('new-task-keyboard')).toBeTruthy();
  expect(style(newFolder.getByTestId('new-task-header').props.style))
    .toMatchObject({ minHeight: headerMinHeight });
  expect(style(newFolder.getByTestId('new-task-header').props.style)).not.toHaveProperty('height');
  expect(newFolder.getByTestId('new-task-header-title').props.allowFontScaling).not.toBe(false);
  expect(style(newFolder.getByTestId('new-task-content').props.contentContainerStyle))
    .toMatchObject({ paddingHorizontal: 20 });
  expect(style(newFolder.getByTestId('new-task-project-selection').props.style))
    .toMatchObject({ minHeight: 52 });
  expect(style(newFolder.getByTestId('new-task-today-row').props.style))
    .toMatchObject({ minHeight: hitTarget });
  expect(style(newFolder.getByTestId('new-task-project-selection').props.style))
    .not.toHaveProperty('height');
  expect(newFolder.UNSAFE_getByType(require('react-native').Modal).props.supportedOrientations)
    .toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
  newFolder.unmount();

  const succession = render(<SessionSuccessionSheet
    api={null}
    folder={folder('running')}
    predecessorSessionId="session-1"
    visible
    onClose={jest.fn()}
    onCreated={jest.fn()}
  />);
  expect(succession.getByTestId('succession-safe-area')).toBeTruthy();
  expect(succession.getByTestId('succession-keyboard')).toBeTruthy();
  expect(style(succession.getByTestId('succession-header').props.style))
    .toMatchObject({ minHeight: headerMinHeight });
  expect(style(succession.getByTestId('succession-header').props.style)).not.toHaveProperty('height');
  expect(succession.getByTestId('succession-header-title').props.allowFontScaling).not.toBe(false);
  expect(style(succession.getByTestId('succession-content').props.contentContainerStyle))
    .toMatchObject({ paddingHorizontal: 20 });
  fireEvent.press(succession.getByTestId('succession-execution-disclosure'));
  expect(style(succession.getByTestId('succession-selection-node').props.style))
    .toMatchObject({ minHeight: 52 });
  expect(style(succession.getByTestId('succession-check-task-context').props.style))
    .toMatchObject({ minHeight: hitTarget });
  expect(style(succession.getByTestId('succession-selection-node').props.style))
    .not.toHaveProperty('height');
  expect(succession.getByTestId('succession-selection-group')).toBeTruthy();
  expect(succession.getByTestId('succession-context-group')).toBeTruthy();
  expect(succession.queryByTestId('succession-guidance-group')).toBeNull();
  expect(succession.getByTestId('succession-initial-instruction-group')).toBeTruthy();
  expect(succession.getByTestId('succession-attachment-button')).toBeTruthy();
  expect(succession.getByTestId('succession-content').props.keyboardDismissMode)
    .toBe('interactive');
  expect(
    succession.getByPlaceholderText('세션을 시작하자마자 수행할 지시…').props.allowFontScaling,
  ).not.toBe(false);
  expect(succession.UNSAFE_getByType(require('react-native').Modal).props.supportedOrientations)
    .toEqual(['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']);
});

test('새 폴더 시트는 열린 중 catalog identity가 바뀌어도 입력을 보존한다', () => {
  const props = {
    visible: true,
    api: null,
    folders,
    dailyDate: '2026-07-18',
    onClose: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
  };
  const screen = render(<NewFolderSheet {...props} />);
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '지켜야 하는 제목');
  fireEvent.changeText(screen.getByPlaceholderText('목표와 완료 조건을 적어두세요.'), '지켜야 하는 설명');

  screen.rerender(<NewFolderSheet {...props} folders={[...folders]} />);

  expect(screen.getByPlaceholderText('폴더 이름').props.value).toBe('지켜야 하는 제목');
  expect(screen.getByPlaceholderText('목표와 완료 조건을 적어두세요.').props.value).toBe('지켜야 하는 설명');
});

test('새 폴더 시트는 오늘 마운트 선택을 그대로 제공한다', async () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const screen = render(<NewFolderSheet
    visible
    api={null}
    folders={folders}
    dailyDate="2026-07-18"
    defaultProjectPageId="project-page"
    onClose={jest.fn()}
    onSubmit={onSubmit}
  />);
  expect(screen.getByText('새 폴더')).toBeTruthy();
  expect(screen.getByTestId('new-task-today-row')).toBeTruthy();
  fireEvent.press(screen.getByTestId('new-task-today-row'));
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '자료실');
  await act(async () => { fireEvent.press(screen.getByText('만들기')); });
  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    title: '자료실', folderId: 'project-folder',
  }));
  expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('dailyDate');
});

test('새 폴더 시트는 직접 지침과 기본 에이전트를 생성 요청 하나에 담는다', async () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions')
    .mockImplementation((_options, callback) => callback(1));
  const screen = render(<NewFolderSheet
    visible
    api={null}
    folders={folders}
    dailyDate="2026-07-18"
    onClose={jest.fn()}
    onSubmit={onSubmit}
  />);

  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));
  fireEvent.changeText(
    screen.getByPlaceholderText('이 폴더에서만 사용할 지침을 적어두세요.'),
    '직접 지침',
  );
  fireEvent.press(screen.getByTestId('new-task-defaults-edit'));
  fireEvent.press(screen.getByTestId('new-task-default-agent'));
  fireEvent.press(screen.getByLabelText('기본 환경 확인'));
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '새 폴더');
  await act(async () => { fireEvent.press(screen.getByText('만들기')); });

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    initialContext: {
      guidance: '직접 지침',
      atomReferences: [],
      sessionDefaults: { agentId: 'agent-a', nodeId: 'node-a' },
    },
  }));
});

test('새 폴더 직접 지정에도 기본 모델 선택 행을 함께 표시한다', () => {
  const screen = render(<NewFolderSheet
    visible
    api={null}
    folders={folders}
    dailyDate="2026-07-18"
    onClose={jest.fn()}
    onSubmit={jest.fn().mockResolvedValue(undefined)}
  />);

  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));

  fireEvent.press(screen.getByTestId('new-task-defaults-edit'));
  expect(screen.getByTestId('new-task-default-node')).toBeTruthy();
  expect(screen.getByTestId('new-task-default-agent')).toBeTruthy();
  expect(screen.getByTestId('new-task-default-model')).toBeTruthy();
});

test('유효하지 않은 preset 경고는 가용성이 회복되면 단방향 래치 없이 해제된다', async () => {
  const props = {
    visible: true,
    api: null,
    folders,
    dailyDate: '2026-07-18',
    onClose: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
  };
  const screen = render(<NewFolderSheet {...props} />);
  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));

  fireEvent.press(screen.getByTestId('new-task-defaults-edit'));
  mockModelPresetSelectionInvalid = true;
  screen.rerender(<NewFolderSheet {...props} />);
  await waitFor(() => expect(screen.getByText(
    '기본 담당은 노드와 에이전트를 모두 선택하고 사용 가능한 모델을 지정해야 합니다.',
  )).toBeTruthy());

  mockModelPresetSelectionInvalid = false;
  screen.rerender(<NewFolderSheet {...props} />);
  await waitFor(() => expect(screen.queryByText(
    '기본 담당은 노드와 에이전트를 모두 선택하고 사용 가능한 모델을 지정해야 합니다.',
  )).toBeNull());
  expect(screen.queryByText('기본 담당 선택을 마쳐야 합니다.')).toBeNull();
});

test('기본 환경을 취소하면 폴더 작성 내용과 상속 설정을 보존한다', async () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const screen = render(<NewFolderSheet visible api={null} folders={folders} dailyDate="2026-07-18" onClose={jest.fn()} onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '상속 유지');
  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));
  fireEvent.press(screen.getByTestId('new-task-defaults-edit'));
  fireEvent.press(screen.getByLabelText('기본 환경 취소'));
  expect(screen.getByPlaceholderText('폴더 이름').props.value).toBe('상속 유지');
  await act(async () => fireEvent.press(screen.getByTestId('new-task-submit')));
  expect(onSubmit.mock.calls[0][0].initialContext.sessionDefaults).toBeUndefined();
});

test('새 폴더 시트는 같은 Atom 선택 화면에서 정한 옵션을 생성 요청에 담는다', async () => {
  const onSubmit = jest.fn().mockResolvedValue(undefined);
  const api = {
    listAtomRootNodes: jest.fn().mockResolvedValue({
      children: [{ id: 'atom-node', card: { title: '규칙' } }],
    }),
    listAtomNodeChildren: jest.fn(),
  } as unknown as ApiClient;
  const screen = render(<NewFolderSheet
    visible
    api={api}
    folders={folders}
    dailyDate="2026-07-18"
    onClose={jest.fn()}
    onSubmit={onSubmit}
  />);

  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));
  fireEvent.press(screen.getByTestId('new-task-add-atom'));
  await act(async () => { await Promise.resolve(); });
  fireEvent.press(screen.getByTestId('atom-picker-select-atom-node'));
  fireEvent.press(screen.getByTestId('atom-picker-depth-4'));
  fireEvent(screen.getByTestId('atom-picker-titles-only'), 'valueChange', true);
  fireEvent.press(screen.getByTestId('atom-picker-add-selected'));
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), 'Atom 폴더');
  await act(async () => { fireEvent.press(screen.getByText('만들기')); });

  expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    initialContext: expect.objectContaining({
      atomReferences: [{
        instance: 'atom', nodeId: 'atom-node', nodeTitle: '규칙', depth: 4, titlesOnly: true,
      }],
    }),
  }));
});

test('새 업무 시트는 auth scope 전환 즉시 이전 draft와 프로젝트 컨텍스트 미리보기를 버린다', async () => {
  mockPageDetailResult = {
    data: {
      blocks: [plannerBlock(
        'old-guidance', 'guidance', '이전 계정 프로젝트 지침', { enabled: true },
      )],
    },
    loading: false,
    error: null,
  };
  const props = {
    visible: true,
    api: null,
    folders,
    dailyDate: '2026-07-18',
    onClose: jest.fn(),
    onSubmit: jest.fn().mockResolvedValue(undefined),
  };
  const screen = render(<NewFolderSheet {...props} />);
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), 'A 계정 draft');
  fireEvent.changeText(screen.getByPlaceholderText('목표와 완료 조건을 적어두세요.'), 'A 계정 설명');
  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));
  fireEvent.changeText(
    screen.getByPlaceholderText('이 폴더에서만 사용할 지침을 적어두세요.'),
    'A 계정 직접 지침',
  );
  expect(screen.getByText('이전 계정 프로젝트 지침')).toBeTruthy();

  mockPageDetailResult = { data: undefined, loading: true, error: null };
  await act(async () => {
    useAuthStore.getState().setJwt('scope-b');
    await Promise.resolve();
  });

  expect(screen.getByPlaceholderText('폴더 이름').props.value).toBe('');
  expect(screen.getByPlaceholderText('목표와 완료 조건을 적어두세요.').props.value).toBe('');
  fireEvent.press(screen.getByTestId('new-task-direct-context-toggle'));
  expect(screen.getByPlaceholderText('이 폴더에서만 사용할 지침을 적어두세요.').props.value).toBe('');
  expect(screen.queryByText('이전 계정 프로젝트 지침')).toBeNull();
});

test('승계 시트는 열린 중 세션 status가 갱신돼도 초기 지시를 보존한다', () => {
  const props = {
    api: null,
    folder: folder('running'),
    predecessorSessionId: 'session-1',
    visible: true,
    onClose: jest.fn(),
    onCreated: jest.fn(),
  };
  const screen = render(<SessionSuccessionSheet {...props} />);
  fireEvent.changeText(screen.getByPlaceholderText('세션을 시작하자마자 수행할 지시…'), '지켜야 하는 초기 지시');

  screen.rerender(<SessionSuccessionSheet {...props} folder={folder('completed')} />);

  expect(screen.queryByPlaceholderText('이 세션에만 적용할 지침…')).toBeNull();
  expect(screen.getByPlaceholderText('세션을 시작하자마자 수행할 지시…').props.value).toBe('지켜야 하는 초기 지시');
});

test('모델 목록 요청이 끝나지 않아도 유효성 오류가 없으면 세션 시작을 막지 않는다', async () => {
  mockCreateFolderSession.mockResolvedValue({ agentSessionId: 'session-new' });
  const screen = render(<SessionSuccessionSheet
    api={null}
    folder={folder('running')}
    predecessorSessionId={null}
    visible
    onClose={jest.fn()}
    onCreated={jest.fn()}
  />);

  await act(async () => {
    fireEvent.press(screen.getByLabelText('세션 시작'));
  });

  expect(mockCreateFolderSession).toHaveBeenCalledTimes(1);
});

test('승계 시트는 기존 첨부 UI로 고른 경로를 첫 세션 생성 요청에 전달한다', async () => {
  mockAttachments = [{ path: '/uploads/image-a.png', name: 'image-a.png' }];
  mockCreateFolderSession.mockResolvedValue({ agentSessionId: 'session-new' });
  const onClose = jest.fn();
  const onCreated = jest.fn();
  const screen = render(<SessionSuccessionSheet
    api={null}
    folder={folder('running')}
    predecessorSessionId={null}
    visible
    onClose={onClose}
    onCreated={onCreated}
  />);

  expect(mockUseChatAttachments).toHaveBeenCalledWith(expect.objectContaining({
    api: null,
    nodeId: 'node-a',
    sessionId: expect.stringMatching(/^soul-app-v3-pending-attachment-/),
  }));
  fireEvent.press(screen.getByTestId('succession-attachment-button'));
  expect(mockPickAttachment).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByTestId('chat-attachment-remove-0'));
  expect(mockRemoveAttachment).toHaveBeenCalledWith(0);

  fireEvent.changeText(
    screen.getByPlaceholderText('세션을 시작하자마자 수행할 지시…'),
    '이미지를 보고 시작해',
  );
  await act(async () => { fireEvent.press(screen.getByLabelText('세션 시작')); });

  expect(mockCreateFolderSession).toHaveBeenCalledWith(expect.objectContaining({
    prompt: expect.stringContaining('이미지를 보고 시작해'),
    attachmentPaths: ['/uploads/image-a.png'],
  }));
  expect(onCreated).toHaveBeenCalledWith('session-new');
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('승계 시트는 업무 기본 담당을 프로젝트와 이전 세션보다 먼저 선택한다', () => {
  mockPageDetailResult = {
    data: { blocks: [plannerBlock('project-defaults', 'session_defaults', '', {
      agentId: 'project-agent', nodeId: 'project-node',
    })] },
    loading: false,
    error: null,
  };
  const directFolder = folder('running');
  directFolder.blocks = [plannerBlock('task-defaults', 'session_defaults', '', {
    agentId: 'task-agent', nodeId: 'task-node',
  })];

  render(<SessionSuccessionSheet
    api={null}
    folder={directFolder}
    predecessorSessionId="session-1"
    visible
    onClose={jest.fn()}
    onCreated={jest.fn()}
  />);

  expect(mockUseNewSessionSelection).toHaveBeenLastCalledWith(expect.objectContaining({
    defaultAgentId: 'task-agent',
    defaultNodeId: 'task-node',
  }));
});

test('승계 시트는 내부 context source와 중복 일반명을 숨기고 의미 있는 항목만 한 번 표시한다', () => {
  const directFolder = folder('running');
  directFolder.blocks = [
    plannerBlock('guidance', 'guidance', '검수 원칙', { enabled: true }),
    plannerBlock('guidance-copy', 'guidance', ' 검수 원칙 ', { enabled: true }),
    plannerBlock('runbook', 'runbook_ref', '', { runbookId: 'runbook-1' }),
    plannerBlock('session-a', 'session_ref', '', { sessionId: 'session-a' }),
    plannerBlock('session-b', 'session_ref', '', { sessionId: 'session-b' }),
    plannerBlock('future', 'future_context_source', '컨텍스트'),
  ];

  const screen = render(<SessionSuccessionSheet
    api={null}
    folder={directFolder}
    predecessorSessionId={null}
    visible
    onClose={jest.fn()}
    onCreated={jest.fn()}
  />);

  expect(screen.getAllByText(/검수 원칙/)).toHaveLength(1);
  expect(screen.getAllByText(/^함께 가져갈 컨텍스트$/)).toHaveLength(1);
  expect(screen.queryByText(/runbook-1|session-a|session-b/)).toBeNull();
});

function folder(status: string): PlannerFolder {
  return {
    page: {
      id: 'task-1', title: '업무', dailyDate: null, version: 1, archived: false,
      metadata: {}, createdAt: '', updatedAt: '',
    },
    blocks: [],
    folderId: 'task-1',
    folderSummary: null,
    status: 'open',
    assignee: '',
    contextCount: 0,
    progress: null,
    projectPageId: 'project-page',
    sessions: [{
      agentSessionId: 'session-1', folderId: null, displayName: '이전 세션',
      nodeId: 'node-a', sessionType: null, status, agentId: 'agent-a',
      predecessorSessionId: null, reviewState: 'not_required', createdAt: '', updatedAt: '',
    }],
    sessionIds: ['session-1'],

  };
}

function plannerBlock(
  id: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
) {
  return {
    id,
    pageId: 'project-page',
    parentId: null,
    positionKey: id,
    blockType,
    text,
    properties,
    collapsed: false,
  };
}

function style(value: unknown) {
  return require('react-native').StyleSheet.flatten(value) as Record<string, unknown>;
}

test('폴더 제출 snapshot은 실패 후 동일 키로 재시도하고 pending 닫기와 중복 제출을 막는다', async () => {
  let reject!: (cause: Error) => void;
  const onSubmit = jest.fn().mockImplementationOnce(() => new Promise((_, no) => { reject = no; })).mockResolvedValue(undefined);
  const onClose = jest.fn();
  const screen = render(<NewFolderSheet visible api={null} folders={folders} dailyDate="2026-07-18" onClose={onClose} onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '한 번만');
  await waitFor(() => expect(screen.getByTestId('new-task-submit')).toBeEnabled());
  const { Modal } = require('react-native');
  act(() => { fireEvent.press(screen.getByTestId('new-task-submit')); fireEvent.press(screen.getByTestId('new-task-submit')); screen.UNSAFE_getByType(Modal).props.onRequestClose(); });
  expect(onSubmit).toHaveBeenCalledTimes(1); expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('폴더 이름').props.editable).toBe(false);
  await act(async () => reject(new Error('결과 불확실')));
  await act(async () => fireEvent.press(screen.getByTestId('new-task-submit')));
  expect(onSubmit.mock.calls[1][0]).toEqual(onSubmit.mock.calls[0][0]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('명시적 거절 뒤 생성 성공과 오늘 반영 실패가 오면 생성 결과를 보존한다', async () => {
  const { ApiHttpError } = require('../../../api/clientCore');
  const onSubmit = jest.fn()
    .mockRejectedValueOnce(new ApiHttpError('HTTP 422', 422, ''))
    .mockImplementationOnce(async (input) => {
      input.creation.result = { folderId: 'created-folder' };
      throw new Error('오늘 반영 응답 불확실');
    })
    .mockResolvedValueOnce(undefined);
  const onClose = jest.fn();
  const screen = render(<NewFolderSheet visible api={null} folders={folders} dailyDate="2026-07-18" onClose={onClose} onSubmit={onSubmit} />);
  fireEvent.changeText(screen.getByPlaceholderText('폴더 이름'), '생성된 폴더');
  await waitFor(() => expect(screen.getByTestId('new-task-submit')).toBeEnabled());
  await act(async () => fireEvent.press(screen.getByTestId('new-task-submit')));
  expect(screen.getByPlaceholderText('폴더 이름').props.editable).toBe(true);
  await act(async () => fireEvent.press(screen.getByTestId('new-task-submit')));
  expect(screen.getByPlaceholderText('폴더 이름').props.editable).toBe(false);
  await act(async () => fireEvent.press(screen.getByTestId('new-task-submit')));
  expect(onSubmit.mock.calls[2][0].creation).toBe(onSubmit.mock.calls[1][0].creation);
  expect(onSubmit.mock.calls[2][0].creation.result).toEqual({ folderId: 'created-folder' });
  expect(onClose).toHaveBeenCalledTimes(1);
});
