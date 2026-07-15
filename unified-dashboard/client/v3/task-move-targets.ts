import type { PageApiClient, PageDto } from "@seosoyoung/soul-ui/page";

import { classifyMountedPage } from "./planner-model";

const TASK_MOVE_SEARCH_LIMIT = 8;

export interface TaskMoveTarget {
  page: PageDto;
  runbookId: string;
}

export function defaultTaskMoveTargets(
  targets: readonly TaskMoveTarget[],
  currentRunbookId: string,
): TaskMoveTarget[] {
  return [...new Map(
    targets
      .filter((target) => target.runbookId !== currentRunbookId)
      .map((target) => [target.runbookId, target]),
  ).values()];
}

export async function searchTaskMoveTargets(
  api: PageApiClient,
  query: string,
  currentRunbookId: string,
): Promise<TaskMoveTarget[]> {
  const normalized = query.trim();
  if (!normalized) return [];
  const result = await api.searchPages(normalized, TASK_MOVE_SEARCH_LIMIT);
  const snapshots = await Promise.all(
    result.items.map((item) => api.getPage(item.pageId)),
  );
  const targets = snapshots.flatMap((snapshot) => {
    const classification = classifyMountedPage(snapshot.blocks);
    if (classification.kind !== "task") return [];
    return [{ page: snapshot.page, runbookId: classification.runbookId }];
  });
  return defaultTaskMoveTargets(targets, currentRunbookId);
}
