import { Alert } from 'react-native';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { Folder } from '../../../api/types';
import type { PlannerBlock, PlannerFolder } from '../../../api/plannerTypes';

jest.mock('@expo/vector-icons/Ionicons', () => 'Ionicons');
jest.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
const mockRenameFolder = jest.fn().mockResolvedValue(undefined);
const mockSaveFolderDescription = jest.fn().mockResolvedValue(undefined);
const mockCreateFolder = jest.fn().mockResolvedValue({ folder: { id: 'created' } });
jest.mock('../../../hooks/usePlannerActions', () => ({
  usePlannerActions: () => ({
    renameFolder: mockRenameFolder,
    saveFolderDescription: mockSaveFolderDescription,
    createFolder: mockCreateFolder,
    createRootFolder: jest.fn(),
  }),
}));
jest.mock('../../../hooks/usePlannerStarred', () => ({
  usePlannerStarred: () => ({ data: { items: [], nextCursor: null }, loading: false, error: null }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({ openProjectMenu: jest.fn(), openFolderMenu: jest.fn() }),
}));
jest.mock('../../settings/SettingsModal', () => ({ SettingsModal: () => null }));

import { NewFolderSheet, type FolderSheetTarget } from '../NewFolderSheet';
import { useFolderSettingsActions } from '../folderSettingsActions';
import { SidebarPane } from '../../split/SidebarPane';
import { FolderContextSection } from '../FolderContextSection';
import { useSessionStore } from '../../../store/sessionStore';
import { useSettingsStore } from '../../../store/settingsStore';

const folders: Folder[] = [
  { id: 'root', name: '최상위', sortOrder: 0, parentFolderId: null, projectPageId: 'root-page' },
  { id: 'parent', name: '상위', sortOrder: 1, parentFolderId: 'root', projectPageId: 'parent-page' },
  { id: 'folder', name: '대시보드', sortOrder: 2, parentFolderId: 'parent', projectPageId: 'folder-page' },
];
const folderBlocks: PlannerBlock[] = [
  block('folder-page', 'body', 'paragraph', '설명', {}),
  block('folder-page', 'g1', 'guidance', '첫 지침', { enabled: true, scope: 'folder' }),
  block('folder-page', 'g2', 'guidance', '둘째 지침', { enabled: true, scope: 'project' }),
  block('folder-page', 'a1', 'atom_ref', '', { instance: 'atom', nodeId: 'n1', nodeTitle: '프론트엔드', depth: 2, titlesOnly: true, limit: 9, mode: 'index' }),
  block('folder-page', 'd1', 'session_defaults', '', { scope: 'session', agentId: 'roselin', nodeId: 'eiaserinnys' }),
];
const pages: Record<string, PlannerBlock[]> = {
  'root-page': [block('root-page', 'root-atom', 'atom_ref', '', { instance: 'atom', nodeId: 'n-root', nodeTitle: 'soulstream', depth: 5, titlesOnly: false })],
  'parent-page': [block('parent-page', 'parent-guidance', 'guidance', '상위 폴더의 지침', { enabled: true, scope: 'project' })],
  'folder-page': folderBlocks,
};

let api: ApiClient & { applyPageOperations: jest.Mock; getPageSessionDefaults: jest.Mock };
beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ serverUrl: 'https://planner.test', nodeId: '' });
  useSessionStore.setState({ catalog: { folders, sessions: {} } });
  api = {
    getPage: jest.fn(async (pageId: string) => ({
      page: { id: pageId, title: pageId, version: 3, archived: false, metadata: {}, createdAt: '', updatedAt: '' },
      blocks: pages[pageId] ?? [], stateVector: 'sv',
    })),
    getPageSessionDefaults: jest.fn(async (pageId: string) => pageId === 'parent-page'
      ? { agentId: 'utonium', nodeId: 'eiaserinnys', modelPreset: null, sourcePageId: 'root-page', sourceBlockId: 'b' }
      : null),
    applyPageOperations: jest.fn().mockResolvedValue({}),
    listNodes: jest.fn().mockResolvedValue({ nodes: [{ nodeId: 'eiaserinnys' }] }),
    listNodeAgents: jest.fn().mockResolvedValue({ agents: [{ id: 'roselin', name: '로젤린' }, { id: 'utonium', name: '서소영' }] }),
    listModelPresets: jest.fn().mockResolvedValue({ model_presets: [] }),
    listAtomRootNodes: jest.fn().mockResolvedValue({ nodes: [{ id: 'n2', title: 'UI 디자인 기준' }] }),
    listAtomNodeChildren: jest.fn().mockResolvedValue({ children: [] }),
  } as never;
});

