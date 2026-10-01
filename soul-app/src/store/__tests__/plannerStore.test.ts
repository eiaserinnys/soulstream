import {
  mergeUniqueByKey,
  selectPlannerPage,
  selectPlannerFolder,
  usePlannerStore,
} from '../plannerStore';

beforeEach(() => {
  usePlannerStore.getState().resetForTest();
});
test('cursor append는 기존 순서를 보존하고 같은 ID를 중복 추가하지 않는다', () => {
  expect(mergeUniqueByKey(
    [{ id: 'a', value: 1 }, { id: 'b', value: 1 }],
    [{ id: 'b', value: 2 }, { id: 'c', value: 1 }],
    (item) => item.id,
  )).toEqual([
    { id: 'a', value: 1 },
    { id: 'b', value: 2 },
    { id: 'c', value: 1 },
  ]);
});

test('중요 작업 full-task pagination은 중복 없이 병합되고 starred-only task를 직접 연다', () => {
  const makeFolder = (id: string, title: string) => ({
    page: { id, title },
    blocks: [{ id: `${id}-block`, type: 'paragraph', text: title }],
  }) as any;
  const first = makeFolder('starred-a', '처음');
  const updated = makeFolder('starred-a', '갱신');
  const starredOnly = makeFolder('starred-only', '중요 전용');

  usePlannerStore.getState().setStarred({
    items: [first],
    nextCursor: 'next-1',
  }, 'replace');
  usePlannerStore.getState().setStarred({
    items: [updated, starredOnly],
    nextCursor: null,
  }, 'append');

  const state = usePlannerStore.getState();
  expect(state.starred.items.map((folder) => folder.page.id)).toEqual([
    'starred-a',
    'starred-only',
  ]);
  expect(state.starred.items[0]?.page.title).toBe('갱신');
  expect(selectPlannerFolder('starred-only')(state)).toBe(starredOnly);
  expect(selectPlannerPage('starred-only')(state)).toBe(starredOnly.page);
});

test('slice refresh는 해당 project task slice만 교체한다', () => {
  const store = usePlannerStore.getState();
  store.setFolderChildren('project-a', { items: [], nextCursor: null }, 'replace');
  store.setFolderChildren('project-b', { items: [], nextCursor: 'b-next' }, 'replace');
  store.setFolderChildren('project-a', { items: [], nextCursor: 'a-next' }, 'replace');

  expect(usePlannerStore.getState().folderChildPages).toEqual({
    'project-a': { items: [], nextCursor: 'a-next' },
    'project-b': { items: [], nextCursor: 'b-next' },
  });
});

test('내용 동등 refetch는 daily·project·starred 참조를 유지한다', () => {
  const daily = {
    daily: { page: { id: 'daily' }, blocks: [], stateVector: 'sv' },
    projects: [], memoBlocks: [{ id: 'memo', text: '메모' }],
    folders: [{ page: { id: 'task', title: '업무' }, blocks: [] }],
    reviewSessionIds: [],
  } as any;
  const project = {
    project: { id: 'project', title: '프로젝트' },
    folders: { items: daily.folders, nextCursor: null },
  } as any;
  const starred = {
    items: daily.folders,
    nextCursor: null,
  } as any;
  const store = usePlannerStore.getState();
  store.setDaily('2026-07-17', daily);
  store.setProject('project', project);
  store.setStarred(starred, 'replace');
  const before = usePlannerStore.getState();

  store.setDaily('2026-07-17', structuredClone(daily));
  store.setProject('project', structuredClone(project));
  store.setStarred(structuredClone(starred), 'replace');
  const after = usePlannerStore.getState();

  expect(after.dailyByDate).toBe(before.dailyByDate);
  expect(after.dailyByDate['2026-07-17']).toBe(daily);
  expect(after.folderByPageId).toBe(before.folderByPageId);
  expect(after.folderByPageId.project).toBe(before.folderByPageId.project);
  expect(after.starred).toBe(before.starred);
});

test('부분 변경 refetch는 바뀐 경로만 교체하고 동등한 자식 참조는 유지한다', () => {
  const daily = {
    daily: { page: { id: 'daily' }, blocks: [], stateVector: 'sv' },
    projects: [], memoBlocks: [{ id: 'memo', text: '메모' }],
    folders: [{ page: { id: 'task', title: '업무' }, blocks: [] }],
    reviewSessionIds: [],
  } as any;
  usePlannerStore.getState().setDaily('2026-07-17', daily);

  usePlannerStore.getState().setDaily('2026-07-17', {
    ...structuredClone(daily),
    reviewSessionIds: ['session-1'],
  });
  const after = usePlannerStore.getState().dailyByDate['2026-07-17']!;

  expect(after).not.toBe(daily);
  expect(after.memoBlocks).toBe(daily.memoBlocks);
  expect(after.folders).toBe(daily.folders);
  expect(after.reviewSessionIds).toEqual(['session-1']);
});
