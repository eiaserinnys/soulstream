import {
  useCallback,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { PlannerLoadState } from "./PlannerViews";
import { completePlannerLoad } from "./planner-query-state";
import {
  loadStarredTasks,
  starredTaskPage,
  type PlannerDataDependencies,
  type PlannerPage,
  type StarredPlannerTask,
} from "./planner-data";
import {
  disableStarredTaskPaginationAfterRefreshFailure,
  isStarredTaskBoundaryCurrent,
  isStarredTaskRequestCurrent,
  isStarredTaskRefreshCurrent,
  isStarredTaskSnapshotCurrent,
  reconcileStarredTaskOrderReloadFailure,
  resolveStarredTaskBeforePageId,
  saveStarredTaskOrderAndReload,
} from "./starred-task-order";

type StarredTaskIndex = PlannerLoadState<PlannerPage<StarredPlannerTask>>;

interface CurrentRef<T> {
  current: T;
}

export function useStarredTaskReorder({
  dependencies,
  notify,
  starredTaskIndexRef,
  starredLoadedRefreshKeyRef,
  starredOrderRevisionRef,
  setStarredLoadedRefreshKey,
  starredRefreshKeyRef,
  stableStarredTasksRef,
  setStarredTaskIndex,
}: {
  dependencies: PlannerDataDependencies;
  notify(message: string): void;
  starredTaskIndexRef: CurrentRef<StarredTaskIndex>;
  starredLoadedRefreshKeyRef: CurrentRef<number | null>;
  starredOrderRevisionRef: CurrentRef<number>;
  setStarredLoadedRefreshKey: Dispatch<SetStateAction<number | null>>;
  starredRefreshKeyRef: CurrentRef<number>;
  stableStarredTasksRef: CurrentRef<StarredPlannerTask[]>;
  setStarredTaskIndex: Dispatch<SetStateAction<StarredTaskIndex>>;
}) {
  const [starredTasksReordering, setStarredTasksReordering] = useState(false);

  const reorderStarredTasks = useCallback(async (
    movedPageId: string,
    orderedPageIds: readonly string[],
  ) => {
    if (!isStarredTaskRefreshCurrent(starredLoadedRefreshKeyRef.current, starredRefreshKeyRef.current)) {
      notify("별표 업무 목록을 새로고침하는 중이라 순서 변경을 잠시 기다려 주세요.");
      return;
    }
    const original = starredTaskIndexRef.current;
    const data = original.data;
    const refreshKey = starredRefreshKeyRef.current;
    const orderRevision = starredOrderRevisionRef.current;
    const visibleTasks = stableStarredTasksRef.current;
    const visibleIds = visibleTasks.map((task) => starredTaskPage(task).id);
    const baseIds = data?.items.map((task) => starredTaskPage(task).id) ?? [];
    const saveOrder = dependencies.saveStarredTaskOrder;
    if (
      !data
      || !saveOrder
      || !samePageIds(visibleIds, baseIds)
      || orderedPageIds.length !== visibleIds.length
      || new Set(orderedPageIds).size !== visibleIds.length
      || orderedPageIds.some((pageId) => !visibleIds.includes(pageId))
    ) {
      await reloadFirstStarredPageIfCurrent({
        dependencies,
        starredLoadedRefreshKeyRef,
        starredOrderRevisionRef,
        setStarredLoadedRefreshKey,
        starredRefreshKeyRef,
        setStarredTaskIndex,
      });
      notify("별표 목록이 갱신 중이라 순서를 바꾸지 못했습니다. 목록을 새로 불러왔습니다.");
      return;
    }
    if (samePageIds(visibleIds, orderedPageIds)) return;

    const tasksById = new Map(visibleTasks.map((task) => [starredTaskPage(task).id, task]));
    const reorderedTasks = orderedPageIds.map((pageId) => tasksById.get(pageId)!);
    setStarredTasksReordering(true);

    let beforePageId: string | null;
    try {
      beforePageId = await resolveStarredTaskBeforePageId({
        orderedPageIds,
        movedPageId,
        nextCursor: data.nextCursor,
        fetchBoundaryPage: async (cursor) => {
          const next = await loadStarredTasks(dependencies, { cursor });
          const latestData = starredTaskIndexRef.current.data;
          if (
            !latestData
            || !isStarredTaskBoundaryCurrent({
              expectedRefreshKey: refreshKey,
              currentRefreshKey: starredRefreshKeyRef.current,
              expectedOrderRevision: orderRevision,
              currentOrderRevision: starredOrderRevisionRef.current,
              expectedCursor: data.nextCursor,
              currentCursor: latestData.nextCursor,
              expectedPageIds: visibleIds,
              currentPageIds: latestData.items.map((task) => starredTaskPage(task).id),
            })
          ) throw new Error("별표 목록 경계가 변경되었습니다.");
          return {
            pageIds: next.items.map((task) => starredTaskPage(task).id),
            nextCursor: next.nextCursor,
          };
        },
      });
    } catch (error) {
      await reloadFirstStarredPageIfCurrent({
        dependencies,
        starredLoadedRefreshKeyRef,
        starredOrderRevisionRef,
        setStarredLoadedRefreshKey,
        starredRefreshKeyRef,
        setStarredTaskIndex,
      });
      notify(`별표 목록의 다음 페이지를 확인하지 못해 순서를 취소했습니다 · ${errorText(error)}`);
      setStarredTasksReordering(false);
      return;
    }

    const latestData = starredTaskIndexRef.current.data;
    if (
      !latestData
      || !isStarredTaskBoundaryCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
        expectedCursor: data.nextCursor,
        currentCursor: latestData.nextCursor,
        expectedPageIds: visibleIds,
        currentPageIds: latestData.items.map((task) => starredTaskPage(task).id),
      })
    ) {
      await reloadFirstStarredPageIfCurrent({
        dependencies,
        starredLoadedRefreshKeyRef,
        starredOrderRevisionRef,
        setStarredLoadedRefreshKey,
        starredRefreshKeyRef,
        setStarredTaskIndex,
      });
      notify("별표 목록이 이동 중 갱신되어 순서를 취소했습니다. 목록을 다시 불러왔습니다.");
      setStarredTasksReordering(false);
      return;
    }

    setStarredTaskIndex((current) => current.data
      ? { ...current, data: { ...current.data, items: reorderedTasks } }
      : current);

    let reloadRefreshKey: number | null = null;
    let reloadOrderRevision: number | null = null;
    const result = await saveStarredTaskOrderAndReload({
      save: async () => {
        starredOrderRevisionRef.current += 1;
        starredLoadedRefreshKeyRef.current = null;
        setStarredLoadedRefreshKey(null);
        try {
          await saveOrder(movedPageId, beforePageId);
        } finally {
          starredOrderRevisionRef.current += 1;
          starredLoadedRefreshKeyRef.current = null;
          setStarredLoadedRefreshKey(null);
        }
      },
      reload: async () => {
        reloadRefreshKey = starredRefreshKeyRef.current;
        reloadOrderRevision = starredOrderRevisionRef.current;
        return await loadStarredTasks(dependencies, {});
      },
      isReloadCurrent: () => reloadRefreshKey !== null
        && reloadOrderRevision !== null
        && isStarredTaskRequestCurrent({
          expectedRefreshKey: reloadRefreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: reloadOrderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        }),
    });
    const reloadRecovery = result.reloadError
      ? await reloadFirstStarredPageIfCurrent({
        dependencies,
        starredLoadedRefreshKeyRef,
        starredOrderRevisionRef,
        setStarredLoadedRefreshKey,
        starredRefreshKeyRef,
        setStarredTaskIndex,
      })
      : null;
    const reloadedPage = result.reloaded;
    const completedRefreshKey = reloadRefreshKey;
    const completedOrderRevision = reloadOrderRevision;
    if (
      reloadedPage
      && completedRefreshKey !== null
      && completedOrderRevision !== null
      && isStarredTaskRequestCurrent({
        expectedRefreshKey: completedRefreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: completedOrderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })
    ) {
      starredLoadedRefreshKeyRef.current = completedRefreshKey;
      setStarredLoadedRefreshKey(completedRefreshKey);
      setStarredTaskIndex((current) => isStarredTaskRequestCurrent({
        expectedRefreshKey: completedRefreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: completedOrderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      }) ? completePlannerLoad(current, reloadedPage) : current);
    }
    if (
      !result.reloaded
      && (result.reloadSuperseded || (!result.saved && result.reloadError && reloadRecovery !== "loaded"))
    ) {
      setStarredTaskIndex((current) => {
        const recoveredPage = reconcileStarredTaskOrderReloadFailure({
          currentPage: current.data,
          originalPage: original.data,
          saved: result.saved,
          reloadSuperseded: Boolean(result.reloadSuperseded) || reloadRecovery === "superseded",
          loadedRefreshKey: starredLoadedRefreshKeyRef.current,
          currentRefreshKey: starredRefreshKeyRef.current,
        });
        if (!recoveredPage) return current;
        return { ...(result.saved ? current : original), data: recoveredPage };
      });
    }
    if (!result.saved) {
      notify(`별표 순서 저장 실패 · ${errorText(result.saveError)}`);
    } else if (result.reloadError && reloadRecovery === "failed") {
      notify(`별표 순서는 저장됐지만 목록을 새로 불러오지 못했습니다 · ${errorText(result.reloadError)}`);
    }
    setStarredTasksReordering(false);
  }, [dependencies, notify, setStarredTaskIndex, setStarredLoadedRefreshKey, stableStarredTasksRef, starredLoadedRefreshKeyRef, starredOrderRevisionRef, starredRefreshKeyRef, starredTaskIndexRef]);

  return { starredTasksReordering, reorderStarredTasks };
}

