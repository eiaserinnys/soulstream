import { createPlannerMutationPort, type PlannerMutationApi } from '../plannerMutationPort';
import type { PlannerBlock, PlannerPage, PlannerFolder } from '../plannerTypes';
import { ApiHttpError } from '../clientCore';

const page: PlannerPage = {
  id: 'task-1', title: '업무', dailyDate: null, version: 4,
  archived: false, metadata: {}, createdAt: '', updatedAt: '',
};
const blocks: PlannerBlock[] = [
  block('description', '기존 설명', 'paragraph', {}),
  block('mount', '[[문서]]', 'paragraph', {}),
  block('context', '컨텍스트', 'context', { kind: 'context' }),
];

function block(
  id: string,
  text: string,
  blockType: string,
  properties: Record<string, unknown>,
): PlannerBlock {
  return {
    id, pageId: 'task-1', parentId: null, positionKey: '',
    blockType, text, properties, collapsed: false,
  };
}

function apiMock(overrides: Partial<PlannerMutationApi> = {}): PlannerMutationApi {
  return {
    getPage: jest.fn().mockResolvedValue({ page, blocks, stateVector: 'AQID' }),
    getPageBacklinks: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getDailyPage: jest.fn(),
    applyPageOperations: jest.fn().mockResolvedValue({
      page, blocks, operation: { id: 'op' }, tempIdMapping: {}, idempotent: false,
    }),
    setPageStarred: jest.fn(),
    getFolderSnapshot: jest.fn().mockResolvedValue({ folder: { id: 'task-1', version: 1 }, cards: [], }),
    setFolderStatus: jest.fn(),
    moveBoardItemToFolder: jest.fn(),
    createFolder: jest.fn(),
    updateFolder: jest.fn(),
    archiveFolder: jest.fn(),
    createSession: jest.fn(),
    renameSession: jest.fn(),
    deleteSession: jest.fn(),
    acknowledgeSessionReview: jest.fn(),
    ...overrides,
  };
}

test('설명 저장은 mount·context를 보존하고 page write 계약을 사용한다', async () => {
  const api = apiMock();
  const port = createPlannerMutationPort(api);

  await port.saveFolderDescription('task-1', '새 설명');

  expect(api.applyPageOperations).toHaveBeenCalledWith('task-1', expect.objectContaining({
    expectedVersion: 4,
    expectedStateVector: 'AQID',
    idempotencyKey: expect.stringMatching(/^soul-app-v3-folder-description-/),
    operations: [{ op: 'update_block_text', block_id: 'description', text: '새 설명' }],
  }));
});

test('설명 저장은 session_defaults·guidance·atom_ref·task_ref에 연산을 만들지 않는다', async () => {
  const protectedBlocks = [
    block('defaults', '', 'session_defaults', { agentId: 'roselin', nodeId: 'eiaserinnys' }),
    block('guidance', '검수 원칙', 'guidance', { enabled: true }),
    block('atom', '', 'atom_ref', { nodeId: 'node-a' }),
    block('folder', '', 'folder_ref', { folderId: 'task-1' }),
  ];
  const api = apiMock({
    getPage: jest.fn().mockResolvedValue({
      page,
      blocks: [block('description', '기존 설명', 'paragraph', {}), ...protectedBlocks],
      stateVector: 'AQID',
    }),
  });

  await createPlannerMutationPort(api).saveFolderDescription('task-1', '새 설명');

  const operations = (api.applyPageOperations as jest.Mock).mock.calls[0][1].operations;
  expect(operations).toEqual([
    { op: 'update_block_text', block_id: 'description', text: '새 설명' },
  ]);
  expect(operations.filter((operation: { block_id?: string }) => (
    protectedBlocks.some((protectedBlock) => protectedBlock.id === operation.block_id)
  ))).toEqual([]);
});

