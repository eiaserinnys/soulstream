jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-document-picker', () => ({}));
const mockRenameFolder = jest.fn(async () => undefined);
const mockSaveFolderDescription = jest.fn(async () => undefined);
const mockSetFolderStarred = jest.fn(async () => undefined);
const mockSetFolderToday = jest.fn(async () => undefined);
let mockDeviceType: 'phone' | 'tabletPortrait' = 'tabletPortrait';

jest.mock('../../../theme', () => ({
  ...jest.requireActual('../../../theme'),
  useDeviceType: () => mockDeviceType,
}));
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => mockDeviceType,
  deviceTypeToBaseKey: (device: string) => device === 'phone' ? 'phone' : 'tablet',
}));
jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('react-native-webview', () => ({ WebView: () => null }));
jest.mock('react-native-enriched-markdown', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    EnrichedMarkdownText: ({ markdown, testID }: { markdown: string; testID?: string }) => (
      React.createElement(Text, { testID }, markdown)
    ),
  };
});
jest.mock('../../../hooks/usePlannerReads', () => ({
  ...jest.requireActual('../../../hooks/usePlannerReads'),
  usePlannerPageDetail: () => ({ data: { blocks: [] }, loading: false, error: null }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({
    renameFolder: mockRenameFolder,
    saveFolderDescription: mockSaveFolderDescription,
    setFolderStarred: mockSetFolderStarred,
    setFolderToday: mockSetFolderToday,
  }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openSessionMenu: jest.fn(),
    sessionSuccession: null,
    closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../FolderSessionHistory', () => ({ FolderSessionHistory: () => null }));
jest.mock('../SessionSuccessionSheet', () => ({ SessionSuccessionSheet: () => null }));
jest.mock('../SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));

import React from 'react';
import { Alert, PixelRatio, StyleSheet } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { PlannerFolder, PlannerToday } from '../../../api/plannerTypes';
import { usePlannerStore } from '../../../store/plannerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { FolderWorkspace } from '../FolderWorkspace';
import { plannerFolderTitleSaveCoordinator } from '../../../lib/planner-folder-title-save';
import { useAuthStore } from '../../../store/authStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { useUIStore } from '../../../store/uiStore';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import type { ApiClient } from '../../../api/client';

const plannerFolder = {
  page: {
    id: 'task-1',
    title: '실제 업무 제목',
    metadata: {},
    version: 1,
    dailyDate: null,
    archived: false,
    createdAt: '',
    updatedAt: '',
  },
  blocks: [],
  folderId: 'task-1',
  folderSummary: null,
  status: 'open',
  assignee: '담당 미지정',
  contextCount: 0,
  progress: null,
  projectPageId: null,
  sessions: [],
  sessionIds: [],

} as PlannerFolder;

const folder = {
  id: 'task-1', name: '실제 업무 제목', sortOrder: 0,
  parentFolderId: null, projectPageId: 'task-1', settings: {},
  status: 'open' as const, version: 1, archived: false,
};

const contextualFolder = {
  ...plannerFolder,
  blocks: [
    {
      id: 'context-guidance', pageId: 'task-1', parentId: null, positionKey: 'a',
      blockType: 'guidance', text: '규칙 A', properties: { enabled: true }, collapsed: false,
    },
    {
      id: 'context-atom', pageId: 'task-1', parentId: null, positionKey: 'b',
      blockType: 'atom_ref', text: '',
      properties: { instance: 'atom', nodeId: 'node-b', title: '원자 B' }, collapsed: false,
    },
  ],
  contextCount: 2,
} as PlannerFolder;

beforeEach(() => {
  jest.clearAllMocks();
  mockDeviceType = 'tabletPortrait';
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  mockRenameFolder.mockReset().mockResolvedValue(undefined);
  mockSaveFolderDescription.mockReset().mockResolvedValue(undefined);
  mockSetFolderStarred.mockReset().mockResolvedValue(undefined);
  mockSetFolderToday.mockReset().mockResolvedValue(undefined);
  plannerFolderTitleSaveCoordinator.reset();
  usePlannerStore.getState().resetForTest();
  usePlannerStore.getState().setSelectedFolderSnapshot(plannerFolder);
  useSessionStore.setState({ catalog: { folders: [folder], sessions: {} } });
  useUIStore.setState({ todayDate: '2026-07-17' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('iPad 업무 제목은 공통 shell header 리듬을 쓴다', () => {
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const header = StyleSheet.flatten(
    screen.getByTestId('task-workspace-tablet-header').props.style,
  );

  expect(header).toEqual(expect.objectContaining({
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 6,
    alignItems: 'center',
  }));
  expect(header.height).toBeUndefined();
});

test('phone 폴더 화면의 여섯 섹션은 같은 머리와 전경 텍스트 배치를 쓴다', () => {
  mockDeviceType = 'phone';
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const names = ['description', 'context', 'subfolders', 'cards', 'sessions'];
  const headers = names.map((name) => screen.getByTestId(`planner-section-header-${name}`));
  const disclosureHeaders = [
    screen.getByTestId('task-board-disclosure'),
  ];
  for (const header of [...headers, ...disclosureHeaders]) {
    expect(StyleSheet.flatten(header.props.style)).toMatchObject({ minHeight: 52, alignItems: 'center' });
  }
  expect(screen.queryByTestId('planner-section-header-documents')).toBeNull();
  const headerTitles = ['설명', '프로젝트 컨텍스트', '하위 폴더', '카드', '보드', '세션'];
  const titleStyles = headerTitles.map((title) => StyleSheet.flatten(screen.getByText(title).props.style));
  for (const style of titleStyles.slice(1)) {
    expect(style.fontSize).toBe(titleStyles[0].fontSize);
    expect(style.fontWeight).toBe(titleStyles[0].fontWeight);
  }
  const input = screen.getByTestId('folder-description-input');
  expect(StyleSheet.flatten(input.props.style).color).toBeTruthy();
  expect(StyleSheet.flatten(input.props.style).opacity).toBeUndefined();
  const glass = screen.getByTestId('folder-description-glass');
  const foreground = screen.getByTestId('folder-description-foreground');
  expect(StyleSheet.flatten(glass.props.style).position).toBe('absolute');
  expect(StyleSheet.flatten(foreground.props.style).zIndex).toBeGreaterThan(
    StyleSheet.flatten(glass.props.style).zIndex ?? 0,
  );
  expect(foreground.findAllByType(input.type).includes(input)).toBe(true);
  const labels = ['상태', '담당', '컨텍스트', '기본 담당'];
  const widths = labels.map((label) => StyleSheet.flatten(screen.getByText(label).props.style).width);
  expect(new Set(widths).size).toBe(1);
});

test('업무 기본 담당 편집은 노드·에이전트와 같은 표면에서 모델을 선택한다', () => {
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);

  fireEvent.press(screen.getByLabelText('기본 담당 수정'));

  expect(screen.getByText('노드')).toBeTruthy();
  expect(screen.getByText('에이전트')).toBeTruthy();
  expect(screen.getByText('모델')).toBeTruthy();
});

test('모델 목록 준비가 매달려도 기존 업무 기본 담당 저장 버튼은 활성 상태를 유지한다', () => {
  const assignedFolder = {
    ...plannerFolder,
    blocks: [{
      id: 'defaults',
      pageId: 'task-1',
      parentId: null,
      positionKey: 'a',
      blockType: 'session_defaults',
      text: '',
      properties: { agentId: 'agent-a', nodeId: 'node-a' },
      collapsed: false,
    }],
  } as PlannerFolder;
  usePlannerStore.getState().setSelectedFolderSnapshot(assignedFolder);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);

  fireEvent.press(screen.getByLabelText('기본 담당 수정'));

  expect(screen.getByTestId('task-default-assignment-save').props.accessibilityState.disabled)
    .toBe(false);
});

test('태블릿 header와 phone content가 같은 중요·오늘 토글 정본을 사용한다', async () => {
  const starredFolder = {
    ...plannerFolder,
    page: { ...plannerFolder.page, metadata: { starred: true } },
  } as PlannerFolder;
  usePlannerStore.setState({
    selectedFolderSnapshot: starredFolder,
    dailyByDate: {
      '2026-07-17': {
        daily: { page: { ...plannerFolder.page, id: 'daily' }, blocks: [], stateVector: 'sv' },
        projects: [],
        memoBlocks: [],
        folders: [starredFolder],
        attention: [], running: [], queued: [],
        reviewSessionIds: [],
      },
    },
  });
  const api = {
    getFolderBoardItems: jest.fn(() => new Promise(() => undefined)),
    getFolderSnapshot: jest.fn(() => new Promise(() => undefined)),
    getPlannerToday: jest.fn().mockResolvedValue(plannerToday([starredFolder])),
  } as unknown as ApiClient;
  const tabletScreen = render(<FolderWorkspace api={api} folderPageId="task-1" />);

  expect(tabletScreen.getByTestId('task-workspace-tablet-header')
    .findByProps({ testID: 'task-workspace-toggle-actions' })).toBeTruthy();
  expect(tabletScreen.getByLabelText('중요 폴더 지정 해제').props.accessibilityState)
    .toMatchObject({ selected: true });
  expect(tabletScreen.getByLabelText('오늘 데일리에서 제거').props.accessibilityState)
    .toMatchObject({ selected: true });
  await waitFor(() => expect(
    tabletScreen.getByLabelText('오늘 데일리에서 제거').props.accessibilityState.disabled,
  ).toBe(false));
  await act(async () => {
    fireEvent.press(tabletScreen.getByLabelText('중요 폴더 지정 해제'));
    fireEvent.press(tabletScreen.getByLabelText('오늘 데일리에서 제거'));
  });
  expect(mockSetFolderStarred).toHaveBeenCalledWith(starredFolder, false);
  expect(mockSetFolderToday).toHaveBeenCalledWith(starredFolder, '2026-07-17', false);

  tabletScreen.unmount();
  mockDeviceType = 'phone';
  const phoneScreen = render(<FolderWorkspace api={api} folderPageId="task-1" />);
  const scrollJson = findJsonByTestId(phoneScreen.toJSON(), 'task-workspace-scroll');
  expect(scrollJson.children[0].children[0].props.testID).toBe('task-workspace-details-group');
  expect(phoneScreen.getByTestId('task-workspace-toggle-actions')).toBeTruthy();
  await waitFor(() => expect(
    phoneScreen.getByLabelText('오늘 데일리에서 제거').props.accessibilityState.disabled,
  ).toBe(false));
});

test.each([
  ['포함', [plannerFolder], '오늘 데일리에서 제거', true],
  ['미포함', [], '오늘 데일리에 추가', false],
] as const)('cold-entry 오늘 snapshot %s 응답을 기다린 뒤 상태를 확정한다', async (
  _case,
  folders,
  label,
  selected,
) => {
  let resolveToday!: (value: PlannerToday) => void;
  const todayRequest = new Promise<PlannerToday>((resolve) => { resolveToday = resolve; });
  const getPlannerToday = jest.fn(() => todayRequest);
  const api = {
    getPlannerToday,
    getFolderBoardItems: jest.fn().mockResolvedValue([]),
    getFolderSnapshot: jest.fn(() => new Promise(() => undefined)),
  } as unknown as ApiClient;
  const screen = render(<FolderWorkspace api={api} folderPageId="task-1" />);

  await waitFor(() => expect(getPlannerToday).toHaveBeenCalledWith('2026-07-17'));
  expect(usePlannerStore.getState().dailyByDate['2026-07-17']).toBeUndefined();
  expect(screen.getByTestId('task-workspace-today-toggle').props.accessibilityState)
    .toMatchObject({ disabled: true, busy: true });
  expect(screen.getByTestId('task-workspace-starred-toggle').props.accessibilityState)
    .toMatchObject({ disabled: false });
  await act(async () => {
    fireEvent.press(screen.getByTestId('task-workspace-starred-toggle'));
  });
  expect(mockSetFolderStarred).toHaveBeenCalledWith(plannerFolder, true);

  await act(async () => {
    resolveToday(plannerToday([...folders]));
    await todayRequest;
  });

  await waitFor(() => expect(screen.getByLabelText(label).props.accessibilityState)
    .toMatchObject({ selected, disabled: false, busy: false }));
});

test('phone 기본 읽기는 native title만 소유하고 명시적 편집에서 취소·저장한다', async () => {
  mockDeviceType = 'phone';
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
  const onTitleSaved = jest.fn();
  const screen = render(
    <FolderWorkspace
      api={null}
      folderPageId="task-1"
      onTitleSaved={onTitleSaved}
    />,
  );

  expect(screen.queryByTestId('task-workspace-title-heading')).toBeNull();
  const scrollJson = findJsonByTestId(screen.toJSON(), 'task-workspace-scroll');
  expect(scrollJson.children[0].children[0].props.testID).toBe('task-workspace-details-group');
  expect(screen.getAllByTestId('task-workspace-context-empty')).toHaveLength(1);
  expect(StyleSheet.flatten(
    screen.getByTestId('task-workspace-scroll').props.contentContainerStyle,
  )).toMatchObject({ padding: 20 });

  const editAction = screen.getByTestId('task-workspace-title-edit-action');
  expect(StyleSheet.flatten(editAction.props.style)).toMatchObject({
    minWidth: 44,
    minHeight: 44,
  });
  fireEvent.press(editAction);
  fireEvent.changeText(screen.getByTestId('task-workspace-title-heading'), '취소할 제목');
  fireEvent.press(screen.getByTestId('task-workspace-title-cancel-action'));

  expect(screen.queryByTestId('task-workspace-title-heading')).toBeNull();
  expect(mockRenameFolder).not.toHaveBeenCalled();

  fireEvent.press(screen.getByTestId('task-workspace-title-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-workspace-title-heading'), '저장할 제목');
  await act(async () => {
    fireEvent.press(screen.getByTestId('task-workspace-title-save-action'));
  });

  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledWith('task-1', '저장할 제목'));
  expect(onTitleSaved).toHaveBeenCalledWith('저장할 제목');
  expect(screen.queryByTestId('task-workspace-title-heading')).toBeNull();
});

test.each([
  ['title', '  실제 업무 제목  ', null, '실제 업무 제목'], ['title', '  새 제목  ', '새 제목', '새 제목'], ['title', '   ', null, null],
  ['workspace', '  실제 업무 제목  ', null, '실제 업무 제목'], ['workspace', '  새 제목  ', '새 제목', '새 제목'], ['workspace', '   ', null, null],
] as const)('%s 저장은 %p를 canonical title로 정규화한다', async (path, input, renamed, saved) => {
  mockDeviceType = 'phone';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const onTitleSaved = jest.fn();
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" onTitleSaved={onTitleSaved} />);
  fireEvent.press(screen.getByTestId('task-workspace-title-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-workspace-title-heading'), input);
  if (path === 'workspace') fireEvent.changeText(screen.getByPlaceholderText('폴더 설명'), '설명 저장');
  await act(async () => fireEvent.press(screen.getByTestId(
    path === 'title' ? 'task-workspace-title-save-action' : 'task-workspace-save-action',
  )));
  if (renamed) expect(mockRenameFolder).toHaveBeenCalledWith('task-1', renamed);
  else expect(mockRenameFolder).not.toHaveBeenCalled();
  if (path === 'workspace') expect(mockSaveFolderDescription).toHaveBeenCalledWith(plannerFolder, '설명 저장');
  if (saved) {
    expect(onTitleSaved).toHaveBeenCalledWith(saved);
    expect(screen.queryByTestId('task-workspace-title-heading')).toBeNull();
  } else {
    expect(onTitleSaved).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('폴더 제목을 입력해 주세요.');
    expect(screen.getByTestId('task-workspace-title-heading')).toBeTruthy();
  }
});

test.each([
  ['phone', 1, 44],
  ['phone', 2, 44],
  ['tabletPortrait', 1, 48],
  ['tabletPortrait', 2, 48],
] as const)('%s fontScale %s 업무 chrome은 grouped detail·context52·action%i·자연 확장을 유지한다', (
  device,
  fontScale,
  actionSize,
) => {
  mockDeviceType = device;
  jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(fontScale);
  const screen = render(
    <FolderWorkspace
      api={null}
      folderPageId="task-1"
      onClose={device === 'phone' ? undefined : jest.fn()}
    />,
  );
  expect(screen.getByTestId('task-workspace-details-group')).toBeTruthy();
  expect(screen.getByTestId('folder-cards')).toBeTruthy();
  expect(screen.getByTestId('task-board-content')).toBeTruthy();
  expect(screen.getAllByTestId('task-workspace-context-empty')).toHaveLength(1);
  const contextRow = screen.getByTestId('task-workspace-context-row');
  expect(StyleSheet.flatten(contextRow.props.style)).toMatchObject({
    minHeight: 52,
    paddingVertical: 8,
  });
  expect(StyleSheet.flatten(contextRow.props.style)).not.toHaveProperty('height');
  expect(StyleSheet.flatten(screen.getByTestId('task-workspace-context-empty').props.style))
    .toMatchObject({ minHeight: 52 });
  const assignmentRow = screen.getByTestId('task-workspace-default-assignment-row');
  expect(StyleSheet.flatten(assignmentRow.props.style)).toMatchObject({
    minHeight: 52,
    paddingVertical: 8,
  });
  expect(StyleSheet.flatten(assignmentRow.props.style)).not.toHaveProperty('height');
  const assignmentSummary = screen.getByLabelText('기본 담당 수정');
  expect(StyleSheet.flatten(assignmentSummary.props.style)).toMatchObject({ minHeight: actionSize });
  expect(StyleSheet.flatten(assignmentSummary.props.style)).not.toHaveProperty('height');
  const addContext = screen.getByTestId('task-workspace-add-context');
  expect(StyleSheet.flatten(addContext.props.style)).toMatchObject({
    minWidth: actionSize,
    minHeight: actionSize,
  });
  const action = device === 'phone'
    ? screen.getByTestId('task-workspace-title-edit-action')
    : screen.getByTestId('task-workspace-close');
  expect(StyleSheet.flatten(action.props.style)).toMatchObject({
    minWidth: actionSize,
    minHeight: actionSize,
  });
  expect(StyleSheet.flatten(action.props.style)).not.toHaveProperty('height');

  screen.unmount();
  usePlannerStore.getState().setSelectedFolderSnapshot(contextualFolder);
  const contextual = render(
    <FolderWorkspace
      api={null}
      folderPageId="task-1"
      onClose={device === 'phone' ? undefined : jest.fn()}
    />,
  );
  expect(contextual.queryByTestId('task-workspace-context-empty')).toBeNull();
  for (const id of ['context-guidance', 'context-atom']) {
    const item = contextual.getByTestId(`task-workspace-context-item-${id}`);
    expect(StyleSheet.flatten(item.props.style)).toMatchObject({ minHeight: 52 });
    expect(StyleSheet.flatten(item.props.style)).not.toHaveProperty('height');
  }
});

test('같은 pageId의 A→B 전환은 제목·설명 draft를 이전 계정에서 승계하지 않는다', async () => {
  const described = {
    ...plannerFolder,
    blocks: [{
      id: 'description', pageId: 'task-1', parentId: null, positionKey: 'a',
      blockType: 'paragraph', text: 'A 서버 설명', properties: { role: 'description' },
      collapsed: false,
    }],
  } as PlannerFolder;
  usePlannerStore.getState().setSelectedFolderSnapshot(described);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);

  fireEvent.changeText(screen.getByTestId('task-workspace-tablet-title'), 'A 미저장 제목');
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), 'A 미저장 설명');

  const scopeBFolder = {
    ...described,
    page: { ...described.page, title: 'B 서버 제목' },
    blocks: [{ ...described.blocks[0], text: 'B 서버 설명' }],
  } as PlannerFolder;
  await act(async () => {
    useAuthStore.getState().setJwt('scope-b');
    usePlannerStore.getState().setSelectedFolderSnapshot(scopeBFolder);
    await Promise.resolve();
  });

  expect(screen.getByDisplayValue('B 서버 제목')).toBeTruthy();
  expect(screen.queryByDisplayValue('A 미저장 제목')).toBeNull();
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  expect(screen.getByDisplayValue('B 서버 설명')).toBeTruthy();
  expect(screen.queryByDisplayValue('A 미저장 설명')).toBeNull();
});

test('iPad 제목 focus 상태에서 헤더를 닫아도 최신 snapshot을 먼저 저장한다', async () => {
  const close = jest.fn();
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" onClose={close} />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, 'focus 상태 최신 제목');
  fireEvent.press(screen.getByTestId('task-workspace-close'));

  expect(close).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledWith('task-1', 'focus 상태 최신 제목'));
});

test('dirty 저장이 없으면 외부 큐가 서버 제목 갱신을 가리지 않는다', async () => {
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);

  await act(async () => {
    usePlannerStore.getState().setSelectedFolderSnapshot({
      ...plannerFolder,
      page: { ...plannerFolder.page, title: '서버에서 갱신된 제목' },
    });
  });

  await waitFor(() => expect(screen.getByDisplayValue('서버에서 갱신된 제목')).toBeTruthy());
  expect(mockRenameFolder).not.toHaveBeenCalled();
});

test('iPad 업무 오버레이는 실제 제목 하나만 frameless 편집 헤더로 표시한다', async () => {
  const close = jest.fn();
  const screen = render(
    <FolderWorkspace api={null} folderPageId="task-1" onClose={close} />,
  );

  const title = screen.getByTestId('task-workspace-tablet-title');
  expect(title.props.value).toBe('실제 업무 제목');
  expect(screen.queryByTestId('task-workspace-title-heading')).toBeNull();
  expect(screen.queryByText('폴더 작업공간')).toBeNull();
  expect(screen.queryByText('폴더')).toBeNull();
  expect(screen.getByText('세션')).toBeTruthy();
  expect(StyleSheet.flatten(title.props.style).borderWidth).toBe(0);

  fireEvent.changeText(title, '변경 제목');
  await act(async () => fireEvent(title, 'blur'));
  expect(mockRenameFolder).toHaveBeenCalledWith('task-1', '변경 제목');

  fireEvent.press(screen.getByTestId('task-workspace-close'));
  expect(close).toHaveBeenCalledTimes(1);
});

test('iPad 업무 설명은 markdown read에서만 보이고 편집 중 plain multiline으로 바뀐다', () => {
  const described = {
    ...plannerFolder,
    blocks: [{
      id: 'description',
      pageId: 'task-1',
      parentId: null,
      positionKey: 'a',
      blockType: 'paragraph',
      text: '**업무 설명**',
      properties: { role: 'description' },
      collapsed: false,
    }],
  } as PlannerFolder;
  usePlannerStore.getState().setSelectedFolderSnapshot(described);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);

  expect(screen.getByTestId('task-description-markdown')).toBeTruthy();
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  expect(screen.getByTestId('task-description-input').props.multiline).toBe(true);
  expect(screen.queryByTestId('task-description-markdown')).toBeNull();
});

test('iPad 제목 저장 중 추가 입력은 제출 snapshot과 분리해 다음 dirty 값으로 보존한다', async () => {
  let release!: () => void;
  mockRenameFolder.mockImplementationOnce(() => new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  }));
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, '첫 제출 제목');
  fireEvent(title, 'blur');
  fireEvent.changeText(title, '저장 중 추가 제목');
  await act(async () => { release(); });

  expect(mockRenameFolder).toHaveBeenCalledWith('task-1', '첫 제출 제목');
  expect(screen.getByDisplayValue('저장 중 추가 제목')).toBeTruthy();
});

