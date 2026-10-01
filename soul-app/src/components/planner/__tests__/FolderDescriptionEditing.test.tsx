jest.mock('expo-image-picker', () => ({}));
jest.mock('expo-document-picker', () => ({}));
const mockRenameFolder = jest.fn(async () => undefined);
const mockSaveFolderDescription = jest.fn(async () => undefined);
const mockSetFolderStarred = jest.fn(async () => undefined);
const mockSetFolderToday = jest.fn(async () => undefined);

jest.mock('../../../theme', () => ({
  ...jest.requireActual('../../../theme'),
  useDeviceType: () => 'tabletPortrait',
}));
jest.mock('../../../theme/useDeviceType', () => ({
  useDeviceType: () => 'tabletPortrait',
  deviceTypeToBaseKey: () => 'tablet',
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
    renameFolderPage: mockRenameFolder,
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

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { TextInput } from 'react-native';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { PlannerFolder } from '../../../api/plannerTypes';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import { useAuthStore } from '../../../store/authStore';
import { usePlannerStore } from '../../../store/plannerStore';
import { useSettingsStore } from '../../../store/settingsStore';
import { TabletMarkdownEditor } from '../TabletMarkdownEditor';
import { FolderWorkspace } from '../FolderWorkspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function folderWithDescription(text: string, title = '업무'): PlannerFolder {
  return {
    page: {
      id: 'task-1', title, metadata: {}, version: 1, dailyDate: null,
      archived: false, createdAt: '', updatedAt: '',
    },
    blocks: [{
      id: 'description', pageId: 'task-1', parentId: null, positionKey: 'a',
      blockType: 'paragraph', text, properties: { role: 'description' }, collapsed: false,
    }],
    folderId: 'task-1', folderSummary: null, status: 'open', assignee: '담당 미지정',
    contextCount: 0, progress: null, projectPageId: null, sessions: [], sessionIds: [],

  } as PlannerFolder;
}

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'scope-a' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
  usePlannerStore.getState().setSelectedFolderSnapshot(folderWithDescription('서버 설명'));
  mockRenameFolder.mockResolvedValue(undefined);
  mockSaveFolderDescription.mockResolvedValue(undefined);
  mockSetFolderStarred.mockResolvedValue(undefined);
  mockSetFolderToday.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('동일 렌더의 저장 두 번은 synchronous editor lock에서 한 번만 전달한다', async () => {
  const pending = deferred<void>();
  const save = jest.fn(() => pending.promise);
  const screen = render(
    <TabletMarkdownEditor
      testID="description" ownerKey="owner-a" value="A" draft="B"
      onChangeDraft={jest.fn()} onSave={save} onCancel={jest.fn()} emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));

  await act(async () => {
    fireEvent.press(screen.getByTestId('description-save-action'));
    fireEvent.press(screen.getByTestId('description-save-action'));
    await Promise.resolve();
  });

  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(); });
});

test('저장 성공과 취소는 native 입력을 blur한 뒤 read mode로 돌아간다', async () => {
  const blurTextInput = jest.spyOn(TextInput.State, 'blurTextInput');
  const success = render(
    <TabletMarkdownEditor
      testID="description" value="A" draft="B" onChangeDraft={jest.fn()}
      onSave={jest.fn(async () => undefined)} onCancel={jest.fn()} emptyText="설명 없음"
    />,
  );
  fireEvent.press(success.getByTestId('description-edit-action'));
  await act(async () => { fireEvent.press(success.getByTestId('description-save-action')); });
  await waitFor(() => expect(success.queryByTestId('description-input')).toBeNull());
  expect(blurTextInput).toHaveBeenCalledTimes(1);
  success.unmount();

  blurTextInput.mockClear();
  const cancel = jest.fn();
  const cancelled = render(
    <TabletMarkdownEditor
      testID="description" value="A" draft="B" onChangeDraft={jest.fn()}
      onSave={jest.fn()} onCancel={cancel} emptyText="설명 없음"
    />,
  );
  fireEvent.press(cancelled.getByTestId('description-edit-action'));
  fireEvent.press(cancelled.getByTestId('description-cancel-action'));
  expect(blurTextInput).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancelled.queryByTestId('description-input')).toBeNull();
});

