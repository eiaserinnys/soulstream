import type {
  PlannerPage,
  PlannerPageSlice,
  PlannerFolderCollection,
  PlannerSessionSummary,
  PlannerFolder,
  PlannerFolderSessionPage,
  PlannerToday,
} from '../api/plannerTypes';
import {
  mapIfChanged,
  mapRecord,
  removeById,
  replaceById,
  upsertById,
} from './planner-projection-helpers';

export interface PlannerProjectionState {
  dailyByDate: Record<string, PlannerToday | undefined>;
  starred: PlannerPageSlice<PlannerFolder>;
  folderByPageId: Record<string, PlannerFolderCollection | undefined>;
  folderChildPages: Record<string, PlannerPageSlice<PlannerFolder> | undefined>;
  folderSessionPages: Record<string, PlannerFolderSessionPage | undefined>;
  selectedFolderSnapshot: PlannerFolder | null;
}

export type PlannerProjectionSnapshot = PlannerProjectionState;

export function capturePlannerProjection(
  state: PlannerProjectionState,
): PlannerProjectionSnapshot {
  return {
    dailyByDate: state.dailyByDate,
    starred: state.starred,
    folderByPageId: state.folderByPageId,
    folderChildPages: state.folderChildPages,
    folderSessionPages: state.folderSessionPages,
    selectedFolderSnapshot: state.selectedFolderSnapshot,
  };
}

export function replaceFolderProjection(
  state: PlannerProjectionState,
  folder: PlannerFolder,
): PlannerProjectionState {
  const folderPageId = folder.page.id;
  const dailyByDate = mapRecord(state.dailyByDate, (daily) => daily
    ? replaceDailyFolder(daily, folder)
    : daily);
  const folderChildPages = mapRecord(state.folderChildPages, (page) => page
    ? replaceFolderPage(page, folder)
    : page);
  const folderByPageId = mapRecord(state.folderByPageId, (project) => project
    ? replaceProjectFolder(project, folder)
    : project);
  const starredItems = folder.page.metadata.starred === true
    ? upsertById(state.starred.items, folder, (item) => item.page.id)
    : removeById(state.starred.items, folderPageId, (item) => item.page.id);
  const starred = starredItems === state.starred.items
    ? state.starred
    : { ...state.starred, items: starredItems };
  return {
    ...state,
    dailyByDate,
    folderChildPages,
    folderByPageId,
    starred,
    selectedFolderSnapshot: state.selectedFolderSnapshot?.page.id === folderPageId
      ? folder
      : state.selectedFolderSnapshot,
  };
}

export function insertFolderProjection(
  state: PlannerProjectionState,
  folder: PlannerFolder,
  dailyDate?: string,
): PlannerProjectionState {
  let next = replaceFolderProjection(state, folder);
  if (folder.projectPageId) {
    next = insertFolderIntoParent(next, folder.projectPageId, folder);
  }
  if (dailyDate) {
    next = setFolderDailyMembership(next, dailyDate, folder, true);
  }
  return next;
}

export function removeFolderProjection(
  state: PlannerProjectionState,
  folderPageId: string,
): PlannerProjectionState {
  const dailyByDate = mapRecord(state.dailyByDate, (daily) => daily
    ? removeDailyFolder(daily, folderPageId)
    : daily);
  const folderChildPages = mapRecord(state.folderChildPages, (page) => {
    if (!page) return page;
    const items = removeById(page.items, folderPageId, (item) => item.page.id);
    return items === page.items ? page : { ...page, items };
  });
  const folderByPageId = mapRecord(state.folderByPageId, (project) => {
    if (!project) return project;
    const items = removeById(project.folders.items, folderPageId, (item) => item.page.id);
    return items === project.folders.items
      ? project
      : { ...project, folders: { ...project.folders, items } };
  });
  const starredItems = removeById(state.starred.items, folderPageId, (item) => item.page.id);
  return {
    ...state,
    dailyByDate,
    folderChildPages,
    folderByPageId,
    starred: starredItems === state.starred.items
      ? state.starred
      : { ...state.starred, items: starredItems },
    selectedFolderSnapshot: state.selectedFolderSnapshot?.page.id === folderPageId
      ? null
      : state.selectedFolderSnapshot,
  };
}

export function completeFolderProjection(
  state: PlannerProjectionState,
  folderPageId: string,
): PlannerProjectionState {
  const folder = findPlannerFolderProjection(state, folderPageId);
  if (!folder) return state;
  const completed: PlannerFolder = {
    ...folder,
    status: 'completed',
    folderSummary: folder.folderSummary ? { ...folder.folderSummary, status: 'completed' } : null,
  };
  const replaced = replaceFolderProjection(state, completed);
  return {
    ...replaced,
    dailyByDate: mapRecord(replaced.dailyByDate, (daily) => daily
      ? removeDailyFolder(daily, folderPageId)
      : daily),
  };
}

