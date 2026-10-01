import { createPlannerMutationPort, type PlannerMutationApi } from '../plannerMutationPort';
import type { PlannerBlock, PlannerPage, PlannerFolder } from '../plannerTypes';

const page: PlannerPage = {
  id: 'task-1', title: '업무', dailyDate: null, version: 4,
  archived: false, metadata: {}, createdAt: '', updatedAt: '',
};

test('오늘 해제는 50개 다음 cursor의 업무 마운트까지 수집한다', async () => {
  const daily = pageRead('daily-1', [
    { ...block('task-mount', '[[업무]]'), pageId: 'daily-1' },
  ]);
  const getPageBacklinks = paginatedBacklinks([
    backlink('daily-1', 'task-mount'),
  ]);
  const api = apiMock({
    getDailyPage: jest.fn().mockResolvedValue({ page: daily.page, created: false }),
    getPage: jest.fn().mockResolvedValue(daily),
    getPageBacklinks,
  });

  await createPlannerMutationPort(api).setFolderToday(plannerFolder(), '2026-07-26', false);

  expectCursorExhausted(getPageBacklinks);
  expect(api.applyPageOperations).toHaveBeenCalledWith(
    'daily-1',
    expect.objectContaining({
      operations: [{ op: 'delete_block_subtree', block_id: 'task-mount' }],
    }),
  );
});

test('오늘로는 50개 초과 backlinks를 끝까지 확인한 뒤 마운트를 정확히 하나 추가한다', async () => {
  const daily = pageRead('daily-1', []);
  const getPageBacklinks = paginatedBacklinks([
    backlink('other-50', 'other-mount-50'),
  ]);
  const api = apiMock({
    getDailyPage: jest.fn().mockResolvedValue({ page: daily.page, created: false }),
    getPage: jest.fn().mockResolvedValue(daily),
    getPageBacklinks,
  });

  await createPlannerMutationPort(api).setFolderToday(plannerFolder(), '2026-07-26', true);

  expectCursorExhausted(getPageBacklinks);
  expect(api.applyPageOperations).toHaveBeenCalledTimes(1);
  expect(api.applyPageOperations).toHaveBeenCalledWith(
    'daily-1',
    expect.objectContaining({
      operations: [expect.objectContaining({
        op: 'create_block', after_block_id: null, text: '[[업무]]',
      })],
    }),
  );
});

function paginatedBacklinks(lastItems: ReturnType<typeof backlink>[]) {
  const firstPage = Array.from({ length: 50 }, (_, index) => (
    backlink(`other-${index}`, `other-mount-${index}`)
  ));
  return jest.fn()
    .mockResolvedValueOnce({ items: firstPage, nextCursor: 'cursor-2' })
    .mockResolvedValueOnce({ items: lastItems, nextCursor: null });
}

function expectCursorExhausted(getPageBacklinks: jest.Mock) {
  expect(getPageBacklinks.mock.calls).toEqual([
    ['task-1', undefined],
    ['task-1', 'cursor-2'],
  ]);
}

function apiMock(overrides: Partial<PlannerMutationApi> = {}): PlannerMutationApi {
  return {
    getPage: jest.fn().mockResolvedValue(pageRead('task-1', [])),
    getPageBacklinks: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getDailyPage: jest.fn(), applyPageOperations: jest.fn(),
    setPageStarred: jest.fn(), getFolderSnapshot: jest.fn(),
    setFolderStatus: jest.fn(), moveBoardItemToFolder: jest.fn(),
    createFolder: jest.fn(), updateFolder: jest.fn(), archiveFolder: jest.fn(), createSession: jest.fn(), renameSession: jest.fn(),
    deleteSession: jest.fn(), acknowledgeSessionReview: jest.fn(),
    ...overrides,
  };
}

function plannerFolder(): PlannerFolder {
  return {
    page, blocks: [], folderId: 'task-1',
    folderSummary: {
      id: 'task-1', title: '업무', status: 'open',
      archived: false, version: 1, itemCounts: {}, itemTotal: 0,
      completedItemCount: 0, assignee: null,
    },
    status: 'open', assignee: '', contextCount: 0, progress: null,
    projectPageId: 'project-1', sessions: [], sessionIds: [],
  };
}

function pageRead(id: string, blocks: PlannerBlock[]) {
  return { page: { ...page, id, title: id }, blocks, stateVector: `sv-${id}` };
}

function block(id: string, text: string): PlannerBlock {
  return {
    id, pageId: 'task-1', parentId: null, positionKey: '', blockType: 'paragraph',
    text, properties: {}, collapsed: false,
  };
}

function backlink(sourcePageId: string, sourceBlockId: string) {
  return {
    id: `${sourcePageId}:${sourceBlockId}`, sourcePageId, sourcePageTitle: sourcePageId,
    sourceBlockId, sourceTextPreview: '', linkKind: 'mount', targetPageId: 'task-1',
    targetBlockId: null, sourceStart: 0, sourceEnd: 1,
  };
}