test('iPad 제목은 저장 중 재입력·재blur한 최신 snapshot을 직렬 후속 저장한다', async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  mockRenameFolder
    .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseFirst = () => resolve(undefined);
    }))
    .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseSecond = () => resolve(undefined);
    }));
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, '첫 제출 제목');
  fireEvent(title, 'blur');
  fireEvent.changeText(title, '최신 제출 제목');
  fireEvent(title, 'blur');

  expect(mockRenameFolder).toHaveBeenCalledTimes(1);
  await act(async () => { releaseFirst(); });
  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledTimes(2));
  expect(mockRenameFolder).toHaveBeenNthCalledWith(2, 'task-1', '최신 제출 제목');
  expect(screen.getByDisplayValue('최신 제출 제목')).toBeTruthy();

  await act(async () => { releaseSecond(); });
});

test('iPad 제목 저장 실패는 최신 draft를 dirty로 남겨 다음 blur에서 재시도한다', async () => {
  mockRenameFolder
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(undefined);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, '실패 후 남을 제목');
  await act(async () => { fireEvent(title, 'blur'); });
  expect(screen.getByDisplayValue('실패 후 남을 제목')).toBeTruthy();

  await act(async () => { fireEvent(title, 'blur'); });
  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledTimes(2));
  expect(mockRenameFolder).toHaveBeenNthCalledWith(2, 'task-1', '실패 후 남을 제목');
});