test('현재 attempt 저장 실패는 focus와 편집 draft를 보존한다', async () => {
  const blurTextInput = jest.spyOn(TextInput.State, 'blurTextInput');
  const screen = render(
    <TabletMarkdownEditor
      testID="description" value="A" draft="실패 draft" onChangeDraft={jest.fn()}
      onSave={jest.fn(async () => { throw new Error('network'); })}
      onCancel={jest.fn()} emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));
  await act(async () => { fireEvent.press(screen.getByTestId('description-save-action')); });

  expect(blurTextInput).not.toHaveBeenCalled();
  expect(screen.getByDisplayValue('실패 draft')).toBeTruthy();
  expect(screen.getByTestId('description-save-action')).toBeTruthy();
});

test.each(['success', 'failure'] as const)(
  'owner A의 늦은 %s settle은 owner B의 저장 lock과 편집 상태를 바꾸지 않는다',
  async (settle) => {
    const saveA = deferred<void>();
    const saveB = deferred<void>();
    const screen = render(
      <TabletMarkdownEditor
        testID="description" ownerKey="owner-a" value="A 서버" draft="A 제출"
        onChangeDraft={jest.fn()} onSave={() => saveA.promise} onCancel={jest.fn()}
        emptyText="설명 없음"
      />,
    );
    fireEvent.press(screen.getByTestId('description-edit-action'));
    fireEvent.press(screen.getByTestId('description-save-action'));

    screen.rerender(
      <TabletMarkdownEditor
        testID="description" ownerKey="owner-b" value="B 서버" draft="B 제출"
        onChangeDraft={jest.fn()} onSave={() => saveB.promise} onCancel={jest.fn()}
        emptyText="설명 없음"
      />,
    );
    fireEvent.press(screen.getByTestId('description-edit-action'));
    fireEvent.press(screen.getByTestId('description-save-action'));
    await waitFor(() => expect(screen.getByText('저장 중…')).toBeTruthy());

    await act(async () => {
      if (settle === 'success') saveA.resolve();
      else saveA.reject(new Error('A failed'));
    });
    expect(screen.getByDisplayValue('B 제출')).toBeTruthy();
    expect(screen.getByText('저장 중…')).toBeTruthy();

    await act(async () => { saveB.resolve(); });
    await waitFor(() => expect(screen.queryByTestId('description-input')).toBeNull());
  },
);

test('owner가 A→B→A로 순환해도 이전 A attempt가 새 A lock을 해제하지 않는다', async () => {
  const firstA = deferred<void>();
  const secondA = deferred<void>();
  const screen = render(
    <TabletMarkdownEditor
      testID="description" ownerKey="owner-a" value="A0" draft="A1"
      onChangeDraft={jest.fn()} onSave={() => firstA.promise} onCancel={jest.fn()}
      emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));
  fireEvent.press(screen.getByTestId('description-save-action'));
  screen.rerender(
    <TabletMarkdownEditor
      testID="description" ownerKey="owner-b" value="B0" draft="B1"
      onChangeDraft={jest.fn()} onSave={jest.fn()} onCancel={jest.fn()} emptyText="설명 없음"
    />,
  );
  screen.rerender(
    <TabletMarkdownEditor
      testID="description" ownerKey="owner-a" value="A0" draft="A2"
      onChangeDraft={jest.fn()} onSave={() => secondA.promise} onCancel={jest.fn()}
      emptyText="설명 없음"
    />,
  );
  fireEvent.press(screen.getByTestId('description-edit-action'));
  fireEvent.press(screen.getByTestId('description-save-action'));
  await waitFor(() => expect(screen.getByText('저장 중…')).toBeTruthy());

  await act(async () => { firstA.resolve(); });
  expect(screen.getByDisplayValue('A2')).toBeTruthy();
  expect(screen.getByText('저장 중…')).toBeTruthy();

  await act(async () => { secondA.resolve(); });
  await waitFor(() => expect(screen.queryByTestId('description-input')).toBeNull());
});

