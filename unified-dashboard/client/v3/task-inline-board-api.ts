import {
  fetchWithProjectionRetry,
  fetchMarkdownDocument,
  updateMarkdownDocument,
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
  return await fetchMarkdownDocument(documentId, fetchImplementation);
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
  return await updateMarkdownDocument(input, fetchImplementation);
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
