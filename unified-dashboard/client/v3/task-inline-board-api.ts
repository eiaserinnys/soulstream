import {
  fetchWithProjectionRetry,
  type CatalogBoardItem,
  type CustomViewDocument,
  type MarkdownDocument,
} from "@seosoyoung/soul-ui";

const INLINE_TYPES = new Set<CatalogBoardItem["itemType"]>([
  "markdown",
  "custom_view",
  "asset",
]);

export async function fetchTaskBoardItems(
  taskId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  return (await fetchTaskBoardContainerItems(taskId, fetchImplementation, signal))
    .filter((item) => INLINE_TYPES.has(item.itemType));
}

export async function fetchTaskBoardContainerItems(
  taskId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  const query = new URLSearchParams({
    container_kind: "task",
    container_id: taskId,
  });
  const response = await fetchWithProjectionRetry(
    (requestSignal) => fetchImplementation(`/api/board-items?${query.toString()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    }),
    signal,
  );
  if (!response.ok) throw new Error(`보드 항목을 불러오지 못했습니다 (${response.status})`);
  const payload = await response.json() as { boardItems?: CatalogBoardItem[] };
  return payload.boardItems ?? [];
}

export async function fetchInlineMarkdown(
  documentId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  return await fetchDocument<MarkdownDocument>(
    `/api/markdown-documents/${encodeURIComponent(documentId)}`,
    "마크다운 문서를",
    fetchImplementation,
  );
}

export async function saveInlineMarkdown(
  input: {
    documentId: string;
    title: string;
    body: string;
    expectedVersion: number;
  },
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<MarkdownDocument> {
  const response = await fetchImplementation(
    `/api/markdown-documents/${encodeURIComponent(input.documentId)}`,
    {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        expectedVersion: input.expectedVersion,
      }),
    },
  );
  if (response.status === 409) {
    throw new Error("문서가 다른 곳에서 변경되었습니다. 다시 불러온 뒤 재시도하세요.");
  }
  if (!response.ok) throw new Error(`마크다운 문서를 저장하지 못했습니다 (${response.status})`);
  return await response.json() as MarkdownDocument;
}

export async function fetchInlineCustomView(
  customViewId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<CustomViewDocument> {
  return await fetchDocument<CustomViewDocument>(
    `/api/custom-views/${encodeURIComponent(customViewId)}`,
    "커스텀 뷰를",
    fetchImplementation,
  );
}

async function fetchDocument<T>(
  path: string,
  label: string,
  fetchImplementation: typeof globalThis.fetch,
): Promise<T> {
  const response = await fetchImplementation(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${label} 불러오지 못했습니다 (${response.status})`);
  return await response.json() as T;
}