export function setFolderDailyMembership(
  state: PlannerProjectionState,
  date: string,
  folder: PlannerFolder,
  present: boolean,
): PlannerProjectionState {
  const daily = state.dailyByDate[date];
  if (!daily) return state;
  const folders = present
    ? upsertById(daily.folders, folder, (item) => item.page.id)
    : removeById(daily.folders, folder.page.id, (item) => item.page.id);
  if (folders === daily.folders) return state;
  return {
    ...state,
    dailyByDate: { ...state.dailyByDate, [date]: { ...daily, folders } },
  };
}

export function moveFolderParentProjection(
  state: PlannerProjectionState,
  folderPageId: string,
  targetProjectPageId: string,
): PlannerProjectionState {
  const folder = findPlannerFolderProjection(state, folderPageId);
  if (!folder || folder.projectPageId === targetProjectPageId) return state;
  const moved = { ...folder, projectPageId: targetProjectPageId };
  const source = folder.projectPageId;
  let next = replaceFolderProjection(state, moved);
  if (source) next = removeFolderFromParent(next, source, folderPageId);
  return insertFolderIntoParent(next, targetProjectPageId, moved);
}

export function setFolderStarredProjection(
  state: PlannerProjectionState,
  folderPageId: string,
  starred: boolean,
): PlannerProjectionState {
  const folder = findPlannerFolderProjection(state, folderPageId);
  if (!folder) return state;
  return replaceFolderProjection(state, {
    ...folder,
    page: {
      ...folder.page,
      metadata: { ...folder.page.metadata, starred },
    },
  });
}

export function patchFolderBlocksProjection(
  state: PlannerProjectionState,
  folderPageId: string,
  blocks: PlannerFolder['blocks'],
): PlannerProjectionState {
  const folder = findPlannerFolderProjection(state, folderPageId);
  return folder ? replaceFolderProjection(state, { ...folder, blocks }) : state;
}

export function patchProjectPageProjection(
  state: PlannerProjectionState,
  projectPageId: string,
  page: PlannerPage,
): PlannerProjectionState {
  const project = state.folderByPageId[projectPageId];
  if (!project) return state;
  return {
    ...state,
    folderByPageId: {
      ...state.folderByPageId,
      [projectPageId]: { ...project, project: page },
    },
  };
}

export function addFolderSessionProjection(
  state: PlannerProjectionState,
  folderPageId: string,
  session: PlannerSessionSummary,
): PlannerProjectionState {
  const folder = findPlannerFolderProjection(state, folderPageId);
  if (!folder) return state;
  const sessions = upsertById(folder.sessions, session, (item) => item.agentSessionId);
  const sessionIds = folder.sessionIds.includes(session.agentSessionId)
    ? folder.sessionIds
    : [...folder.sessionIds, session.agentSessionId];
  const runPage = state.folderSessionPages[folderPageId];
  return {
    ...replaceFolderProjection(state, { ...folder, sessions, sessionIds }),
    folderSessionPages: runPage
      ? {
          ...state.folderSessionPages,
          [folderPageId]: {
            ...runPage,
            items: upsertById(
              runPage.items,
              { agentSessionId: session.agentSessionId },
              (item) => item.agentSessionId,
            ),
          },
        }
      : state.folderSessionPages,
  };
}

export function renameFolderSessionProjection(
  state: PlannerProjectionState,
  sessionId: string,
  displayName: string | null,
): PlannerProjectionState {
  return mapAllFolders(state, (folder) => {
    const sessions = mapIfChanged(folder.sessions, (session) =>
      session.agentSessionId === sessionId ? { ...session, displayName } : session);
    return sessions === folder.sessions ? folder : { ...folder, sessions };
  });
}

export function deleteFolderSessionProjection(
  state: PlannerProjectionState,
  sessionId: string,
): PlannerProjectionState {
  const withoutSession = mapAllFolders(state, (folder) => {
    const sessions = removeById(folder.sessions, sessionId, (item) => item.agentSessionId);
    const sessionIds = removeById(folder.sessionIds, sessionId, (item) => item);
    return sessions === folder.sessions && sessionIds === folder.sessionIds
      ? folder
      : { ...folder, sessions, sessionIds };
  });
  return {
    ...withoutSession,
    folderSessionPages: mapRecord(withoutSession.folderSessionPages, (page) => {
      if (!page) return page;
      const items = removeById(page.items, sessionId, (item) => item.agentSessionId);
      return items === page.items ? page : { ...page, items };
    }),
  };
}

export function moveFolderSessionProjection(
  state: PlannerProjectionState,
  sessionId: string,
  targetFolderPageId: string,
): PlannerProjectionState {
  const movedSession = findFolderSession(state, sessionId);
  let next = deleteFolderSessionProjection(state, sessionId);
  if (movedSession) next = addFolderSessionProjection(next, targetFolderPageId, movedSession);
  return next;
}

