import type { ApiRequestContext } from './clientCore';

export type BoardItemType =
  | 'session'
  | 'markdown'
  | 'subfolder'
  | 'asset'
  | 'frame'
  | 'custom_view';

export interface BoardItem {
  id: string;
  folderId: string;
  membershipKind?: 'primary' | 'reference' | string;
  itemType: BoardItemType;
  itemId: string;
  x: number;
  y: number;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface MarkdownDocument {
  id: string;
  title: string;
  body: string;
  version: number;
}

export interface CustomViewDocument {
  id: string;
  boardItemId: string;
  folderId: string;
  title?: string | null;
  html: string;
  revision: number;
}

export function createBoardItemEndpoints({ base, authFetch, readJson, buildQuery }: ApiRequestContext) {
  return {
    getFolderBoardItems: async (folderId: string): Promise<BoardItem[]> => {
      const query = buildQuery({ folderId });
      const response = await authFetch(`${base}/api/board-items?${query}`);
      const payload = await readJson<{ boardItems?: BoardItem[] }>(response, 'getFolderBoardItems');
      return payload.boardItems ?? [];
    },
    getSessionBoardItems: async (sessionId: string): Promise<BoardItem[]> => {
      const query = buildQuery({ sessionId });
      const response = await authFetch(`${base}/api/board-items?${query}`);
      const payload = await readJson<{ boardItems?: BoardItem[] }>(response, 'getSessionBoardItems');
      return payload.boardItems ?? [];
    },
    getMarkdownDocument: (documentId: string): Promise<MarkdownDocument> =>
      authFetch(`${base}/api/markdown-documents/${encodeURIComponent(documentId)}`)
        .then((response) => readJson(response, 'getMarkdownDocument')),
    getCustomView: (customViewId: string): Promise<CustomViewDocument> =>
      authFetch(`${base}/api/custom-views/${encodeURIComponent(customViewId)}`)
        .then((response) => readJson(response, 'getCustomView')),
    moveBoardItemToFolder: (
      boardItemId: string,
      folderId: string,
      idempotencyKey: string,
    ): Promise<unknown> =>
      authFetch(`${base}/api/board-items/${encodeURIComponent(boardItemId)}/folder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId, idempotencyKey }),
      }).then((response) => readJson(response, 'moveBoardItemToFolder')),
  };
}
