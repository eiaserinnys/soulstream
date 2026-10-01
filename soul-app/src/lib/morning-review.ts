import type { ApiClient } from '../api/client';
import type { PlannerFolder } from '../api/plannerTypes';

export type MorningReviewAction = 'today' | 'later' | 'done';

export interface MorningReviewItem {
  id: string;
  sourceDate: string;
  folder: PlannerFolder;
}

export interface MorningReviewActionPort {
  mountToday(folder: PlannerFolder): Promise<void>;
  completeFolder(folder: PlannerFolder): Promise<void>;
}

export async function loadMorningReviewQueue(
  api: Pick<ApiClient, 'getDailyHistory' | 'getPlannerToday'>,
  today: string,
): Promise<MorningReviewItem[]> {
  const { dates } = await api.getDailyHistory(today);
  const [todayPlanner, ...historicalPlanners] = await Promise.all([
    api.getPlannerToday(today),
    ...dates.map((date) => api.getPlannerToday(date)),
  ]);
  return buildMorningReviewQueue({
    todayFolderPageIds: new Set(todayPlanner.folders.map((folder) => folder.page.id)),
    historicalDays: dates.map((date, index) => ({
      date,
      folders: historicalPlanners[index]?.folders ?? [],
    })),
  });
}

export function buildMorningReviewQueue(input: {
  historicalDays: ReadonlyArray<{ date: string; folders: readonly PlannerFolder[] }>;
  todayFolderPageIds: ReadonlySet<string>;
}): MorningReviewItem[] {
  const seen = new Set<string>();
  const items: MorningReviewItem[] = [];
  const days = [...input.historicalDays]
    .sort((left, right) => right.date.localeCompare(left.date));
  for (const day of days) {
    for (const folder of day.folders) {
      if (seen.has(folder.page.id)) continue;
      seen.add(folder.page.id);
      if (input.todayFolderPageIds.has(folder.page.id) || isTerminal(folder)) continue;
      items.push({ id: `task:${folder.page.id}`, sourceDate: day.date, folder });
    }
  }
  return items;
}

export async function dispatchMorningReviewAction(
  item: MorningReviewItem,
  action: MorningReviewAction,
  port: MorningReviewActionPort,
): Promise<void> {
  if (action === 'later') return;
  if (action === 'today') {
    await port.mountToday(item.folder);
    return;
  }
  await port.completeFolder(item.folder);
}

function isTerminal(folder: PlannerFolder): boolean {
  const status = folder.folderSummary?.status;
  return status === 'completed' || status === 'cancelled' || folder.status === 'completed';
}
