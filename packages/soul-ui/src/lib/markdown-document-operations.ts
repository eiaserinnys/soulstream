import type { MarkdownDocument } from "../shared/types";

type MarkdownDocumentUpdateListener = (document: MarkdownDocument) => void;

const updateListenersByDocumentId = new Map<string, Set<MarkdownDocumentUpdateListener>>();

export interface RenameMarkdownDocumentInput {
  documentId: string;
  title: string;
  expectedVersion: number;
}

export interface UpdateMarkdownDocumentInput extends RenameMarkdownDocumentInput {
  body?: string;
}

export class MarkdownDocumentConflictError extends Error {
  constructor() {
    super("문서가 다른 곳에서 변경되었습니다. 다시 불러온 뒤 재시도하세요.");
    this.name = "MarkdownDocumentConflictError";
  }
}

/**
 * 저장이 확정된 문서 스냅샷만 같은 문서 ID의 열린 표면에 전달한다.
 * 값을 보관하거나 목록을 무효화하지 않으므로 서버/Y.Doc 정본을 대체하지 않는다.
 */
export function subscribeMarkdownDocumentUpdates(
  documentId: string,
  listener: MarkdownDocumentUpdateListener,
): () => void {
  const listeners = updateListenersByDocumentId.get(documentId) ?? new Set();
  listeners.add(listener);
  updateListenersByDocumentId.set(documentId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) updateListenersByDocumentId.delete(documentId);
  };
}

export function publishMarkdownDocumentUpdate(document: MarkdownDocument): void {
  const listeners = updateListenersByDocumentId.get(document.id);
  if (!listeners) return;
  for (const listener of listeners) listener(document);
}

export async function fetchMarkdownDocument(
  documentId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  const response = await fetchImplementation(
    `/api/markdown-documents/${encodeURIComponent(documentId)}`,
    {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`마크다운 문서를 불러오지 못했습니다 (${response.status})`);
  }
  return await response.json() as MarkdownDocument;
}

export async function deleteMarkdownDocument(
  documentId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImplementation(
    `/api/markdown-documents/${encodeURIComponent(documentId)}`,
    {
      method: "DELETE",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`마크다운 문서를 삭제하지 못했습니다 (${response.status})`);
  }
}

export async function renameMarkdownDocument(
  input: RenameMarkdownDocumentInput,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  return await updateMarkdownDocument(input, fetchImplementation);
}

export async function updateMarkdownDocument(
  input: UpdateMarkdownDocumentInput,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  const fields: { title: string; body?: string; expectedVersion: number } = {
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    expectedVersion: input.expectedVersion,
  };
  const response = await fetchImplementation(
    `/api/markdown-documents/${encodeURIComponent(input.documentId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fields),
    },
  );
  if (response.status === 409) {
    throw new MarkdownDocumentConflictError();
  }
  if (!response.ok) {
    throw new Error(`마크다운 문서를 저장하지 못했습니다 (${response.status})`);
  }
  const confirmed = await fetchMarkdownDocument(input.documentId, fetchImplementation);
  const titleMatches = confirmed.title === input.title;
  const bodyMatches = input.body === undefined || confirmed.body === input.body;
  if (!titleMatches || !bodyMatches || confirmed.version <= input.expectedVersion) {
    throw new Error("마크다운 문서 저장을 서버 재조회에서 확인하지 못했습니다.");
  }
  publishMarkdownDocumentUpdate(confirmed);
  return confirmed;
}
