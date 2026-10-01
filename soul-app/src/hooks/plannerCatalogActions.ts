import type { ApiClient } from '../api/client';
import type { Folder } from '../api/types';
import {
  isSessionStoreScopeCurrent,
  setSessionProjectionForScope,
  useSessionStore,
} from '../store/sessionStore';
import {
  isPlannerStoreScopeCurrent,
  setPlannerProjectionForScope,
  usePlannerStore,
} from '../store/plannerStore';
import { useUIStore } from '../store/uiStore';
import { pendingId } from './plannerActionModels';

export function createPlannerCatalogActions(
  requireApi: () => ApiClient,
  scopeGeneration?: string,
) {
  const isCurrent = () => (
    scopeGeneration === undefined || (
      isPlannerStoreScopeCurrent(scopeGeneration)
      && isSessionStoreScopeCurrent(scopeGeneration)
    )
  );
  return {
    createRootFolder: (name: string) => catalogTransaction(
      () => {
        const temp: Folder = { id: pendingId('project'), name: name.trim(), sortOrder: 0 };
        const catalog = useSessionStore.getState().catalog;
        useSessionStore.setState({ catalog: { ...catalog, folders: [...catalog.folders, temp] } });
        return temp.id;
      },
      () => requireApi().plannerMutations.createRootFolder(name),
      (created, tempId) => replaceCatalogFolder(tempId, created.folder),
      { isCurrent, scopeGeneration },
    ),

    renameFolder: (folderId: string, name: string) => catalogTransaction(
      () => {
        const projectPageId = projectPageIdForFolder(folderId);
        patchCatalogFolder(folderId, (folder) => ({ ...folder, name: name.trim() }));
        if (projectPageId) patchPlannerProjectTitle(projectPageId, name.trim(), scopeGeneration);
      },
      () => requireApi().plannerMutations.renameFolder(folderId, name),
      () => { if (isCurrent()) usePlannerStore.getState().invalidate('page'); },
      { isCurrent, scopeGeneration },
    ),

    archiveFolder: (folderId: string, version: number) => catalogTransaction(
      () => {
        const projectPageId = projectPageIdForFolder(folderId);
        patchCatalogFolder(folderId, (folder) => ({ ...folder, archived: true }));
        const ui = useUIStore.getState();
        if (ui.activeSection.kind === 'project' && ui.activeSection.folderId === folderId) {
          ui.setActiveSection({ kind: 'daily', date: ui.todayDate });
        }
        if (projectPageId) removePlannerProject(projectPageId, scopeGeneration);
      },
      () => requireApi().plannerMutations.archiveFolder(folderId, version),
      undefined,
      { isCurrent, scopeGeneration },
    ),
  };
}

function sessionSnapshot() {
  const state = useSessionStore.getState();
  return {
    sessions: state.sessions,
    catalog: state.catalog,
    catalogReady: state.catalogReady,
    feedSessionIds: state.feedSessionIds,
    sessionChangeSerial: state.sessionChangeSerial,
    lastChangedSessionId: state.lastChangedSessionId,
    activeSection: useUIStore.getState().activeSection,
    planner: {
      folderByPageId: usePlannerStore.getState().folderByPageId,
      folderChildPages: usePlannerStore.getState().folderChildPages,
    },
  };
}

async function catalogTransaction<TSnapshot, TResult>(
  project: () => TSnapshot,
  mutate: () => Promise<TResult>,
  merge?: (result: TResult, snapshot: TSnapshot) => void,
  lifecycle: {
    isCurrent(): boolean;
    scopeGeneration?: string;
  } = { isCurrent: () => true },
) {
  if (!lifecycle.isCurrent()) throw new Error('인증 범위가 변경되어 이전 프로젝트 요청을 취소했습니다.');
  const before = sessionSnapshot();
  const snapshot = project();
  try {
    const result = await mutate();
    if (lifecycle.isCurrent()) merge?.(result, snapshot);
    return result;
  } catch (error) {
    if (lifecycle.isCurrent()) {
      const { activeSection, planner, ...session } = before;
      if (lifecycle.scopeGeneration) {
        setSessionProjectionForScope(lifecycle.scopeGeneration, session);
      } else {
        useSessionStore.setState(session);
      }
      if (lifecycle.scopeGeneration) {
        setPlannerProjectionForScope(lifecycle.scopeGeneration, planner);
      } else {
        usePlannerStore.setState(planner);
      }
      useUIStore.getState().setActiveSection(activeSection);
    }
    throw error;
  }
}

function projectPageIdForFolder(folderId: string): string | null {
  return useSessionStore.getState().catalog.folders
    .find((folder) => folder.id === folderId)?.projectPageId ?? null;
}

function patchPlannerProjectTitle(
  projectPageId: string,
  title: string,
  scopeGeneration?: string,
) {
  const state = usePlannerStore.getState();
  const project = state.folderByPageId[projectPageId];
  if (!project || project.project.title === title) return;
  const projection = {
    folderByPageId: {
      ...state.folderByPageId,
      [projectPageId]: {
        ...project,
        project: { ...project.project, title },
      },
    },
  };
  if (scopeGeneration) setPlannerProjectionForScope(scopeGeneration, projection);
  else usePlannerStore.setState(projection);
}

function removePlannerProject(projectPageId: string, scopeGeneration?: string) {
  const state = usePlannerStore.getState();
  const projection = {
    folderByPageId: omitKey(state.folderByPageId, projectPageId),
    folderChildPages: omitKey(state.folderChildPages, projectPageId),
  };
  if (scopeGeneration) setPlannerProjectionForScope(scopeGeneration, projection);
  else usePlannerStore.setState(projection);
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function patchCatalogFolder(id: string, transform: (folder: Folder) => Folder) {
  const catalog = useSessionStore.getState().catalog;
  useSessionStore.setState({
    catalog: {
      ...catalog,
      folders: catalog.folders.map((folder) => folder.id === id ? transform(folder) : folder),
    },
  });
}

function replaceCatalogFolder(tempId: string, created: Folder) {
  const catalog = useSessionStore.getState().catalog;
  useSessionStore.setState({
    catalog: {
      ...catalog,
      folders: catalog.folders.map((folder) => folder.id === tempId ? created : folder),
    },
  });
}
