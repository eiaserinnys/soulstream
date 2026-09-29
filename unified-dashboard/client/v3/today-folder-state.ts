export function todayPlannerMenuLabel(isInToday: boolean): string {
  return isInToday ? "오늘 플래너에서 제거" : "오늘 플래너에 추가";
}

export function visibleDailyTasks<
  Task extends { page: { id: string }; status: string },
>(
  tasks: readonly Task[],
  isTodayView: boolean,
  todayFolderIds: ReadonlySet<string>,
): Task[] {
  if (!isTodayView) return [...tasks];
  return tasks.filter((task) => (
    task.status !== "completed" && todayFolderIds.has(task.page.id)
  ));
}

export async function runOptimisticTodayMutation<Result>({
  folderId,
  wasInToday,
  optimisticInToday,
  setPresence,
  mutate,
  finalPresence,
}: {
  folderId: string;
  wasInToday: boolean;
  optimisticInToday: boolean;
  setPresence(folderId: string, present: boolean): void;
  mutate(): Promise<Result>;
  finalPresence(result: Result): boolean;
}): Promise<Result> {
  setPresence(folderId, optimisticInToday);
  try {
    const result = await mutate();
    setPresence(folderId, finalPresence(result));
    return result;
  } catch (error) {
    setPresence(folderId, wasInToday);
    throw error;
  }
}
