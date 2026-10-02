import type { ApiRequestContext } from './clientCore';
import type { CatalogFolder } from './types';
import {
  parsePlannerFolderDetail,
  parsePlannerFolderPageSlice,
  parsePlannerToday,
  type PlannerFolderDetailWire,
  type PlannerPageSliceWire,
  type PlannerFolderSessionPage,
  type PlannerSessionSummaryWire,
  type PlannerFolderWire,
  type PlannerTodayWire,
} from './plannerTypes';

function pageQuery(cursor: string | undefined): URLSearchParams {
  const query = new URLSearchParams();
  if (cursor) query.set('cursor', cursor);
  return query;
}

function withQuery(path: string, query: URLSearchParams): string {
  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

export function createPlannerEndpoints({
  base,
  authFetch,
  readJson,
}: ApiRequestContext) {
  return {
    getPlannerToday: (date: string) =>
      authFetch(`${base}/api/planner/today?${new URLSearchParams({ date })}`)
        .then((response) => readJson<PlannerTodayWire>(response, 'getPlannerToday'))
        .then(parsePlannerToday),

    getStarredFolders: (cursor?: string) => {
      const query = pageQuery(cursor);
      return authFetch(withQuery(`${base}/api/planner/starred-folders`, query))
        .then((response) => readJson<PlannerPageSliceWire<PlannerFolderWire>>(
          response,
          'getStarredFolders',
        ))
        .then((payload) => parsePlannerFolderPageSlice(payload, 'starred'));
    },

    moveStarredFolderOrder: (pageId: string, beforePageId: string | null) =>
      authFetch(`${base}/api/planner/starred-folders/order`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pageId, beforePageId }),
      }).then((response) => readJson<{ ok: true }>(response, 'moveStarredFolderOrder')),

    getDailyHistory: (before: string) =>
      authFetch(`${base}/api/planner/daily-history?${new URLSearchParams({
        before,
      })}`).then((response) => readJson<{ dates: string[] }>(
        response,
        'getDailyHistory',
      )),

    getPlannerFolder: (folderId: string,options?:{includeCompleted?:boolean}) =>
      authFetch(`${base}/api/planner/folders/${encodeURIComponent(folderId)}${options?.includeCompleted===undefined?'':`?includeCompleted=${options.includeCompleted}`}`)
        .then((response) => readJson<PlannerFolderDetailWire>(response, 'getPlannerFolder'))
        .then(parsePlannerFolderDetail),

    getPlannerFolderSubfolders: (folderId: string, cursor?: string) =>
      authFetch(withQuery(`${base}/api/planner/folders/${encodeURIComponent(folderId)}/subfolders`, pageQuery(cursor)))
        .then((response) => readJson<{ items: CatalogFolder[]; nextCursor: string | null }>(response, 'getPlannerFolderSubfolders')),

    getPlannerFolderSessions: (folderId: string, cursor?: string) =>
      authFetch(withQuery(`${base}/api/planner/folders/${encodeURIComponent(folderId)}/sessions`, pageQuery(cursor)))
        .then((response) => readJson<{ items: PlannerSessionSummaryWire[]; nextCursor: string | null }>(response, 'getPlannerFolderSessions'))
        .then((payload): PlannerFolderSessionPage => ({
          items: payload.items.map((item) => ({ agentSessionId: item.agentSessionId })),
          nextCursor: payload.nextCursor,
        })),
  };
}
