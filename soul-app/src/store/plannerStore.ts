import { create } from 'zustand';
import {
  createPlannerInvalidationCounters,
  incrementPlannerInvalidation,
  type PlannerInvalidationCounters,
  type PlannerInvalidationSource,
} from '../lib/planner-invalidation';
import type {
  PlannerPageSlice,
  PlannerFolderCollection,
  PlannerFolder,
  PlannerFolderSessionPage,
  PlannerToday,
} from '../api/plannerTypes';
import { replaceEqualDeep } from '../lib/structural-sharing';
import {
  captureAuthScope,
  subscribeAuthScope,
} from '../lib/auth-scope';

type PageMode = 'replace' | 'append';

interface PlannerStore {
  scopeGeneration: string;
  dailyByDate: Record<string, PlannerToday | undefined>;
  starred: PlannerPageSlice<PlannerFolder>;
  starredRefreshRequired: boolean;
  folderByPageId: Record<string, PlannerFolderCollection | undefined>;
  folderChildPages: Record<string, PlannerPageSlice<PlannerFolder> | undefined>;
  folderSessionPages: Record<string, PlannerFolderSessionPage | undefined>;
  selectedFolderSnapshot: PlannerFolder | null;
  loading: Record<string, boolean | undefined>;
  error: Record<string, string | null | undefined>;
  invalidation: PlannerInvalidationCounters;

  setLoading: (key: string, loading: boolean) => void;
  setError: (key: string, error: string | null) => void;
  setDaily: (date: string, daily: PlannerToday) => void;
  setStarred: (page: PlannerPageSlice<PlannerFolder>, mode: PageMode) => void;
  setStarredRefreshRequired: (required: boolean) => void;
  setProject: (pageId: string, project: PlannerFolderCollection) => void;
  setFolderChildren: (
    pageId: string,
    page: PlannerPageSlice<PlannerFolder>,
    mode: PageMode,
  ) => void;
  setFolderSessions: (pageId: string, page: PlannerFolderSessionPage, mode: PageMode) => void;
  setSelectedFolderSnapshot: (folder: PlannerFolder | null) => void;
  invalidate: (source: PlannerInvalidationSource) => void;
  resetForTest: () => void;
}

const EMPTY_PAGE = { items: [], nextCursor: null };
const folderScopes = new WeakMap<PlannerFolder, string>();

function initialState(scopeGeneration = captureAuthScope().generation) {
  return {
    scopeGeneration,
    dailyByDate: {},
    starred: EMPTY_PAGE as PlannerPageSlice<PlannerFolder>,
    starredRefreshRequired: false,
    folderByPageId: {},
    folderChildPages: {},
    folderSessionPages: {},
    selectedFolderSnapshot: null,
    loading: {},
    error: {},
    invalidation: createPlannerInvalidationCounters(),
  };
}

export const usePlannerStore = create<PlannerStore>((set) => ({
  ...initialState(),
  setLoading: (key, loading) => set((state) => ({
    loading: { ...state.loading, [key]: loading },
  })),
  setError: (key, error) => set((state) => ({
    error: { ...state.error, [key]: error },
  })),
  setDaily: (date, daily) => set((state) => {
    bindFolderList(daily.folders, state.scopeGeneration);
    const shared = replaceEqualDeep(state.dailyByDate[date], daily) as PlannerToday;
    if (shared === state.dailyByDate[date]) return state;
    return { dailyByDate: { ...state.dailyByDate, [date]: shared } };
  }),
  setStarred: (page, mode) => set((state) => {
    bindFolderList(page.items, state.scopeGeneration);
    const next = mode === 'replace'
      ? replaceEqualDeep(state.starred, page)
      : {
          items: mergeUniqueByKey(state.starred.items, page.items, (item) => item.page.id),
          nextCursor: page.nextCursor,
        };
    return next === state.starred ? state : { starred: next };
  }),
  setStarredRefreshRequired: (starredRefreshRequired) => set({ starredRefreshRequired }),
  setProject: (pageId, project) => set((state) => {
    bindFolderList(project.folders.items, state.scopeGeneration);
    const folders = replaceEqualDeep(state.folderChildPages[pageId], project.folders);
    const shared = replaceEqualDeep(state.folderByPageId[pageId], {
      ...project,
      folders,
    }) as PlannerFolderCollection;
    const sameProject = shared === state.folderByPageId[pageId];
    const sameFolders = folders === state.folderChildPages[pageId];
    if (sameProject && sameFolders) return state;
    return {
      folderByPageId: sameProject
        ? state.folderByPageId
        : { ...state.folderByPageId, [pageId]: shared },
      folderChildPages: sameFolders
        ? state.folderChildPages
        : { ...state.folderChildPages, [pageId]: folders },
    };
  }),
  setFolderChildren: (pageId, page, mode) => set((state) => {
    bindFolderList(page.items, state.scopeGeneration);
    const next = mergePage(
      state.folderChildPages[pageId], page, mode, (item) => item.page.id,
    );
    if (next === state.folderChildPages[pageId]) return state;
    return { folderChildPages: { ...state.folderChildPages, [pageId]: next } };
  }),
  setFolderSessions: (pageId, page, mode) => set((state) => {
    const previous = state.folderSessionPages[pageId];
    const next = mode === 'replace' || !previous
      ? replaceEqualDeep(previous, page)
      : {
          items: mergeUniqueByKey(
            previous.items,
            page.items,
            (item) => item.agentSessionId,
          ),
          nextCursor: page.nextCursor,
        };
    if (next === previous) return state;
    return {
      folderSessionPages: {
        ...state.folderSessionPages,
        [pageId]: next,
      },
    };
  }),
  setSelectedFolderSnapshot: (selectedFolderSnapshot) => set((state) => {
    if (selectedFolderSnapshot) bindPlannerFolderScope(selectedFolderSnapshot, state.scopeGeneration);
    return { selectedFolderSnapshot };
  }),
  invalidate: (source) => set((state) => ({
    invalidation: incrementPlannerInvalidation(state.invalidation, source),
  })),
  resetForTest: () => set(initialState()),
}));

