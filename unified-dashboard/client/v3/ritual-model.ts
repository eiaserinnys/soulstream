import type { PageDto } from "@seosoyoung/soul-ui/page";

import type { PlannerTask } from "./planner-data";

export interface HistoricalRitualDay {
  date: string;
  pageId: string;
  tasks: readonly PlannerTask[];
}

export interface RitualTaskItem {
  kind: "task";
  id: string;
  title: string;
  description: string;
  agentLabel: string;
  sourceDate: string;
  sourcePageId: string;
  task: PlannerTask;
}

export type RitualQueueItem = RitualTaskItem;
export type RitualAction = "today" | "remove";

export interface RitualActionPort {
  mountToday(input: { taskTitle: string }): Promise<void>;
  removeFromDaily(input: { dailyPageId: string; taskTitle: string }): Promise<void>;
}

export interface BuildMorningRitualQueueInput {
  historicalDays: readonly HistoricalRitualDay[];
  todayTaskPageIds: ReadonlySet<string>;
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
  const seenTaskPageIds = new Set<string>();
  const taskItems: RitualTaskItem[] = [];
  const orderedDays = [...input.historicalDays]
    .sort((left, right) => right.date.localeCompare(left.date));

  for (const day of orderedDays) {
    for (const task of day.tasks) {
      if (seenTaskPageIds.has(task.page.id)) continue;
      seenTaskPageIds.add(task.page.id);
      if (input.todayTaskPageIds.has(task.page.id) || isTerminalTask(task)) continue;
      taskItems.push({
        kind: "task",
        id: `task:${task.page.id}`,
        title: task.page.title,
        description: `${displayDate(day.date)} 플래너에 남아 있는 업무입니다. 오늘로 이월할까요?`,
        agentLabel: task.assignee,
        sourceDate: day.date,
        sourcePageId: day.pageId,
        task,
      });
    }
  }

  return taskItems;
}

export async function dispatchRitualAction(
  item: RitualQueueItem,
  action: RitualAction,
  port: RitualActionPort,
): Promise<void> {
  if (action === "today") {
    await port.mountToday({
      taskTitle: item.task.page.title,
    });
    return;
  }
  if (action === "remove") {
    await port.removeFromDaily({
      dailyPageId: item.sourcePageId,
      taskTitle: item.task.page.title,
    });
    return;
  }
  throw new Error("미완 업무에서 사용할 수 없는 아침 정리 동작입니다");
}

function isTerminalTask(task: PlannerTask): boolean {
  const taskStatus = task.task?.task.status as string | null | undefined;
  return taskStatus === "completed"
    || taskStatus === "cancelled"
    || task.status === "completed";
}

function displayDate(date: string): string {
  return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" })
    .format(new Date(`${date}T12:00:00`));
}
