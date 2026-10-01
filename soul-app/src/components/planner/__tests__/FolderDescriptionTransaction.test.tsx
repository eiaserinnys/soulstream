let mockScopedApi: unknown;

jest.mock('../../../api/client', () => ({
  ...jest.requireActual('../../../api/client'),
  createApiClient: () => mockScopedApi,
}));
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
  usePlannerDaily: () => ({ data: undefined, loading: false, error: null }),
  usePlannerPageDetail: () => ({ data: { blocks: [] }, loading: false, error: null }),
  usePlannerFolderDetail: () => ({ data: undefined, loading: false, error: null }),
}));
jest.mock('../../../hooks/usePlannerContextMenus', () => ({
  usePlannerContextMenus: () => ({
    openSessionMenu: jest.fn(), sessionSuccession: null, closeSessionSuccession: jest.fn(),
  }),
}));
jest.mock('../FolderCards', () => ({ FolderCards: () => null }));
jest.mock('../FolderBoardContent', () => ({ FolderBoardContent: () => null }));
jest.mock('../FolderSessionHistory', () => ({ FolderSessionHistory: () => null }));
jest.mock('../SessionSuccessionSheet', () => ({ SessionSuccessionSheet: () => null }));
jest.mock('../SessionSuccessionHost', () => ({ SessionSuccessionHost: () => null }));

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import type { ApiClient } from '../../../api/client';
import type { PlannerBlock, PlannerFolder } from '../../../api/plannerTypes';
import { resetAuthScopeForTest } from '../../../lib/auth-scope';
import { plannerDescriptionText } from '../../../lib/planner-description-blocks';
import { getPlannerDescriptionMutationStateForTest } from '../../../lib/planner-description-mutation-ownership';
import {
  capturePlannerProjection,
  replaceFolderProjection,
} from '../../../lib/planner-mutation-projection';
import { createPlannerActions } from '../../../hooks/usePlannerActions';
import { useAuthStore } from '../../../store/authStore';
import {
  selectPlannerFolder,
  setPlannerProjectionForScope,
  usePlannerStore,
} from '../../../store/plannerStore';
import { useSettingsStore } from '../../../store/settingsStore';
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

function descriptionBlock(pageId: string, text: string): PlannerBlock {
  return {
    id: `description-${pageId}`, pageId, parentId: null, positionKey: 'a',
    blockType: 'paragraph', text, properties: { role: 'description' }, collapsed: false,
  };
}

function folder(pageId: string, text: string): PlannerFolder {
  return {
    page: {
      id: pageId, title: `${pageId} 업무`, metadata: {}, version: 1, dailyDate: null,
      archived: false, createdAt: '', updatedAt: '',
    },
    blocks: [descriptionBlock(pageId, text)],
    folderId: pageId, folderSummary: null, status: 'open', assignee: '담당 미지정',
    contextCount: 0, progress: null, projectPageId: 'project-1', sessions: [],
    sessionIds: [],
  } as PlannerFolder;
}

const folderA = folder('task-a', 'A 서버');
const folderB = folder('task-b', 'B 서버');

beforeEach(() => {
  jest.clearAllMocks();
  useSettingsStore.setState({ serverUrl: 'https://planner.test' });
  useAuthStore.setState({ jwt: 'same-scope-jwt' });
  resetAuthScopeForTest();
  usePlannerStore.getState().resetForTest();
  usePlannerStore.setState({
    folderChildPages: { 'project-1': { items: [folderA, folderB], nextCursor: null } },
    selectedFolderSnapshot: folderA,
  });
});

