import type { PlannerFolder } from '../../api/plannerTypes';
import {
  buildMorningReviewQueue,
  dispatchMorningReviewAction,
  loadMorningReviewQueue,
} from '../morning-review';

test('PC와 같은 최근 2일·중복·오늘 배치·terminal 제외 순서로 queue를 만든다', async () => {
  const today = folder('today', '오늘 업무');
  const recent = folder('recent', '최근 업무');
  const older = folder('older', '오래된 업무');
  const completed = folder('completed', '완료 업무', 'completed');
  const api = {
    getDailyHistory: jest.fn().mockResolvedValue({ dates: ['2026-07-19', '2026-07-18'] }),
    getPlannerToday: jest.fn(async (date: string) => ({
      folders: date === '2026-07-20'
        ? [today]
        : date === '2026-07-19'
          ? [recent, today, completed]
          : [recent, older],
    })),
  };

  const queue = await loadMorningReviewQueue(api as any, '2026-07-20');

  expect(api.getDailyHistory).toHaveBeenCalledWith('2026-07-20');
  expect(queue.map((item) => [item.folder.page.id, item.sourceDate])).toEqual([
    ['recent', '2026-07-19'],
    ['older', '2026-07-18'],
  ]);
});

test('queue builder는 입력 날짜 순서가 달라도 최신순이며 첫 task identity를 보존한다', () => {
  const first = folder('same', '최신 제목');
  const duplicate = folder('same', '이전 제목');
  expect(buildMorningReviewQueue({
    todayFolderPageIds: new Set(),
    historicalDays: [
      { date: '2026-07-18', folders: [duplicate] },
      { date: '2026-07-19', folders: [first] },
    ],
  })[0]?.folder).toBe(first);
});

test.each([
  ['today', 1, 0],
  ['later', 0, 0],
  ['done', 0, 1],
] as const)('%s action은 PC와 같은 mutation 의미를 가진다', async (action, mountCalls, completeCalls) => {
  const item = { id: 'task:task-1', sourceDate: '2026-07-19', folder: folder('task-1', '업무') };
  const port = { mountToday: jest.fn(), completeFolder: jest.fn() };
  await dispatchMorningReviewAction(item, action, port);
  expect(port.mountToday).toHaveBeenCalledTimes(mountCalls);
  expect(port.completeFolder).toHaveBeenCalledTimes(completeCalls);
});

function folder(id: string, title: string, status = 'open'): PlannerFolder {
  return {
    page: { id, title, dailyDate: null, version: 1, archived: false, metadata: {}, createdAt: '', updatedAt: '' },
    blocks: [], folderId: id,
    folderSummary: {
      id, title, status, archived: false, version: 1,
      itemCounts: {}, itemTotal: 0, completedItemCount: 0, assignee: null,
    },
    status: status === 'completed' ? 'completed' : 'open',
    assignee: '', contextCount: 0, progress: null, projectPageId: null,
    sessions: [], sessionIds: [],
  };
}