test('여러 설명 root는 제출 본문 한 블록으로 수렴하고 보호 블록은 보존한다', async () => {
  const protectedBlocks = [
    block('mount', '[[문서]]', 'paragraph', {}),
    block('guidance', '검수 원칙', 'guidance', { enabled: true }),
  ];
  const api = apiMock({
    getPage: jest.fn().mockResolvedValue({
      page,
      blocks: [
        block('description-a', '기존 설명 A', 'paragraph', {}),
        block('description-b', '기존 설명 B', 'checklist', {}),
        ...protectedBlocks,
      ],
      stateVector: 'AQID',
    }),
  });

  await createPlannerMutationPort(api).saveFolderDescription('task-1', '새 설명');

  const operations = (api.applyPageOperations as jest.Mock).mock.calls[0][1].operations;
  expect(operations).toEqual([
    { op: 'update_block_text', block_id: 'description-a', text: '새 설명' },
    { op: 'delete_block_subtree', block_id: 'description-b' },
  ]);
  expect(operations.filter((operation: { block_id?: string }) => (
    protectedBlocks.some((protectedBlock) => protectedBlock.id === operation.block_id)
  ))).toEqual([]);
});

test('업무 완료는 delete가 아니라 canonical task completed 표면만 호출한다', async () => {
  const api = apiMock();
  const port = createPlannerMutationPort(api);
  const folder = {
    page,
    blocks,
    folderId: 'task-1',
    folderSummary: {
      id: 'task-1', title: '업무', status: 'open', archived: false,
      version: 7, createdSessionId: null, createdEventId: null, createdAt: '', updatedAt: '',
      itemCounts: {}, itemTotal: 0, completedItemCount: 0, assignee: null,
    },
    status: 'open', assignee: '', contextCount: 0, progress: null,
    projectPageId: 'project-1', sessions: [], sessionIds: [],
  } as PlannerFolder;

  await port.completeFolder(folder);

  expect(api.setFolderStatus).toHaveBeenCalledWith(
    'task-1',
    'completed',
    7,
    expect.stringMatching(/^soul-app-v3-folder-complete-/),
  );
  expect(api.deleteSession).not.toHaveBeenCalled();
});

test('업무 mutation은 task 작업에 folderId, 페이지 작업에 page.id를 사용한다', async () => {
  const api = apiMock();
  const port = createPlannerMutationPort(api);
  const linked = {
    ...plannerFolder(),
    page: { ...page, id: 'page-id' },
    folderId: 'task-id',
    folderSummary: {
      ...plannerFolder().folderSummary!,
      id: 'task-id',
    },
  };

  await port.completeFolder(linked);
  await port.saveFolderDescription(linked.page.id, '새 설명');
  await port.createFolderSession({
    folder: linked,
    prompt: '계속 진행',
    modelPreset: 'server-preset',
    pageAnchor: { pageId: linked.page.id, blockId: 'anchor-1', expectedVersion: 5 },
    attachmentPaths: ['/uploads/image-a.png'],
  });

  expect(api.setFolderStatus).toHaveBeenCalledWith(
    'task-id',
    'completed',
    1,
    expect.stringMatching(/^soul-app-v3-folder-complete-/),
  );
  expect(api.applyPageOperations).toHaveBeenCalledWith(
    'page-id',
    expect.any(Object),
  );
  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
    folderId: 'task-id',
    modelPreset: 'server-preset',
    pageAnchor: { pageId: 'page-id', blockId: 'anchor-1', expectedVersion: 5 },
    attachmentPaths: ['/uploads/image-a.png'],
    extraContextItems: [expect.objectContaining({
      content: { pageId: 'page-id', folderId: 'task-id' },
    })],
  }));
});

test('오늘 데일리 해제는 같은 제목이 있어도 업무 pageId의 마운트만 삭제한다', async () => {
  const unrelatedMount = {
    ...block('unrelated-mount', '[[업무]]', 'paragraph', {}),
    pageId: 'daily-1',
  };
  const folderMount = {
    ...block('task-mount', '[[업무]]', 'paragraph', {}),
    pageId: 'daily-1',
  };
  const daily = pageRead('daily-1', [unrelatedMount, folderMount]);
  const api = apiMock({
    getDailyPage: jest.fn().mockResolvedValue({ page: daily.page, created: false }),
    getPage: jest.fn().mockResolvedValue(daily),
    getPageBacklinks: jest.fn().mockResolvedValue({
      items: [{
        linkKind: 'mount',
        sourcePageId: 'daily-1',
        sourceBlockId: 'task-mount',
        targetPageId: 'task-1',
      }],
      nextCursor: null,
    }),
  });

  await createPlannerMutationPort(api).setFolderToday(plannerFolder(), '2026-07-26', false);

  expect(api.applyPageOperations).toHaveBeenCalledWith(
    'daily-1',
    expect.objectContaining({
      operations: [{ op: 'delete_block_subtree', block_id: 'task-mount' }],
    }),
  );
});

