import type { ApiRequestContext } from './clientCore';
import type { CatalogResponse } from './clientTypes';
import { toSession } from './mappers';
import type { CatalogFolder, FolderMutationResult, Session } from './types';
import type { FolderSnapshot } from './cardTypes';
import type { InitialFolderContext } from './initialFolderContext';
import { FEED_PAGE_SIZE, type FeedPage } from './feedPage';

type CatalogAssignmentMap = Record<string, { folderId: string | null; displayName: string | null }>;
type SessionListRow = Record<string, unknown> & {
  agentSessionId?: string;
  folderId?: string | null;
  displayName?: string | null;
};

interface FoldersPayload {
  folders?: CatalogFolder[];
  sessions?: CatalogAssignmentMap;
}

interface SessionsPayload {
  sessions?: SessionListRow[];
  sessionList?: SessionListRow[];
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

type CatalogRequestOptions = Pick<RequestInit, 'signal'>;

interface FolderReorderItem {
  id: string;
  sortOrder: number;
  parentFolderId?: string | null;
}

const TARGETED_SESSION_BATCH_SIZE = 200;

export function createCatalogEndpoints({
  base,
  authFetch,
  readJson,
  buildQuery,
}: ApiRequestContext) {
  return {
    getFeedPage: async (cursor: string, signal?: AbortSignal): Promise<FeedPage> => {
      const query = new URLSearchParams({
        feed_only: 'true',
        feed_display: 'true',
        limit: String(FEED_PAGE_SIZE),
        cursor,
      });
      const response = await authFetch(`${base}/api/sessions?${query.toString()}`, { signal });
      const payload = await readJson<SessionsPayload>(response, 'getFeedPage');
      const rows = Array.isArray(payload.sessions)
        ? payload.sessions
        : Array.isArray(payload.sessionList)
          ? payload.sessionList
          : [];
      return {
        sessions: rows.map(toSession).filter((session) => Boolean(session.agentSessionId)),
        total: typeof payload.total === 'number' ? payload.total : rows.length,
        hasMore: payload.hasMore === true,
        nextCursor: typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
      };
    },

    getSessionsByIds: async (
      sessionIds: readonly string[],
      signal?: AbortSignal,
    ): Promise<Session[]> => {
      const uniqueIds = [...new Set(sessionIds)];
      const batches: string[][] = [];
      for (let index = 0; index < uniqueIds.length; index += TARGETED_SESSION_BATCH_SIZE) {
        batches.push(uniqueIds.slice(index, index + TARGETED_SESSION_BATCH_SIZE));
      }
      const payloads = await Promise.all(batches.map(async (batch) => {
        const query = new URLSearchParams({ limit: String(batch.length) });
        batch.forEach((sessionId) => query.append('session_id', sessionId));
        const response = await authFetch(`${base}/api/sessions?${query.toString()}`, { signal });
        return readJson<SessionsPayload>(response, 'getSessionsByIds');
      }));
      return payloads.flatMap((payload) => {
        const rows = Array.isArray(payload.sessions)
          ? payload.sessions
          : Array.isArray(payload.sessionList)
            ? payload.sessionList
            : [];
        return rows.map(toSession).filter((session) => Boolean(session.agentSessionId));
      });
    },

    // 폴더 골격과 세션 목록을 책임별 엔드포인트에서 받아 기존 CatalogResponse로 조립한다.
    getCatalog: (params?: {
      folder_id?: string;
      feed_only?: boolean;
      limit?: number;
      offset?: number;
    }, options?: CatalogRequestOptions): Promise<CatalogResponse> => {
      const qs = buildQuery(params);
      return Promise.all([
        authFetch(`${base}/api/folders?sessions=false`, options).then((r) => readJson<FoldersPayload>(r, 'getFolders')),
        authFetch(`${base}/api/sessions${qs ? `?${qs}` : ''}`, options).then((r) =>
          readJson<SessionsPayload>(r, 'getSessions'),
        ),
      ]).then(([foldersPayload, sessionsPayload]) => {
        const folderSessions =
          foldersPayload &&
          typeof foldersPayload.sessions === 'object' &&
          !Array.isArray(foldersPayload.sessions)
            ? foldersPayload.sessions
            : {};
        const rows = Array.isArray(sessionsPayload?.sessions)
          ? sessionsPayload.sessions
          : Array.isArray(sessionsPayload?.sessionList)
            ? sessionsPayload.sessionList
            : [];
        const sessions = rows.reduce<CatalogAssignmentMap>(
          (acc, row) => {
            if (!row || typeof row.agentSessionId !== 'string') return acc;
            acc[row.agentSessionId] = {
              folderId: typeof row.folderId === 'string' ? row.folderId : null,
              displayName: typeof row.displayName === 'string' ? row.displayName : null,
            };
            return acc;
          },
          { ...folderSessions },
        );
        return {
          folders: Array.isArray(foldersPayload?.folders) ? foldersPayload.folders : [],
          sessions,
          sessionList: rows,
          total: typeof sessionsPayload?.total === 'number' ? sessionsPayload.total : rows.length,
        };
      });
    },

    // 폴더별 실행 중(또는 활성) 세션 수 — FolderListScreen 우측 배지로 표시한다.
    getFolderCounts: (): Promise<{ counts: Record<string, number> }> =>
      authFetch(`${base}/api/sessions/folder-counts`).then((r) =>
        readJson(r, 'getFolderCounts'),
      ),

    // 폴더 CRUD — orch-server `/api/folders` 라우터.
    createFolder: (body: {
      name: string;
      sortOrder?: number;
      parentFolderId?: string | null;
      description?: string;
      initialContext?: InitialFolderContext;
      idempotencyKey: string;
    }): Promise<FolderMutationResult> =>
      authFetch(`${base}/api/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => readJson(r, 'createFolder')),

    getFolderSnapshot: (folderId: string,options?:{includeCompleted?:boolean}): Promise<FolderSnapshot> => authFetch(`${base}/api/folders/${encodeURIComponent(folderId)}${options?.includeCompleted===undefined?'':`?includeCompleted=${options.includeCompleted}`}`)
      .then((response) => readJson(response, 'getFolderSnapshot')),

    getChildFolders: (folderId: string, cursor?: string): Promise<{
      items: CatalogFolder[];
      nextCursor: string | null;
    }> => authFetch(`${base}/api/folders/${encodeURIComponent(folderId)}/children${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`)
      .then((response) => readJson(response, 'getChildFolders')),

    updateFolder: async (
      folderId: string,
      body: {
        name?: string;
        sortOrder?: number;
        parentFolderId?: string | null;
        settings?: Record<string, any>;
        expectedVersion: number;
        idempotencyKey: string;
      },
    ): Promise<FolderMutationResult> =>
      authFetch(`${base}/api/folders/${encodeURIComponent(folderId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((response) => readJson(response, 'updateFolder')),

    setFolderStatus: (
      folderId: string, status: 'open' | 'completed', expectedVersion: number, idempotencyKey: string,
    ): Promise<FolderMutationResult> =>
      authFetch(`${base}/api/folders/${encodeURIComponent(folderId)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expectedVersion, idempotencyKey }),
      }).then((response) => readJson(response, 'setFolderStatus')),

    reorderFolders: (items: FolderReorderItem[]): Promise<Response> =>
      authFetch(`${base}/api/folders/reorder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(items),
      }),

    updateSessionCatalog: (
      sessionId: string,
      body: { folderId?: string | null; displayName?: string | null },
    ): Promise<Response> =>
      authFetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),

    archiveFolder: (folderId: string, expectedVersion: number, idempotencyKey: string): Promise<FolderMutationResult> =>
      authFetch(`${base}/api/folders/${encodeURIComponent(folderId)}/archive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion, idempotencyKey }),
      }).then((response) => readJson(response, 'archiveFolder')),
  };
}