test.each(['success', 'failure'] as const)(
  '같은 인증 scope에서 stale A %s settle은 B를 건드리지 않고 A만 서버 정본에 수렴시킨다',
  async (aOutcome) => {
    const saveA = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[] }>();
    const saveB = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[] }>();
    const getPage = jest.fn(async (pageId: string) => ({
      page: pageId === folderA.page.id ? folderA.page : folderB.page,
      blocks: pageId === folderA.page.id ? folderA.blocks : folderB.blocks,
      stateVector: 'server',
    }));
    const saveFolderDescription = jest.fn((pageId: string) => (
      pageId === folderA.page.id ? saveA.promise : saveB.promise
    ));
    mockScopedApi = {
      getPage,
      plannerMutations: { saveFolderDescription },
    } as unknown as ApiClient;
    const screen = render(
      <FolderWorkspace api={mockScopedApi as ApiClient} folderPageId={folderA.page.id} />,
    );

    fireEvent.press(screen.getByTestId('task-description-edit-action'));
    fireEvent.changeText(screen.getByTestId('task-description-input'), 'A 제출');
    fireEvent.press(screen.getByTestId('task-description-save-action'));

    await act(async () => {
      usePlannerStore.getState().setSelectedFolderSnapshot(folderB);
      screen.rerender(
        <FolderWorkspace api={mockScopedApi as ApiClient} folderPageId={folderB.page.id} />,
      );
      await Promise.resolve();
    });
    fireEvent.press(screen.getByTestId('task-description-edit-action'));
    fireEvent.changeText(screen.getByTestId('task-description-input'), 'B 제출');
    fireEvent.press(screen.getByTestId('task-description-save-action'));
    await act(async () => {
      saveB.resolve({ page: folderB.page, blocks: [descriptionBlock(folderB.page.id, 'B 제출')] });
    });
    await waitFor(() => expect(
      screen.getByTestId('task-description-markdown'),
    ).toHaveTextContent('B 제출'));

    await act(async () => {
      if (aOutcome === 'success') {
        saveA.resolve({ page: folderA.page, blocks: [descriptionBlock(folderA.page.id, 'A 제출')] });
      } else {
        saveA.reject(new Error('A failed late'));
      }
    });

    expect(useAuthStore.getState().jwt).toBe('same-scope-jwt');
    expect(usePlannerStore.getState().selectedFolderSnapshot?.page.id).toBe(folderB.page.id);
    expect(plannerDescriptionText(
      selectPlannerFolder(folderB.page.id)(usePlannerStore.getState())?.blocks ?? [],
    )).toBe('B 제출');
    expect(screen.getByTestId('task-description-markdown')).toHaveTextContent('B 제출');
    expect(screen.queryByTestId('task-description-input')).toBeNull();
    expect(screen.queryByText('저장 중…')).toBeNull();

    fireEvent.press(screen.getByTestId('task-description-edit-action'));
    expect(screen.getByDisplayValue('B 제출')).toBeTruthy();
    fireEvent.press(screen.getByTestId('task-description-cancel-action'));

    await act(async () => {
      usePlannerStore.getState().setSelectedFolderSnapshot(
        selectPlannerFolder(folderA.page.id)(usePlannerStore.getState()) ?? null,
      );
      screen.rerender(
        <FolderWorkspace api={mockScopedApi as ApiClient} folderPageId={folderA.page.id} />,
      );
      await Promise.resolve();
    });
    expect(screen.getByTestId('task-description-markdown')).toHaveTextContent(
      aOutcome === 'success' ? 'A 제출' : 'A 서버',
    );
    expect(getPage).toHaveBeenCalledTimes(aOutcome === 'failure' ? 1 : 0);
    if (aOutcome === 'failure') expect(getPage).toHaveBeenCalledWith(folderA.page.id);
  },
);

test('같은 task owner의 최신 attempt가 이전 실패의 복원과 재조회 병합을 모두 무효화한다', async () => {
  const first = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[] }>();
  const second = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[] }>();
  const read = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[]; stateVector: string }>();
  let serverDescription = 'A 서버';
  const getPage = jest.fn(() => read.promise);
  const saveFolderDescription = jest.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const api = { getPage, plannerMutations: { saveFolderDescription } } as unknown as ApiClient;
  const actions = createPlannerActions(api);

  const firstPending = actions.saveFolderDescription(folderA, 'A 첫 시도');
  const secondPending = actions.saveFolderDescription(folderA, 'A 최신 시도');
  serverDescription = 'A 최신 시도';
  second.resolve({
    page: folderA.page,
    blocks: [descriptionBlock(folderA.page.id, 'A 최신 시도')],
  });
  await secondPending;
  const firstRejection = expect(firstPending).rejects.toThrow('A first failed late');
  first.reject(new Error('A first failed late'));
  await Promise.resolve();

  expect(plannerDescriptionText(
    selectPlannerFolder(folderA.page.id)(usePlannerStore.getState())?.blocks ?? [],
  )).toBe('A 최신 시도');
  read.resolve({
    page: folderA.page,
    blocks: [descriptionBlock(folderA.page.id, serverDescription)],
    stateVector: 'server',
  });
  await firstRejection;

  expect(plannerDescriptionText(
    selectPlannerFolder(folderA.page.id)(usePlannerStore.getState())?.blocks ?? [],
  )).toBe('A 최신 시도');
  expect(getPage).toHaveBeenCalledWith(folderA.page.id);
});

const settlementCases = ([
  ['A1-first', 'success', 'success'],
  ['A1-first', 'success', 'failure'],
  ['A1-first', 'failure', 'success'],
  ['A1-first', 'failure', 'failure'],
  ['A2-first', 'success', 'success'],
  ['A2-first', 'success', 'failure'],
  ['A2-first', 'failure', 'success'],
  ['A2-first', 'failure', 'failure'],
] as const);