test('새 세션 page anchor는 version conflict 409 뒤 fresh page로 정확히 한 번 재시도한다', async () => {
  const current = pageRead('task-1', []);
  const fresh = {
    ...pageRead('task-1', [block('new-root', '새 root', 'paragraph', {})]),
    page: { ...page, version: 5 },
    stateVector: 'FRESH',
  };
  const conflict = versionConflict('first conflict');
  const applyPageOperations = jest.fn()
    .mockRejectedValueOnce(conflict)
    .mockImplementationOnce((_pageId, input) => Promise.resolve({
      page: { ...page, version: 6 },
      blocks: fresh.blocks,
      operation: { id: 'op' },
      tempIdMapping: { [input.operations[0].temp_id]: 'anchor-1' },
      idempotent: false,
    }));
  const api = apiMock({
    getPage: jest.fn()
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(fresh),
    applyPageOperations,
  });

  await expect(createPlannerMutationPort(api).createPageAnchor('task-1')).resolves.toEqual({
    pageId: 'task-1',
    blockId: 'anchor-1',
    expectedVersion: 6,
  });

  expect(api.getPage).toHaveBeenCalledTimes(2);
  expect(applyPageOperations).toHaveBeenCalledTimes(2);
  expect(applyPageOperations.mock.calls[0][1]).toMatchObject({
    expectedVersion: 4,
    expectedStateVector: 'sv-task-1',
  });
  expect(applyPageOperations.mock.calls[1][1]).toMatchObject({
    expectedVersion: 5,
    expectedStateVector: 'FRESH',
    operations: [expect.objectContaining({ after_block_id: 'new-root' })],
  });
});

test('새 세션 page anchor의 두 번째 version conflict 409는 그대로 표면화한다', async () => {
  const secondConflict = versionConflict('second conflict');
  const api = apiMock({
    getPage: jest.fn()
      .mockResolvedValueOnce(pageRead('task-1', []))
      .mockResolvedValueOnce({
        ...pageRead('task-1', []),
        page: { ...page, version: 5 },
      }),
    applyPageOperations: jest.fn()
      .mockRejectedValueOnce(versionConflict('first conflict'))
      .mockRejectedValueOnce(secondConflict),
  });

  await expect(createPlannerMutationPort(api).createPageAnchor('task-1'))
    .rejects.toBe(secondConflict);
  expect(api.getPage).toHaveBeenCalledTimes(2);
  expect(api.applyPageOperations).toHaveBeenCalledTimes(2);
});

test.each([
  [409, 'PAGE_MUTATION_STATE_VECTOR_CONFLICT'],
  [500, 'PAGE_BROWSER_OPERATION_FAILED'],
])('새 세션 page anchor는 version conflict가 아닌 HTTP %i를 재시도하지 않는다', async (status, code) => {
  const serverError = new ApiHttpError('server failed', status, JSON.stringify({
    detail: { error: { code } },
  }));
  const api = apiMock({
    applyPageOperations: jest.fn().mockRejectedValue(serverError),
  });

  await expect(createPlannerMutationPort(api).createPageAnchor('task-1'))
    .rejects.toBe(serverError);
  expect(api.getPage).toHaveBeenCalledTimes(1);
  expect(api.applyPageOperations).toHaveBeenCalledTimes(1);
});

test.each([undefined, '', '   '])('folderId=%p이면 createSession 네트워크 호출 전에 실패한다', async (folderId) => {
  const api = apiMock();
  const invalid = { ...plannerFolder(), folderId } as unknown as PlannerFolder;

  await expect(createPlannerMutationPort(api).createFolderSession({
    folder: invalid,
    prompt: '계속 진행',
  })).rejects.toThrow('폴더 ID가 없습니다.');
  expect(api.createSession).not.toHaveBeenCalled();
});