test('iPad 제목 큐는 패널이 닫혀도 응답 역전을 막고 대기 중 최신 저장을 완주한다', async () => {
  let releaseFirst!: () => void;
  mockRenameFolder
    .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseFirst = () => resolve(undefined);
    }))
    .mockResolvedValueOnce(undefined);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, '느린 첫 제목');
  fireEvent(title, 'blur');
  fireEvent.changeText(title, '닫기 전 최신 제목');
  fireEvent(title, 'blur');
  screen.unmount();

  expect(mockRenameFolder).toHaveBeenCalledTimes(1);
  await act(async () => { releaseFirst(); });
  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledTimes(2));
  expect(mockRenameFolder).toHaveBeenNthCalledWith(2, 'task-1', '닫기 전 최신 제목');
});

test('첫 저장 중 닫기는 focus 중 최신 제목을 외부 큐에 남겨 후속 저장한다', async () => {
  let releaseFirst!: () => void;
  mockRenameFolder
    .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseFirst = () => resolve(undefined);
    }))
    .mockResolvedValueOnce(undefined);
  const close = jest.fn();
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" onClose={close} />);
  const title = screen.getByTestId('task-workspace-tablet-title');

  fireEvent.changeText(title, '첫 저장');
  fireEvent(title, 'blur');
  fireEvent.changeText(title, '닫기 시 최신');
  fireEvent.press(screen.getByTestId('task-workspace-close'));
  screen.unmount();

  expect(close).toHaveBeenCalledTimes(1);
  await act(async () => { releaseFirst(); });
  await waitFor(() => expect(mockRenameFolder).toHaveBeenNthCalledWith(2, 'task-1', '닫기 시 최신'));
});