function Harness({ target, onClose = jest.fn() }: { target: FolderSheetTarget; onClose?: () => void }) {
  const actions = useFolderSettingsActions(api);
  return <NewFolderSheet visible api={api} folders={folders} target={target}
    onClose={onClose} onSubmit={actions.createFolder} onSave={actions.saveFolderSettings} />;
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const operations = () => api.applyPageOperations.mock.calls[0]?.[1].operations;

test('지침 블록이 여럿인 폴더를 열면 글 상자 하나에 이어 보이고, 저장하면 project 블록 하나로 바뀐다', async () => {
  const screen = render(<Harness target={{ kind: 'edit', folder: plannerFolder() }} />);
  await settle();
  expect(screen.getByText('폴더 설정')).toBeTruthy();
  expect(screen.getByTestId('folder-settings-parent').props.children).toBe('상위');
  expect(screen.getByTestId('folder-settings-guidance').props.value).toBe('첫 지침\n\n둘째 지침');
  await act(async () => { fireEvent.press(screen.getByText('저장')); });
  expect(operations()).toEqual(expect.arrayContaining([
    { op: 'update_block_text', block_id: 'g1', text: '첫 지침\n\n둘째 지침' },
    { op: 'update_block_type_and_properties', block_id: 'g1', block_type: 'guidance', properties: { enabled: true, scope: 'project' } },
    { op: 'delete_block_subtree', block_id: 'g2' },
  ]));
  expect(operations()).not.toContainEqual(expect.objectContaining({ block_id: 'd1' }));
});

test('물려받기로 저장하면 지침과 기본 실행 환경 블록을 모두 지우고, 물려받은 값에는 가장 가까운 상위 이름이 붙는다', async () => {
  const screen = render(<Harness target={{ kind: 'edit', folder: plannerFolder() }} />);
  await settle();
  fireEvent.press(screen.getByTestId('settings-segment-folder-guidance-inherit'));
  fireEvent.press(screen.getByTestId('settings-segment-folder-defaults-inherit'));
  await settle();
  expect(screen.getByText('상위 폴더의 지침')).toBeTruthy();
  expect(api.getPageSessionDefaults).toHaveBeenCalledWith('parent-page');
  expect(screen.getByText('서소영 · eiaserinnys')).toBeTruthy();
  expect(within(screen.getByTestId('folder-settings-inherited-defaults')).getByText('최상위')).toBeTruthy();
  expect(within(screen.getByTestId('folder-settings-inherited-guidance')).getByText('상위')).toBeTruthy();
  expect(screen.getByTestId('folder-reference-inherited-n-root')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText('저장')); });
  expect(operations()).toEqual([
    { op: 'delete_block_subtree', block_id: 'g1' },
    { op: 'delete_block_subtree', block_id: 'g2' },
    { op: 'delete_block_subtree', block_id: 'd1' },
  ]);
});

test('기존 폴더에서 참고 자료를 고치면 limit과 mode를 보존하고, 빼고 더할 수 있다', async () => {
  const screen = render(<Harness target={{ kind: 'edit', folder: plannerFolder() }} />);
  await settle();
  fireEvent.press(screen.getByTestId('folder-reference-n1'));
  await settle();
  expect(screen.getByText('참고 자료 고치기')).toBeTruthy();
  fireEvent.press(screen.getByTestId('settings-segment-atom-picker-depth-4'));
  fireEvent.press(screen.getByText('저장'));
  await settle();
  fireEvent.press(screen.getByTestId('folder-reference-add'));
  await settle();
  fireEvent.press(screen.getByTestId('atom-picker-select-n2'));
  fireEvent.press(screen.getByText('추가'));
  await settle();
  expect(screen.getByTestId('folder-reference-n2')).toBeTruthy();
  await act(async () => { fireEvent.press(screen.getByText('저장')); });
  expect(operations()).toContainEqual({
    op: 'update_block_type_and_properties', block_id: 'a1', block_type: 'atom_ref',
    properties: { instance: 'atom', nodeId: 'n1', nodeTitle: '프론트엔드', depth: 4, titlesOnly: true, limit: 9, mode: 'index' },
  });
  expect(operations()).toContainEqual(expect.objectContaining({ op: 'create_block', block_type: 'atom_ref',
    properties: { instance: 'atom', nodeId: 'n2', nodeTitle: 'UI 디자인 기준', depth: 3, titlesOnly: false } }));
});

