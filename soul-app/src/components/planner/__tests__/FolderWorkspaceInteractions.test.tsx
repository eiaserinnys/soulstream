import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import type { PlannerPage, PlannerFolder } from '../../../api/plannerTypes';
import { usePlannerStore } from '../../../store/plannerStore';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';

const mockOpenProjectMenu = jest.fn();
const mockOpenChildFolderManagement = jest.fn();
const mockUsePlannerProject = jest.fn();

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => 'MaterialCommunityIcons');
jest.mock('../../../api/client', () => ({ createApiClient: jest.fn(() => ({})) }));
jest.mock('../../../hooks/usePlannerReads', () => ({
  usePlannerDaily: () => ({
    data: { folders: [] },
    loading: false,
    error: null,
  }),
  usePlannerPageDetail: () => ({ data: { blocks: [] }, loading: false, error: null }),
  usePlannerFolderDetail: (...args: unknown[]) => {
    const result = mockUsePlannerProject(...args);
    const folder = require('../../../store/sessionStore').useSessionStore.getState()
      .catalog.folders.find((candidate: { id: string }) => candidate.id === args[1]);
    return {
      ...result,
      data: result.data && folder ? {
        folder, page: result.data.project, blocks: [], cards: [],
        subfolders: result.folders,
        sessions: { items: [], nextCursor: null },
      } : undefined,
      loadMoreSubfolders: result.loadMoreFolders,
    };
  },
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openFolderMenu: jest.fn(),
    openProjectMenu: mockOpenProjectMenu,
    openChildFolderManagement: mockOpenChildFolderManagement,
    openSessionMenu: jest.fn(),
    sessionSuccession: null,
    closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({
    createFolder: jest.fn(),
    renameFolderPage: jest.fn(),
    saveFolderDescription: jest.fn(),
    saveFolderSessionDefaults: jest.fn(),
  }),
}));
jest.mock('../ProjectContextEditor', () => ({
  ProjectContextEditor: () => require('react').createElement(require('react-native').View, { testID: 'folder-context-editor' }),
}));
jest.mock('../NewFolderSheet', () => ({ NewFolderSheet: (props: { visible: boolean }) => props.visible
  ? require('react').createElement(require('react-native').View, { testID: 'new-folder-sheet' })
  : null }));
jest.mock('../FolderDefaultAssignment', () => ({ FolderDefaultAssignment: () => null }));
jest.mock('../FolderCards', () => ({
  FolderCards: () => require('react').createElement(require('react-native').View, { testID: 'folder-checklist' }),
}));
jest.mock('../FolderSessionHistory', () => ({ FolderSessionHistory: () => null }));
jest.mock('../SessionSuccessionSheet', () => ({ SessionSuccessionSheet: () => null }));
jest.mock('../SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));

import { FolderWorkspace } from '../FolderWorkspace';

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePlannerProject.mockReturnValue({
    data: undefined, folders: undefined,
    loading: false, error: null, refresh: jest.fn(),
    loadMoreFolders: jest.fn(),
  });
  usePlannerStore.getState().resetForTest();
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useSessionStore.setState({ catalog: { folders: [], sessions: {} } });
});

test('폴더 문맥은 남고 문서 동작 메뉴는 열리지 않는다', () => {
  const folder = plannerFolder();
  usePlannerStore.setState({ selectedFolderSnapshot: folder });

  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  fireEvent(screen.getByText('설계 문서'), 'longPress');

  expect(screen.getByText('설계 문서')).toBeTruthy();
  expect(mockOpenProjectMenu).not.toHaveBeenCalled();
  expect(mockOpenChildFolderManagement).not.toHaveBeenCalled();
});

