import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { retainEqualValue } from "@seosoyoung/soul-ui";
import type { PageDto } from "../../../packages/page-model/src/types";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";

import type { PlannerLoadState } from "./PlannerViews";
import {
  beginPlannerLoad,
  completePlannerLoad,
  failPlannerLoad,
  loadConfirmedResult,
} from "./planner-query-state";
import type { FolderStarChange } from "./folder-star-store";
import {
  loadTodayPlanner,
  loadFolderSubfolderPage,
  loadStarredFolders,
  loadFolderPlanner,
  starredFolderPage,
  type TodayPlannerData,
  type PlannerDataDependencies,
  type PlannerPage,
  type FolderPlannerData,
  type StarredPlannerFolder,
} from "./planner-data";
import {
  applyStarredPlannerFolderChanges,
  isStarredPlannerPageCurrent,
  mergeStarredPlannerFolders,
} from "./starred-planner-collection";
import {
  isStarredFolderRefreshCurrent,
  isStarredFolderRequestCurrent,
  isStarredFolderSnapshotCurrent,
} from "./starred-folder-order";
import { useStarredFolderReorder } from "./use-starred-folder-reorder";
import { useV3PageInvalidationKey } from "./v3-live-invalidation-plane";


export function usePlannerCollections({
  api,
  dependencies,
  selectedProject,
  selectedFolderId,
  folderStarChanges,
  refreshKeys,
  notify,
}: {
  api: PageApiClient;
  dependencies: PlannerDataDependencies;
  selectedProject: PageDto | null;
  selectedFolderId: string | null;
  folderStarChanges: readonly FolderStarChange[];
  refreshKeys: {
    daily: number;
    project: number;
    starred: number;
  };
  notify(message: string): void;
}) {
  const [todayData, setTodayData] = useState<PlannerLoadState<TodayPlannerData>>({ status: "loading", data: null, message: null });
  const [project, setProject] = useState<PlannerLoadState<FolderPlannerData>>({ status: "loading", data: null, message: null });
  const [starredFolderIndex, setStarredFolderIndex] = useState<PlannerLoadState<PlannerPage<StarredPlannerFolder>>>({ status: "loading", data: null, message: null });
  const [starredLoadedRefreshKey, setStarredLoadedRefreshKey] = useState<number | null>(null);
  const [starredFoldersLoadingMore, setStarredFoldersLoadingMore] = useState(false);
  const [subfoldersLoadingMore, setSubfoldersLoadingMore] = useState(false);
  const [mutationRefresh, setMutationRefresh] = useState({ project: 0 });
  const pendingReads = useRef(new Set<Promise<unknown>>());
  const trackRead = useCallback(<T,>(read: Promise<T>): Promise<T> => {
    pendingReads.current.add(read);
    void read.finally(() => pendingReads.current.delete(read)).catch(() => undefined);
    return read;
  }, []);
  const waitForReads = useCallback(async () => {
    await Promise.all([...pendingReads.current]);
  }, []);
  const projectRef = useRef(project);
  const starredFolderIndexRef = useRef(starredFolderIndex);
  const starredRefreshKeyRef = useRef(refreshKeys.starred);
  const starredLoadedRefreshKeyRef = useRef<number | null>(null);
  const starredOrderRevisionRef = useRef(0);
  const stableStarredFoldersRef = useRef<StarredPlannerFolder[]>([]);
  projectRef.current = project;
  starredFolderIndexRef.current = starredFolderIndex;
  starredRefreshKeyRef.current = refreshKeys.starred;

  const projectPageRefreshKey = useV3PageInvalidationKey([
    selectedProject?.id,
    project.data?.project.id,
  ]);

  useEffect(() => {
    let active = true;
    const refreshKey = refreshKeys.starred;
    const orderRevision = starredOrderRevisionRef.current;
    const hadCurrentSnapshot = isStarredFolderSnapshotCurrent({
      loadedRefreshKey: starredLoadedRefreshKeyRef.current,
      expectedRefreshKey: refreshKey,
      currentRefreshKey: starredRefreshKeyRef.current,
      expectedOrderRevision: orderRevision,
      currentOrderRevision: starredOrderRevisionRef.current,
    });
    starredLoadedRefreshKeyRef.current = null;
    setStarredLoadedRefreshKey(null);
    const previous = starredFolderIndexRef.current.data;
    setStarredFolderIndex(beginPlannerLoad);
    void trackRead(loadConfirmedResult({
      previous,
      load: () => loadStarredFolders(dependencies, {}),
      clearsVisibleContent: (current, next) => current.items.length > 0 && next.items.length === 0,
    })).then((data) => {
      if (active && isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) {
        starredLoadedRefreshKeyRef.current = refreshKey;
        setStarredLoadedRefreshKey(refreshKey);
        setStarredFolderIndex((current) => isStarredFolderRequestCurrent({
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        }) ? completePlannerLoad(current, data) : current);
      }
    }).catch((error: unknown) => {
      if (active && isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) {
        if (hadCurrentSnapshot || isStarredFolderSnapshotCurrent({
          loadedRefreshKey: starredLoadedRefreshKeyRef.current,
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        })) {
          starredLoadedRefreshKeyRef.current = refreshKey;
          setStarredLoadedRefreshKey(refreshKey);
          setStarredFolderIndex((current) => current.data
            ? completePlannerLoad(current, current.data)
            : current);
          return;
        }
        starredLoadedRefreshKeyRef.current = null;
        setStarredLoadedRefreshKey(null);
        const message = errorText(error);
        setStarredFolderIndex((current) => {
          const failed = failPlannerLoad(current, message);
          return failed.data
            ? { ...failed, data: { ...failed.data, nextCursor: null } }
            : failed;
        });
        notify(`별표 폴더 조회 실패 · ${message}`);
      }
    });
    return () => { active = false; };
  }, [dependencies, notify, refreshKeys.starred]);

  useEffect(() => {
    let active = true;
    setTodayData(beginPlannerLoad);
    void trackRead(loadTodayPlanner(dependencies)).then((data) => {
      if (active) setTodayData((current) => completePlannerLoad(current, data));
    }).catch((error: unknown) => {
      if (active) setTodayData((current) => failPlannerLoad(current, errorText(error)));
    });
    return () => { active = false; };
  }, [dependencies, refreshKeys.daily, trackRead]);

  const projects = useMemo(() => selectedProject ? [selectedProject] : [], [selectedProject]);
  const starredFolders = useMemo(() => {
    const next = applyStarredPlannerFolderChanges(starredFolderIndex.data?.items ?? [], folderStarChanges);
    stableStarredFoldersRef.current = retainEqualValue(stableStarredFoldersRef.current, next);
    return stableStarredFoldersRef.current;
  }, [starredFolderIndex.data?.items, folderStarChanges]);

  useEffect(() => {
    if (!selectedProject || !selectedFolderId) return;
    let active = true;
    setSubfoldersLoadingMore(false);
    const previous = projectRef.current.data?.project.id === selectedProject.id
      ? projectRef.current.data
      : null;
    setProject((current) => current.data?.project.id === selectedProject.id
      ? beginPlannerLoad(current)
      : { status: "loading", data: null, message: null });
    void trackRead(loadConfirmedResult({
      previous,
      load: () => loadFolderPlanner(api, selectedFolderId, selectedProject, dependencies),
      clearsVisibleContent: (current, next) => current.subfolders.length > 0 && next.subfolders.length === 0,
    })).then((data) => {
      if (active) setProject((current) => completePlannerLoad(current, data));
    }).catch((error: unknown) => {
      if (active) setProject((current) => failPlannerLoad(current, errorText(error)));
    });
    return () => { active = false; };
  }, [api, dependencies, mutationRefresh.project, projectPageRefreshKey, refreshKeys.project, selectedFolderId, selectedProject]);

  const { starredFoldersReordering, reorderStarredFolders } = useStarredFolderReorder({
    dependencies,
    notify,
    starredFolderIndexRef,
    starredLoadedRefreshKeyRef,
    starredOrderRevisionRef,
    setStarredLoadedRefreshKey,
    starredRefreshKeyRef,
    stableStarredFoldersRef,
    setStarredFolderIndex,
  });

  const refreshFolder = useCallback((folderId: string) => {
    if (selectedProject?.id === folderId) {
      setMutationRefresh((current) => ({ ...current, project: current.project + 1 }));
    }
  }, [selectedProject?.id]);

  const loadMoreStarredFolders = useCallback(async () => {
    const page = starredFolderIndex.data;
    const cursor = page?.nextCursor;
    if (
      !page
      || !cursor
      || starredFoldersLoadingMore
      || !isStarredFolderRefreshCurrent(starredLoadedRefreshKeyRef.current, starredRefreshKeyRef.current)
    ) return;
    const expectedPageIds = page.items.map((task) => starredFolderPage(task).id);
    const refreshKey = starredRefreshKeyRef.current;
    const orderRevision = starredOrderRevisionRef.current;
    setStarredFoldersLoadingMore(true);
    try {
      const next = await loadStarredFolders(dependencies, { cursor });
      if (!isStarredFolderRequestCurrent({
        expectedRefreshKey: refreshKey,
        currentRefreshKey: starredRefreshKeyRef.current,
        expectedOrderRevision: orderRevision,
        currentOrderRevision: starredOrderRevisionRef.current,
      })) return;
      setStarredFolderIndex((current) => {
        if (!isStarredFolderRequestCurrent({
          expectedRefreshKey: refreshKey,
          currentRefreshKey: starredRefreshKeyRef.current,
          expectedOrderRevision: orderRevision,
          currentOrderRevision: starredOrderRevisionRef.current,
        })) return current;
        const currentPage = current.data;
        if (!isStarredPlannerPageCurrent(currentPage, expectedPageIds, cursor) || !currentPage) {
          return current;
        }
        return completePlannerLoad(current, {
          items: mergeStarredPlannerFolders(currentPage.items, next.items),
          nextCursor: next.nextCursor,
        });
      });
    } catch (error) {
      notify(`별표 폴더 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setStarredFoldersLoadingMore(false);
    }
  }, [dependencies, notify, starredFolderIndex.data, starredFoldersLoadingMore]);

  const loadMoreSubfolders = useCallback(async () => {
    const data = project.data;
    if (!selectedFolderId || !data?.nextSubfolderCursor || subfoldersLoadingMore) return;
    setSubfoldersLoadingMore(true);
    try {
      const page = await loadFolderSubfolderPage(dependencies, selectedFolderId, data.nextSubfolderCursor);
      setProject((current) => current.data?.project.id === data.project.id
        ? completePlannerLoad(current, {
          ...current.data,
          subfolders: [...new Map([...current.data.subfolders, ...page.items].map((folder) => [folder.id, folder])).values()],
          nextSubfolderCursor: page.nextCursor,
        })
        : current);
    } catch (error) {
      notify(`하위 폴더 더 보기 실패 · ${errorText(error)}`);
    } finally {
      setSubfoldersLoadingMore(false);
    }
  }, [dependencies, notify, project.data, selectedFolderId, subfoldersLoadingMore]);

  return {
    waitForReads,
    todayData,
    project,
    projects,
    selectedProject,
    starredFolders,
    starredFoldersHasMore: Boolean(starredFolderIndex.data?.nextCursor)
      && isStarredFolderRefreshCurrent(starredLoadedRefreshKey, refreshKeys.starred),
    starredFoldersLoading: (starredFolderIndex.status === "loading" && !starredFolderIndex.data)
      || !isStarredFolderRefreshCurrent(starredLoadedRefreshKey, refreshKeys.starred),
    starredFoldersLoadingMore,
    starredFoldersReordering,
    subfoldersLoadingMore,
    loadMoreStarredFolders,
    reorderStarredFolders,
    loadMoreSubfolders,
    refreshFolder,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