test('참고 자료 빼기는 그 블록을 지운다', async () => {
  const screen = render(<Harness target={{ kind: 'edit', folder: plannerFolder() }} />);
  await settle();
  fireEvent.press(screen.getByTestId('folder-reference-n1-remove'));
  expect(screen.queryByTestId('folder-reference-n1')).toBeNull();
  await act(async () => { fireEvent.press(screen.getByText('저장')); });
  expect(operations()).toContainEqual({ op: 'delete_block_subtree', block_id: 'a1' });
});

test('최상위 새 폴더는 상위 없이 같은 시트에서 한 번에 만든다', async () => {
  const createFolder = jest.fn().mockResolvedValue({ folder: { ...folders[0], id: 'new-root' } });
  (api as unknown as { plannerMutations: unknown }).plannerMutations = { createFolder };
  const onClose = jest.fn();
  const screen = render(<Harness target={{ kind: 'create', parentProjectPageId: null }} onClose={onClose} />);
  await settle();
  expect(screen.getByText('새 폴더')).toBeTruthy();
  expect(screen.queryByText('상위 폴더')).toBeNull();
  fireEvent.changeText(screen.getByTestId('folder-settings-title'), '새 프로젝트');
  fireEvent.press(screen.getByTestId('settings-segment-folder-guidance-own'));
  fireEvent.changeText(screen.getByTestId('folder-settings-guidance'), '처음 지침');
  await act(async () => { fireEvent.press(screen.getByText('만들기')); });
  expect(createFolder).toHaveBeenCalledWith(expect.objectContaining({
    title: '새 프로젝트', folderId: null,
    initialContext: { guidance: '처음 지침', atomReferences: [] },
  }));
  expect(useSessionStore.getState().catalog.folders.map((folder) => folder.id)).toContain('new-root');
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(mockCreateFolder).not.toHaveBeenCalled();
});

test('아이패드 사이드바의 새 프로젝트는 Alert.prompt 대신 새 폴더 시트를 연다', async () => {
  const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => undefined);
  const screen = render(<SidebarPane />);
  fireEvent.press(screen.getByTestId('sidebar-new-root-folder'));
  await settle();
  expect(prompt).not.toHaveBeenCalled();
  expect(screen.getByText('새 폴더')).toBeTruthy();
  expect(screen.getByTestId('folder-settings-title')).toBeTruthy();
  prompt.mockRestore();
});

test('폴더 화면 맥락은 물려받은 값까지 표시 이름으로 요약하고, 실패하면 같은 틀에서 다시 시도한다', async () => {
  const openSettings = jest.fn();
  api.getPageSessionDefaults.mockResolvedValue({ agentId: 'roselin', nodeId: 'eiaserinnys', modelPreset: null, sourcePageId: 'folder-page', sourceBlockId: 'd1' });
  const getPage = api.getPage as jest.Mock;
  const original = getPage.getMockImplementation()!;
  getPage.mockRejectedValueOnce(new Error('일시 실패'));
  const screen = render(<FolderContextSection api={api} folderId="folder" folderPageId="folder-page" folders={folders} active onOpenSettings={openSettings} />);
  await settle();
  expect(screen.getByText('맥락을 불러오지 못했습니다.')).toBeTruthy();
  expect(screen.queryByTestId('folder-context-guidance')).toBeNull();
  getPage.mockImplementation(original);
  fireEvent.press(screen.getByTestId('folder-context-retry'));
  await settle();
  expect(screen.getByTestId('folder-context-guidance')).toHaveTextContent(/첫 지침\s+둘째 지침/);
  expect(screen.getByTestId('folder-context-references')).toHaveTextContent(/soulstream, 프론트엔드$/);
  expect(screen.getByTestId('folder-context-defaults')).toHaveTextContent(/로젤린 · eiaserinnys$/);
  expect(screen.queryByText('roselin')).toBeNull();
  fireEvent.press(screen.getByText('설정'));
  expect(openSettings).toHaveBeenCalledTimes(1);
});

function plannerFolder(): PlannerFolder {
  return {
    page: { id: 'folder-page', title: '대시보드', version: 3, archived: false, metadata: {}, createdAt: '', updatedAt: '' },
    blocks: folderBlocks, folderId: 'folder', folderSummary: null, status: 'open', assignee: '',
    contextCount: 0, progress: null, projectPageId: 'folder-page', parentFolderId: 'parent', sessions: [], sessionIds: [],
  };
}

function block(pageId: string, id: string, blockType: string, text: string, properties: Record<string, unknown>): PlannerBlock {
  return { id, pageId, parentId: null, positionKey: id, blockType, text, properties, collapsed: false };
}