test('FolderWorkspace는 성공 canonical prop을 한 번 수렴시키고 연속 편집을 누적하지 않는다', async () => {
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), 'B');
  await act(async () => {
    fireEvent.press(screen.getByTestId('task-description-save-action'));
    fireEvent.press(screen.getByTestId('task-description-save-action'));
  });

  await waitFor(() => expect(mockSaveFolderDescription).toHaveBeenCalledTimes(1));
  expect(mockSaveFolderDescription).toHaveBeenLastCalledWith(expect.anything(), 'B');
  await waitFor(() => expect(screen.getByTestId('task-description-markdown')).toHaveTextContent('B'));

  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), 'C');
  await act(async () => { fireEvent.press(screen.getByTestId('task-description-save-action')); });

  await waitFor(() => expect(mockSaveFolderDescription).toHaveBeenCalledTimes(2));
  expect(mockSaveFolderDescription).toHaveBeenLastCalledWith(expect.anything(), 'C');
  await waitFor(() => expect(screen.getByTestId('task-description-markdown')).toHaveTextContent('C'));
});

test('이전 owner canonical 응답은 새 owner draft를 덮지 않는다', async () => {
  const saveA = deferred<undefined>();
  const saveB = deferred<undefined>();
  mockSaveFolderDescription
    .mockImplementationOnce(() => saveA.promise)
    .mockImplementationOnce(() => saveB.promise);
  const screen = render(<FolderWorkspace api={null} folderPageId="task-1" />);
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), 'A 제출');
  fireEvent.press(screen.getByTestId('task-description-save-action'));

  const ownerBFolder = folderWithDescription('B 서버', 'B 업무');
  await act(async () => {
    useAuthStore.getState().setJwt('scope-b');
    usePlannerStore.getState().setSelectedFolderSnapshot(ownerBFolder);
    await Promise.resolve();
  });
  fireEvent.press(screen.getByTestId('task-description-edit-action'));
  fireEvent.changeText(screen.getByTestId('task-description-input'), 'B 제출');
  fireEvent.press(screen.getByTestId('task-description-save-action'));
  await waitFor(() => expect(mockSaveFolderDescription).toHaveBeenCalledTimes(2));

  await act(async () => { saveA.resolve(undefined); });
  expect(screen.getByDisplayValue('B 제출')).toBeTruthy();
  expect(screen.getByText('저장 중…')).toBeTruthy();

  await act(async () => { saveB.resolve(undefined); });
  await waitFor(() => expect(screen.getByTestId('task-description-markdown')).toHaveTextContent('B 제출'));
});

test('설명 편집 표면 inventory는 task 공통 경로와 runbook 제외 근거를 고정한다', () => {
  const files = sourceFiles(path.join(process.cwd(), 'src'));
  const tabletEditorMounts = files.filter((file) => (
    fs.readFileSync(file, 'utf8').includes('<TabletMarkdownEditor')
  )).map(repoRelative).sort();
  const folderWorkspaceMounts = files.filter((file) => (
    /<FolderWorkspace(?=[\s/>])/.test(fs.readFileSync(file, 'utf8'))
  )).map(repoRelative).sort();

  expect(tabletEditorMounts).toEqual([
    'src/components/planner/DailyMemo.tsx',
    'src/components/planner/FolderWorkspace.tsx',
  ]);
  expect(folderWorkspaceMounts).toEqual([
    'src/components/planner/FolderWorkspaceReadOverlay.tsx',
    'src/components/split/MainListPane.tsx',
    'src/navigation/TabNavigator.tsx',
  ]);

  const workspaceSource = fs.readFileSync(
    path.join(process.cwd(), 'src/components/planner/FolderWorkspace.tsx'), 'utf8',
  );
  const boardContainerSource = fs.readFileSync(
    path.join(process.cwd(), 'src/api/boardItemEndpoints.ts'), 'utf8',
  );
  const invalidationSource = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/planner-invalidation.ts'), 'utf8',
  );
  expect(workspaceSource).not.toContain('savingDescription');
  expect(boardContainerSource).not.toMatch(/kind:\s*'runbook'/);
  expect(invalidationSource).not.toContain("case 'runbook_updated':");
});

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(absolute);
    }
    return /\.tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

function repoRelative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join('/');
}