test('닫은 직후 다른 업무를 열어도 두 업무의 제목 큐가 서로 덮어쓰지 않는다', async () => {
  let releaseFirst!: () => void;
  mockRenameFolder
    .mockImplementationOnce(() => new Promise<undefined>((resolve) => {
      releaseFirst = () => resolve(undefined);
    }))
    .mockResolvedValue(undefined);
  const first = render(<FolderWorkspace api={null} folderPageId="task-1" onClose={jest.fn()} />);
  fireEvent.changeText(first.getByTestId('task-workspace-tablet-title'), '첫 업무 최신');
  fireEvent.press(first.getByTestId('task-workspace-close'));
  first.unmount();

  const secondFolder = {
    ...plannerFolder,
    page: { ...plannerFolder.page, id: 'task-2', title: '두 번째 업무' },
    folderId: 'task-2',
  } as PlannerFolder;
  usePlannerStore.getState().setSelectedFolderSnapshot(secondFolder);
  useSessionStore.setState({ catalog: { folders: [{ ...folder, id: 'task-2', name: '두 번째 업무', projectPageId: 'task-2' }], sessions: {} } });
  const second = render(<FolderWorkspace api={null} folderPageId="task-2" onClose={jest.fn()} />);
  fireEvent.changeText(second.getByTestId('task-workspace-tablet-title'), '둘째 업무 최신');
  fireEvent.press(second.getByTestId('task-workspace-close'));

  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledWith('task-2', '둘째 업무 최신'));
  await act(async () => { releaseFirst(); });
  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledWith('task-1', '첫 업무 최신'));
});