export const selectDaily = (date: string) => (state: PlannerStore) =>
  state.dailyByDate[date];
export const selectProject = (pageId: string) => (state: PlannerStore) =>
  state.folderByPageId[pageId];
export const selectFolderChildren = (pageId: string) => (state: PlannerStore) =>
  state.folderChildPages[pageId];
export const selectFolderSessions = (pageId: string) => (state: PlannerStore) =>
  state.folderSessionPages[pageId];
export const selectPlannerFolder = (pageId: string) => (state: PlannerStore) => {
  if (state.selectedFolderSnapshot?.page.id === pageId) {
    return state.selectedFolderSnapshot;
  }
  for (const daily of Object.values(state.dailyByDate)) {
    const folder = daily?.folders.find((candidate) => candidate.page.id === pageId);
    if (folder) return folder;
  }
  for (const page of Object.values(state.folderChildPages)) {
    const folder = page?.items.find((candidate) => candidate.page.id === pageId);
    if (folder) return folder;
  }
  const starred = state.starred.items.find((candidate) => candidate.page.id === pageId);
  if (starred) return starred;
  return undefined;
};
export const selectPlannerPage = (pageId: string) => (state: PlannerStore) => (
  selectPlannerFolder(pageId)(state)?.page
);

subscribeAuthScope((scope) => {
  usePlannerStore.setState(initialState(scope.generation));
});

export function bindPlannerFolderScope(
  folder: PlannerFolder,
  generation = captureAuthScope().generation,
): void {
  folderScopes.set(folder, generation);
}

export function isPlannerFolderInCurrentScope(folder: PlannerFolder): boolean {
  const generation = folderScopes.get(folder);
  return generation === undefined || generation === captureAuthScope().generation;
}

export function isPlannerStoreScopeCurrent(generation: string): boolean {
  return usePlannerStore.getState().scopeGeneration === generation
    && captureAuthScope().generation === generation;
}

export function setPlannerProjectionForScope(
  generation: string,
  state: Partial<PlannerStore>,
): boolean {
  if (!isPlannerStoreScopeCurrent(generation)) return false;
  bindProjectionFolders(state, generation);
  usePlannerStore.setState(state);
  return true;
}

function bindFolderList(folders: readonly PlannerFolder[], generation: string): void {
  for (const folder of folders) bindPlannerFolderScope(folder, generation);
}

function bindProjectionFolders(state: Partial<PlannerStore>, generation: string): void {
  if (state.selectedFolderSnapshot) bindPlannerFolderScope(state.selectedFolderSnapshot, generation);
  for (const daily of Object.values(state.dailyByDate ?? {})) {
    if (daily) bindFolderList(daily.folders, generation);
  }
  for (const page of Object.values(state.folderChildPages ?? {})) {
    if (page) bindFolderList(page.items, generation);
  }
  if (state.starred) bindFolderList(state.starred.items, generation);
}

export function mergeUniqueByKey<T>(
  current: readonly T[],
  incoming: readonly T[],
  key: (item: T) => string,
): T[] {
  const incomingByKey = new Map(incoming.map((item) => [key(item), item]));
  const result = current.map((item) => {
    const candidate = incomingByKey.get(key(item));
    return candidate === undefined ? item : replaceEqualDeep(item, candidate);
  });
  const existing = new Set(current.map(key));
  for (const item of incoming) {
    if (!existing.has(key(item))) result.push(item);
  }
  return result;
}

function mergePage<T>(
  previous: PlannerPageSlice<T> | undefined,
  page: PlannerPageSlice<T>,
  mode: PageMode,
  key: (item: T) => string,
): PlannerPageSlice<T> {
  if (mode === 'replace' || !previous) {
    return replaceEqualDeep(previous, page) as PlannerPageSlice<T>;
  }
  return {
    items: mergeUniqueByKey(previous.items, page.items, key),
    nextCursor: page.nextCursor,
  };
}