test('폴더 이동은 parentFolderId와 현재 folder version을 사용한다', async () => {
  const api = apiMock();
  await createPlannerMutationPort(api).moveFolderParent(plannerFolder(), {
    folderId: 'folder-2', projectPageId: 'project-2',
  });
  expect(api.updateFolder).toHaveBeenCalledWith('task-1', expect.objectContaining({
    parentFolderId: 'folder-2', expectedVersion: 1,
    idempotencyKey: expect.stringMatching(/^soul-app-v3-folder-move-/),
  }));
});

test('새 폴더를 만들고 선택하면 오늘 page에 마운트한다', async () => {
  const daily = pageRead('daily-1', []);
  const api = apiMock({
    createFolder: jest.fn().mockResolvedValue({
      folder: { id: 'folder-new', version: 1 }, operation: { id: 'op' }, idempotent: false,
    }),
    getDailyPage: jest.fn().mockResolvedValue({ page: daily.page, created: false }),
    getPage: jest.fn().mockResolvedValue(daily),
  });
  await createPlannerMutationPort(api).createFolder({
    title: '새 폴더', description: '', folderId: 'folder-1',
    projectPageId: 'project-1', dailyDate: '2026-07-17',
    initialContext: { guidance: '직접 지침', atomReferences: [] },
  });
  expect(api.createFolder).toHaveBeenCalledWith(expect.objectContaining({
    name: '새 폴더', parentFolderId: 'folder-1',
    initialContext: expect.objectContaining({ guidance: '직접 지침' }),
  }));
  expect(api.getPage).toHaveBeenCalledWith('daily-1');
});

function plannerFolder(): PlannerFolder {
  return {
    page,
    blocks,
    folderId: 'task-1',
    folderSummary: {
      id: 'task-1', title: '업무', status: 'open',
      archived: false, version: 1, itemCounts: {}, itemTotal: 0,
      completedItemCount: 0, assignee: null,
    },
    status: 'open', assignee: '', contextCount: 0, progress: null,
    projectPageId: 'project-1', sessions: [], sessionIds: [],
  };
}

function pageRead(id: string, pageBlocks: PlannerBlock[]) {
  return {
    page: { ...page, id, title: id },
    blocks: pageBlocks,
    stateVector: `sv-${id}`,
  };
}

function versionConflict(message: string) {
  return new ApiHttpError(message, 409, JSON.stringify({
    detail: { error: { code: 'PAGE_MUTATION_VERSION_CONFLICT' } },
  }));
}

test('reasoningEffort를 createSession 요청으로 그대로 전달한다', async () => {
  const api = apiMock();

  await createPlannerMutationPort(api).createFolderSession({
    folder: plannerFolder(),
    prompt: '계속 진행',
    modelPreset: 'claude-opus',
    reasoningEffort: 'low',
  });

  expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
    modelPreset: 'claude-opus',
    reasoningEffort: 'low',
  }));
});

test('reasoningEffort가 없으면 요청에서 생략하여 노드가 preset 기본값을 적용한다', async () => {
  const api = apiMock();

  await createPlannerMutationPort(api).createFolderSession({
    folder: plannerFolder(),
    prompt: '계속 진행',
    modelPreset: 'claude-opus',
  });

  expect((api.createSession as jest.Mock).mock.calls[0]?.[0])
    .not.toHaveProperty('reasoningEffort');
});

test('생성 성공 뒤 오늘 반영 실패는 같은 생성 결과와 페이지 요청으로 재개한다', async () => {
  const result = { folder: { id: 'new-folder' } };
  const api = apiMock({ createFolder: jest.fn().mockResolvedValue(result),
    getDailyPage: jest.fn().mockResolvedValue({ page }),
    applyPageOperations: jest.fn().mockRejectedValueOnce(new Error('응답 유실')).mockResolvedValue({ page }) });
  const port = createPlannerMutationPort(api);
  const input = { title: '새 폴더', description: '설명', folderId: 'parent', projectPageId: 'parent-page', dailyDate: '2026-10-03',
    creation: { idempotencyKey: 'stable-folder-key' } };
  await expect(port.createFolder(input)).rejects.toThrow('응답 유실');
  await expect(port.createFolder(input)).resolves.toEqual(result);
  expect(api.createFolder).toHaveBeenCalledTimes(1);
  expect(api.createFolder).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'stable-folder-key' }));
  expect((api.applyPageOperations as jest.Mock).mock.calls[1]).toEqual((api.applyPageOperations as jest.Mock).mock.calls[0]);
});
