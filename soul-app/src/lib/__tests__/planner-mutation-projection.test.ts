import type {
  PlannerPage,
  PlannerFolder,
  PlannerToday,
} from '../../api/plannerTypes';
import {
  acknowledgeFolderSessionProjection,
  capturePlannerProjection,
  completeFolderProjection,
  deleteFolderSessionProjection,
  moveFolderSessionProjection,
  renameFolderSessionProjection,
  replaceFolderProjection,
  setFolderStarredProjection,
  type PlannerProjectionState,
} from '../planner-mutation-projection';

const folderPage = page('task-1', '기존 업무');
const folder: PlannerFolder = {
  page: folderPage,
  blocks: [],
  folderId: 'task-1',
  folderSummary: {
    id: 'task-1', title: '기존 업무', status: 'open',
    archived: false, version: 1, itemCounts: {}, itemTotal: 0,
    completedItemCount: 0, assignee: null,
  },
  status: 'open', assignee: '', contextCount: 0, progress: null,
  projectPageId: 'project-1',
  sessions: [{
    agentSessionId: 'session-1', folderId: null, displayName: '기존 세션', nodeId: 'node',
    sessionType: null, status: 'completed', agentId: 'agent', predecessorSessionId: null,
    reviewState: 'none', createdAt: '', updatedAt: '',
  }],
  sessionIds: ['session-1'],
};

function page(id: string, title: string): PlannerPage {
  return { id, title, dailyDate: null, version: 1, archived: false, metadata: {}, createdAt: '', updatedAt: '' };
}

function makeState(): PlannerProjectionState {
  const daily: PlannerToday = {
    daily: { page: page('daily', 'Daily'), blocks: [], stateVector: 'sv' },
    projects: [page('project-1', '프로젝트')], memoBlocks: [], folders: [folder], attention: [], running: [], queued: [], reviewSessionIds: [],
  };
  const project = {
    project: page('project-1', '프로젝트'),
    folders: { items: [folder], nextCursor: null },
  };
  return {
    dailyByDate: { '2026-07-17': daily, '2026-07-16': { ...daily, folders: [] } },
    starred: { items: [], nextCursor: null },
    folderByPageId: { 'project-1': project },
    folderChildPages: { 'project-1': project.folders },
    folderSessionPages: { 'task-1': { items: [{ agentSessionId: 'session-1' }], nextCursor: null } },
    selectedFolderSnapshot: folder,
  };
}

test('업무 변경은 daily·project·starred·selected를 동시에 패치하고 무관 slice 참조를 보존한다', () => {
  const before = makeState();
  const renamed = { ...folder, page: { ...folder.page, title: '새 업무', metadata: { starred: true } } };
  const after = replaceFolderProjection(before, renamed);

  expect(after.dailyByDate['2026-07-17']?.folders[0]).toBe(renamed);
  expect(after.dailyByDate['2026-07-16']).toBe(before.dailyByDate['2026-07-16']);
  expect(after.folderChildPages['project-1']?.items[0]).toBe(renamed);
  expect(after.folderByPageId['project-1']?.folders.items[0]).toBe(renamed);
  expect(after.starred.items).toEqual([renamed]);
  expect(after.selectedFolderSnapshot).toBe(renamed);
  expect(after.folderSessionPages).toBe(before.folderSessionPages);
});

test('업무 완료는 task completed로 남기고 daily에서만 제거한다', () => {
  const after = completeFolderProjection(makeState(), 'task-1');
  expect(after.dailyByDate['2026-07-17']?.folders).toEqual([]);
  expect(after.folderChildPages['project-1']?.items[0]).toMatchObject({
    status: 'completed', folderSummary: { status: 'completed' },
  });
});

test('별표는 task snapshot과 starred 목록을 대칭 갱신한다', () => {
  const starred = setFolderStarredProjection(makeState(), 'task-1', true);
  expect(starred.starred.items.map((item) => item.page.id)).toEqual(['task-1']);
  const unstarred = setFolderStarredProjection(starred, 'task-1', false);
  expect(unstarred.starred.items).toEqual([]);
  expect(unstarred.selectedFolderSnapshot?.page.metadata.starred).toBe(false);
});

test('세션 rename/delete는 모든 task snapshot과 run history를 함께 갱신한다', () => {
  const renamed = renameFolderSessionProjection(makeState(), 'session-1', '새 세션');
  expect(renamed.selectedFolderSnapshot?.sessions[0].displayName).toBe('새 세션');
  expect(renamed.dailyByDate['2026-07-17']?.folders[0].sessions[0].displayName).toBe('새 세션');
  const deleted = deleteFolderSessionProjection(renamed, 'session-1');
  expect(deleted.selectedFolderSnapshot?.sessions).toEqual([]);
  expect(deleted.selectedFolderSnapshot?.sessionIds).toEqual([]);
  expect(deleted.folderSessionPages['task-1']).toMatchObject({ items: [] });
});

test('세션 이동은 원본 run history에서 제거하고 대상 업무에만 삽입한다', () => {
  const before = makeState();
  const target = {
    ...folder,
    page: { ...folder.page, id: 'task-page-2', title: '대상 업무' },
    folderId: 'task-2',
    sessions: [],
    sessionIds: [],
  };
  const projectFolders = { items: [folder, target], nextCursor: null };
  before.folderChildPages['project-1'] = projectFolders;
  before.folderByPageId['project-1'] = {
    ...before.folderByPageId['project-1']!,
    folders: projectFolders,
  };
  before.folderSessionPages['task-page-2'] = { items: [], nextCursor: null };

  const after = moveFolderSessionProjection(before, 'session-1', 'task-page-2');
  expect(after.folderChildPages['project-1']?.items[0].sessionIds).toEqual([]);
  expect(after.folderChildPages['project-1']?.items[1].sessionIds).toEqual(['session-1']);
  expect(after.folderSessionPages['task-1']?.items).toEqual([]);
  expect(after.folderSessionPages['task-page-2']?.items).toEqual([{ agentSessionId: 'session-1' }]);
});

test('검수 확인은 모든 task snapshot과 daily review 목록을 함께 갱신한다', () => {
  const before = makeState();
  before.dailyByDate['2026-07-17'] = {
    ...before.dailyByDate['2026-07-17']!,
    attention: [], running: [], queued: [],
    reviewSessionIds: ['session-1', 'session-2'],
  };

  const after = acknowledgeFolderSessionProjection(before, 'session-1');

  expect(after.selectedFolderSnapshot?.sessions[0].reviewState).toBe('acknowledged');
  expect(after.dailyByDate['2026-07-17']?.reviewSessionIds).toEqual(['session-2']);
});

test('snapshot은 복원할 slice 참조를 그대로 캡처한다', () => {
  const before = makeState();
  const snapshot = capturePlannerProjection(before);
  expect(snapshot.dailyByDate).toBe(before.dailyByDate);
  expect(snapshot.folderByPageId).toBe(before.folderByPageId);
  expect(snapshot.folderSessionPages).toBe(before.folderSessionPages);
});