test('하위 폴더도 기존 PlannerFolderRow로 열고 상위 폴더로 이동한다', () => {
  const onOpenFolder = jest.fn();
  useSessionStore.setState({ catalog: { folders: [
    { id: 'parent', name: '상위', projectPageId: 'parent-page', sortOrder: 0 },
    { id: 'folder-1', name: '프로젝트', projectPageId: 'project-1', parentFolderId: 'parent', sortOrder: 0 },
    { id: 'child', name: '업무', projectPageId: 'child-page', parentFolderId: 'folder-1', sortOrder: 0 },
  ], sessions: {} } });
  mockUsePlannerProject.mockReturnValue({
    data: { project: page('project-1', '프로젝트'), folders: { items: [], nextCursor: null } },
    folders: { items: [{ id: 'child', name: '업무', projectPageId: 'child-page', parentFolderId: 'folder-1', sortOrder: 0 }], nextCursor: null },
    loading: false,
    error: null,
    refresh: jest.fn(),
    loadMoreFolders: jest.fn(),
  });

  const screen = render(<FolderWorkspace api={null} folderId="folder-1" folderPageId="project-1" onOpenFolder={onOpenFolder} />);
  expect(screen.getByTestId('planner-task-row-parent-page')).toBeTruthy();
  expect(screen.getByTestId('planner-task-row-parent-page').props.accessibilityLabel).toBe('상위 폴더 상위');
  expect(screen.getByTestId('planner-task-row-parent-page').findAll((node) => String(node.type) === 'Ionicons').map((icon) => icon.props.name)).toEqual(['folder-outline', 'arrow-up']);
  expect([...new Set(screen.getByTestId('folder-child-sheet').findAll((node) => String(node.props.testID ?? '').startsWith('planner-task-row-')).map((row) => row.props.testID))]).toEqual([
    'planner-task-row-parent-page', 'planner-task-row-child-page',
  ]);
  expect(screen.getByTestId('planner-task-row-child-page')).toBeTruthy();
  fireEvent.press(screen.getByTestId('planner-task-row-child-page'));
  expect(onOpenFolder).toHaveBeenCalledWith('child', 'child-page', '업무');
  fireEvent(screen.getByTestId('planner-task-row-child-page'), 'longPress');
  expect(mockOpenChildFolderManagement).toHaveBeenCalledWith(expect.objectContaining({ id: 'child' }));
  fireEvent.press(screen.getByTestId('planner-task-row-parent-page'));
  expect(onOpenFolder).toHaveBeenCalledWith('parent', 'parent-page', '상위');
  expect(screen.queryByText('새 업무')).toBeNull();
  fireEvent.press(screen.getByText('새 폴더'));
  expect(screen.getByTestId('new-folder-sheet')).toBeTruthy();
});

test('서버 필드가 없는 폴더에서도 카드 목록은 항상 렌더된다', () => {
  useSessionStore.setState({ catalog: { folders: [
    { id: 'folder-1', name: '폴더', projectPageId: 'project-1', sortOrder: 0 },
  ], sessions: {} } });

  const screen = render(<FolderWorkspace api={null} folderId="folder-1" folderPageId="project-1" />);
  expect(screen.queryByTestId('folder-parent-action')).toBeNull();
  expect(screen.getByTestId('folder-context-editor')).toBeTruthy();
  expect(screen.getByText('설명')).toBeTruthy();
  expect(screen.getByTestId('folder-checklist')).toBeTruthy();
});

function plannerFolder(): PlannerFolder {
  return {
    page: page('task-1', '업무'),
    blocks: [{
      id: 'context-doc', pageId: 'task-1', parentId: null, positionKey: '',
      blockType: 'paragraph', text: '[[설계 문서]]', properties: {}, collapsed: false,
    }],
    folderId: 'task-1', folderSummary: null, status: 'open', assignee: '',
    contextCount: 1, progress: null, projectPageId: 'project-1', sessions: [],
    sessionIds: [],
  };
}

function page(id: string, title: string): PlannerPage {
  return {
    id, title, dailyDate: null, version: 1, archived: false,
    metadata: {}, createdAt: '', updatedAt: '',
  };
}
