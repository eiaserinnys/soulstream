export function todayPlannerMenuLabel(isInToday: boolean): string {
  return isInToday ? "오늘 플래너에서 제거" : "오늘 플래너에 추가";
}

export function visibleDailyTasks<
  Task extends { page: { id: string }; status: string },
>(
  tasks: readonly Task[],
  isTodayView: boolean,
  todayTaskIds: ReadonlySet<string>,
): Task[] {
  if (!isTodayView) return [...tasks];
  return tasks.filter((task) => (
    task.status !== "completed" && todayTaskIds.has(task.page.id)
  ));
}

export async function runOptimisticTodayMutation<Result>({
  taskId,
  wasInToday,
  optimisticInToday,
  setPresence,
  mutate,
  finalPresence,
}: {
  taskId: string;
  wasInToday: boolean;
  optimisticInToday: boolean;
  setPresence(taskId: string, present: boolean): void;
  mutate(): Promise<Result>;
  finalPresence(result: Result): boolean;
}): Promise<Result> {
  setPresence(taskId, optimisticInToday);
  try {
    const result = await mutate();
    setPresence(taskId, finalPresence(result));
    return result;
  } catch (error) {
    setPresence(taskId, wasInToday);
    throw error;
  }
}