export function acknowledgeFolderSessionProjection(
  state: PlannerProjectionState,
  sessionId: string,
): PlannerProjectionState {
  const next = mapAllFolders(state, (folder) => {
    const sessions = mapIfChanged(folder.sessions, (session) =>
      session.agentSessionId === sessionId
        ? { ...session, reviewState: 'acknowledged' }
        : session);
    return sessions === folder.sessions ? folder : { ...folder, sessions };
  });
  return { ...next, dailyByDate: mapRecord(next.dailyByDate, (daily) =>
    daily?.reviewSessionIds.includes(sessionId)
      ? { ...daily, reviewSessionIds: daily.reviewSessionIds.filter((id) => id !== sessionId) }
      : daily) };
}

function mapAllFolders(
  state: PlannerProjectionState,
  transform: (folder: PlannerFolder) => PlannerFolder,
): PlannerProjectionState {
  let next = state;
  const seen = new Set<string>();
  const visit = (folder: PlannerFolder) => {
    if (seen.has(folder.page.id)) return;
    seen.add(folder.page.id);
    next = replaceFolderProjection(next, transform(folder));
  };
  for (const daily of Object.values(state.dailyByDate)) {
    for (const folder of daily?.folders ?? []) visit(folder);
  }
  for (const page of Object.values(state.folderChildPages)) {
    for (const folder of page?.items ?? []) visit(folder);
  }
  for (const folder of state.starred.items) visit(folder);
  if (state.selectedFolderSnapshot) visit(state.selectedFolderSnapshot);
  return next;
}

function insertFolderIntoParent(
  state: PlannerProjectionState,
  pageId: string,
  folder: PlannerFolder,
): PlannerProjectionState {
  const page = state.folderChildPages[pageId];
  if (!page) return state;
  const items = upsertById(page.items, folder, (item) => item.page.id);
  if (items === page.items) return state;
  const folders = { ...page, items };
  const project = state.folderByPageId[pageId];
  return {
    ...state,
    folderChildPages: { ...state.folderChildPages, [pageId]: folders },
    folderByPageId: project
      ? { ...state.folderByPageId, [pageId]: { ...project, folders } }
      : state.folderByPageId,
  };
}

function removeFolderFromParent(
  state: PlannerProjectionState,
  pageId: string,
  folderPageId: string,
): PlannerProjectionState {
  const page = state.folderChildPages[pageId];
  if (!page) return state;
  const items = removeById(page.items, folderPageId, (item) => item.page.id);
  if (items === page.items) return state;
  const folders = { ...page, items };
  const project = state.folderByPageId[pageId];
  return {
    ...state,
    folderChildPages: { ...state.folderChildPages, [pageId]: folders },
    folderByPageId: project
      ? { ...state.folderByPageId, [pageId]: { ...project, folders } }
      : state.folderByPageId,
  };
}

export function findPlannerFolderProjection(
  state: PlannerProjectionState,
  folderPageId: string,
): PlannerFolder | undefined {
  if (state.selectedFolderSnapshot?.page.id === folderPageId) return state.selectedFolderSnapshot;
  for (const daily of Object.values(state.dailyByDate)) {
    const folder = daily?.folders.find((item) => item.page.id === folderPageId);
    if (folder) return folder;
  }
  for (const page of Object.values(state.folderChildPages)) {
    const folder = page?.items.find((item) => item.page.id === folderPageId);
    if (folder) return folder;
  }
  const starred = state.starred.items.find((item) => item.page.id === folderPageId);
  if (starred) return starred;
  return undefined;
}

function findFolderSession(
  state: PlannerProjectionState,
  sessionId: string,
): PlannerSessionSummary | undefined {
  for (const daily of Object.values(state.dailyByDate)) {
    const session = daily?.folders.flatMap((folder) => folder.sessions)
      .find((item) => item.agentSessionId === sessionId);
    if (session) return session;
  }
  for (const page of Object.values(state.folderChildPages)) {
    const session = page?.items.flatMap((folder) => folder.sessions)
      .find((item) => item.agentSessionId === sessionId);
    if (session) return session;
  }
  const starredSession = state.starred.items.flatMap((folder) => folder.sessions)
    .find((item) => item.agentSessionId === sessionId);
  if (starredSession) return starredSession;
  return state.selectedFolderSnapshot?.sessions
    .find((item) => item.agentSessionId === sessionId);
}

function replaceDailyFolder(daily: PlannerToday, folder: PlannerFolder): PlannerToday {
  const folders = replaceById(daily.folders, folder, (item) => item.page.id);
  return folders === daily.folders ? daily : { ...daily, folders };
}

function removeDailyFolder(daily: PlannerToday, folderPageId: string): PlannerToday {
  const folders = removeById(daily.folders, folderPageId, (item) => item.page.id);
  return folders === daily.folders ? daily : { ...daily, folders };
}

function replaceFolderPage(
  page: PlannerPageSlice<PlannerFolder>,
  folder: PlannerFolder,
): PlannerPageSlice<PlannerFolder> {
  const items = replaceById(page.items, folder, (item) => item.page.id);
  return items === page.items ? page : { ...page, items };
}

function replaceProjectFolder(project: PlannerFolderCollection, folder: PlannerFolder): PlannerFolderCollection {
  const folders = replaceFolderPage(project.folders, folder);
  return folders === project.folders ? project : { ...project, folders };
}