function samePageIds(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length
    && first.every((pageId, index) => pageId === second[index]);
}

async function reloadFirstStarredPageIfCurrent({
  dependencies,
  starredLoadedRefreshKeyRef,
  starredOrderRevisionRef,
  setStarredLoadedRefreshKey,
  starredRefreshKeyRef,
  setStarredTaskIndex,
}: {
  dependencies: PlannerDataDependencies;
  starredLoadedRefreshKeyRef: CurrentRef<number | null>;
  starredOrderRevisionRef: CurrentRef<number>;
  setStarredLoadedRefreshKey: Dispatch<SetStateAction<number | null>>;
  starredRefreshKeyRef: CurrentRef<number>;
  setStarredTaskIndex: Dispatch<SetStateAction<StarredTaskIndex>>;
}): Promise<"loaded" | "superseded" | "failed"> {
  const refreshKey = starredRefreshKeyRef.current;
  const orderRevision = starredOrderRevisionRef.current;
  const hadCurrentSnapshot = isStarredTaskSnapshotCurrent({
    loadedRefreshKey: starredLoadedRefreshKeyRef.current,
    expectedRefreshKey: refreshKey,
    currentRefreshKey: starredRefreshKeyRef.current,
    expectedOrderRevision: orderRevision,
    currentOrderRevision: starredOrderRevisionRef.current,
  });
  starredLoadedRefreshKeyRef.current = null;
  setStarredLoadedRefreshKey(null);
  try {
    const fresh = await loadStarredTasks(dependencies, {});
    if (!isStarredTaskRequestCurrent({
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    })) return "superseded";
    starredLoadedRefreshKeyRef.current = refreshKey;
    setStarredLoadedRefreshKey(refreshKey);
    setStarredTaskIndex((current) => isStarredTaskRequestCurrent({
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    })
      ? completePlannerLoad(current, fresh)
      : current);
    return "loaded";
  } catch {
    if (!isStarredTaskRequestCurrent({
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    })) return "superseded";
    if (hadCurrentSnapshot || isStarredTaskSnapshotCurrent({
      loadedRefreshKey: starredLoadedRefreshKeyRef.current,
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    })) {
      starredLoadedRefreshKeyRef.current = refreshKey;
      setStarredLoadedRefreshKey(refreshKey);
      setStarredTaskIndex((current) => current.data
        ? completePlannerLoad(current, current.data)
        : current);
      return "loaded";
    }
    starredLoadedRefreshKeyRef.current = null;
    setStarredLoadedRefreshKey(null);
    setStarredTaskIndex((current) => current.data
      ? {
        ...current,
        data: disableStarredTaskPaginationAfterRefreshFailure(current.data),
      }
      : current);
    return "failed";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
