import type { MarkdownDocument } from "../shared/types";

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
  return confirmed;
}
