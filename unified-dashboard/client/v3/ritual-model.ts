import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerFolder } from "./planner-data";

export interface HistoricalRitualDay {
  date: string;
  pageId: string;
  tasks: readonly PlannerFolder[];
}

export interface RitualFolderItem {
  kind: "task";
  id: string;
  title: string;
  description: string;
  agentLabel: string;
  sourceDate: string;
  sourcePageId: string;
  task: PlannerFolder;
}

export type RitualQueueItem = RitualFolderItem;
export type RitualAction = "today" | "remove";

export interface RitualActionPort {
  mountToday(input: { folderPageId: string; folderTitle: string }): Promise<void>;
  removeFromDaily(input: {
    dailyPageId: string;
    folderPageId: string;
    folderTitle: string;
  }): Promise<void>;
}

export interface BuildMorningRitualQueueInput {
  historicalDays: readonly HistoricalRitualDay[];
  todayFolderPageIds: ReadonlySet<string>;
}

export function selectHistoricalDailyDates(
  pages: readonly Pick<PageDto, "daily_date">[],
  today: string,
): string[] {
  return [...new Set(pages.flatMap((page) => (
    page.daily_date && page.daily_date < today ? [page.daily_date] : []
  )))]
    .sort((left, right) => right.localeCompare(left))
    .slice(0, 2);
}

export function buildMorningRitualQueue(
  input: BuildMorningRitualQueueInput,
): RitualQueueItem[] {
  const seenFolderPageIds = new Set<string>();
  const folderItems: RitualFolderItem[] = [];
  const orderedDays = [...input.historicalDays]
    .sort((left, right) => right.date.localeCompare(left.date));

  for (const day of orderedDays) {
    for (const task of day.tasks) {
      if (seenFolderPageIds.has(task.page.id)) continue;
      seenFolderPageIds.add(task.page.id);
      if (input.todayFolderPageIds.has(task.page.id) || isTerminalFolder(task)) continue;
      folderItems.push({
        kind: "task",
        id: `task:${task.page.id}`,
        title: task.page.title,
        description: `${displayDate(day.date)} 플래너에 남아 있는 폴더입니다. 오늘로 이월할까요?`,
        agentLabel: task.assignee,
        sourceDate: day.date,
        sourcePageId: day.pageId,
        task,
      });
    }
  }

  return folderItems;
}

export async function dispatchRitualAction(
  item: RitualQueueItem,
  action: RitualAction,
  port: RitualActionPort,
): Promise<void> {
  if (action === "today") {
    await port.mountToday({
      folderPageId: item.task.page.id,
      folderTitle: item.task.page.title,
    });
    return;
  }
  if (action === "remove") {
    await port.removeFromDaily({
      dailyPageId: item.sourcePageId,
      folderPageId: item.task.page.id,
      folderTitle: item.task.page.title,
    });
    return;
  }
  throw new Error("미완 폴더에서 사용할 수 없는 아침 정리 동작입니다");
}

function isTerminalFolder(task: PlannerFolder): boolean {
  const folderStatus = task.status;
  return folderStatus === "completed";
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" })
    .format(new Date(`${date}T12:00:00`));
}