test('닫기 저장 실패는 remount 뒤 최신 draft와 재시도 상태를 보존한다', async () => {
  mockRenameFolder.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined);
  const first = render(<FolderWorkspace api={null} folderPageId="task-1" onClose={jest.fn()} />);
  fireEvent.changeText(first.getByTestId('task-workspace-tablet-title'), '실패한 닫기 제목');
  await act(async () => { fireEvent.press(first.getByTestId('task-workspace-close')); });
  first.unmount();

  usePlannerStore.getState().setSelectedFolderSnapshot(plannerFolder);
  const second = render(<FolderWorkspace api={null} folderPageId="task-1" onClose={jest.fn()} />);
  expect(second.getByDisplayValue('실패한 닫기 제목')).toBeTruthy();
  fireEvent.press(second.getByTestId('task-workspace-close'));

  await waitFor(() => expect(mockRenameFolder).toHaveBeenCalledTimes(2));
  expect(mockRenameFolder).toHaveBeenLastCalledWith('task-1', '실패한 닫기 제목');
});

test('iPad 설명 저장 중 추가 입력은 편집기를 닫지 않고 dirty로 유지한다', async () => {
  let release!: () => void;
  mockSaveFolderDescription.mockImplementationOnce(
    () => new Promise<undefined>((resolve) => { release = () => resolve(undefined); }),
  );
  const described = {
    ...plannerFolder,
    blocks: [{
      id: 'description', pageId: 'task-1', parentId: null, positionKey: 'a',
      blockType: 'paragraph', text: '서버 설명', properties: { role: 'description' },
      collapsed: false,
    }],
  } as PlannerFolder;
  usePlannerStore.getState().setSelectedFolderSnapshot(described);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), '첫 제출 설명');
  fireEvent.press(screen.getByTestId('task-description-save-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), '저장 중 추가 설명');

  await act(async () => { release(); });
  await waitFor(() => expect(mockSaveFolderDescription).toHaveBeenCalledWith(
    described,
    '첫 제출 설명',
  ));
  expect(screen.getByDisplayValue('저장 중 추가 설명')).toBeTruthy();
  expect(screen.getByTestId('task-description-save-action')).toBeTruthy();
  expect(screen.queryByTestId('task-description-markdown')).toBeNull();
});

function findJsonByTestId(tree: any, testID: string): any {
  if (!tree) return null;
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const match = findJsonByTestId(child, testID);
      if (match) return match;
    }
    return null;
  }
  if (tree.props?.testID === testID) return tree;
  return findJsonByTestId(tree.children, testID);
}

function plannerToday(folders: PlannerFolder[]): PlannerToday {
  return {
    daily: {
      page: {
        ...plannerFolder.page,
        id: 'daily-2026-07-17',
        title: '2026-07-17',
        dailyDate: '2026-07-17',
      },
      blocks: [],
      stateVector: 'sv-daily',
    },
    projects: [],
    memoBlocks: [],
    folders,
    attention: [], running: [], queued: [],
    reviewSessionIds: [],
  };
}