test.each(settlementCases)(
  'A→B→A %s, A1 %s, A2 %s는 최종 server canonical로 수렴한다',
  async (order, firstOutcome, secondOutcome) => {
    let serverDescription = 'A 서버';
    const gates = {
      A1: deferred<void>(),
      A2: deferred<void>(),
    };
    const reads: string[] = [];
    const getPage = jest.fn(async (pageId: string) => {
      if (pageId === folderA.page.id) reads.push(serverDescription);
      const source = pageId === folderA.page.id ? folderA : folderB;
      const text = pageId === folderA.page.id ? serverDescription : 'B 전환';
      return {
        page: source.page,
        blocks: [descriptionBlock(pageId, text)],
        stateVector: 'server',
      };
    });
    const saveFolderDescription = jest.fn((pageId: string, markdown: string) => {
      if (pageId === folderB.page.id) {
        return Promise.resolve({
          page: folderB.page, blocks: [descriptionBlock(pageId, markdown)],
        });
      }
      const gate = markdown === 'A1' ? gates.A1 : gates.A2;
      return gate.promise.then(() => {
        serverDescription = markdown;
        return { page: folderA.page, blocks: [descriptionBlock(pageId, markdown)] };
      });
    });
    const api = { getPage, plannerMutations: { saveFolderDescription } } as unknown as ApiClient;
    const actions = createPlannerActions(api);

    const pendingA1 = actions.saveFolderDescription(folderA, 'A1');
    await actions.saveFolderDescription(folderB, 'B 전환');
    const pending = {
      A1: pendingA1,
      A2: actions.saveFolderDescription(folderA, 'A2'),
    };

    const outcomes = { A1: firstOutcome, A2: secondOutcome };
    const settleOrder = order === 'A1-first' ? (['A1', 'A2'] as const) : (['A2', 'A1'] as const);
    for (const name of settleOrder) {
      if (outcomes[name] === 'success') gates[name].resolve();
      else gates[name].reject(new Error(`${name} failed`));
      await pending[name].catch(() => undefined);
    }

    expect(plannerDescriptionText(
      selectPlannerFolder(folderA.page.id)(usePlannerStore.getState())?.blocks ?? [],
    )).toBe(serverDescription);
    expect(getPlannerDescriptionMutationStateForTest(
      usePlannerStore.getState().scopeGeneration,
      folderA.page.id,
    )).toEqual({ activeTokens: [], needsRevalidation: false });
    if (order === 'A2-first' && firstOutcome === 'success' && secondOutcome === 'failure') {
      expect(reads).toEqual(['A 서버', 'A1']);
    }
  },
);

test('description 실패 복원과 targeted read는 비설명 task 필드를 보존한다', async () => {
  const pendingSave = deferred<{ page: PlannerFolder['page']; blocks: PlannerBlock[] }>();
  const serverPage = { ...folderA.page, title: '서버의 오래된 제목', version: 2, updatedAt: 'server' };
  const getPage = jest.fn().mockResolvedValue({
    page: serverPage,
    blocks: [descriptionBlock(folderA.page.id, 'A 서버')],
    stateVector: 'server',
  });
  const api = {
    getPage,
    plannerMutations: { saveFolderDescription: jest.fn(() => pendingSave.promise) },
  } as unknown as ApiClient;
  const pending = createPlannerActions(api).saveFolderDescription(folderA, 'A 실패 draft');
  const current = selectPlannerFolder(folderA.page.id)(usePlannerStore.getState())!;
  const guidance: PlannerBlock = {
    id: 'guidance', pageId: folderA.page.id, parentId: null, positionKey: 'z',
    blockType: 'guidance', text: '동시 체크리스트 지침', properties: {}, collapsed: false,
  };
  const concurrent: PlannerFolder = {
    ...current,
    page: { ...current.page, title: '동시 변경 제목' },
    blocks: [...current.blocks, guidance],
    folderSummary: {
      id: folderA.folderId, title: '동시 변경 제목',
      status: 'in_progress', archived: false, version: 3,
      itemCounts: { pending: 2, completed: 1 }, itemTotal: 3, completedItemCount: 1,
      assignee: 'roselin',
    },
    status: 'in_progress', assignee: 'roselin', contextCount: 1,
    sessions: [{
      agentSessionId: 'session-new', folderId: null, displayName: '동시 세션',
      nodeId: 'node-a', sessionType: 'interactive', status: 'running', agentId: 'roselin',
      predecessorSessionId: null, reviewState: 'not_required',
      createdAt: '', updatedAt: '',
    }],
    sessionIds: ['session-new'],
  };
  const scopeGeneration = usePlannerStore.getState().scopeGeneration;
  setPlannerProjectionForScope(scopeGeneration, replaceFolderProjection(
    capturePlannerProjection(usePlannerStore.getState()),
    concurrent,
  ));

  pendingSave.reject(new Error('description failed'));
  await expect(pending).rejects.toThrow('description failed');

  const selected = usePlannerStore.getState().selectedFolderSnapshot!;
  const listed = usePlannerStore.getState().folderChildPages['project-1']!.items
    .find((candidate) => candidate.page.id === folderA.page.id)!;
  for (const restored of [selected, listed]) {
    expect(restored.page).toMatchObject({ title: '동시 변경 제목', version: 2, updatedAt: 'server' });
    expect(restored).toMatchObject({
      status: 'in_progress', assignee: 'roselin', contextCount: 1,
      sessionIds: ['session-new'],
      sessions: [expect.objectContaining({ agentSessionId: 'session-new' })],
      folderSummary: expect.objectContaining({ itemTotal: 3, completedItemCount: 1 }),
    });
    expect(restored.blocks).toContainEqual(guidance);
    expect(plannerDescriptionText(restored.blocks)).toBe('A 서버');
  }
});
