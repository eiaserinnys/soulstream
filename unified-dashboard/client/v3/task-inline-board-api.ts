import type {
  CatalogBoardItem,
  CustomViewDocument,
  MarkdownDocument,
} from "@seosoyoung/soul-ui";

const INLINE_TYPES = new Set<CatalogBoardItem["itemType"]>([
  "markdown",
  "custom_view",
  "asset",
]);

export async function fetchTaskBoardItems(
  runbookId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): Promise<CatalogBoardItem[]> {
  const query = new URLSearchParams({
    container_kind: "runbook",
    container_id: runbookId,
  });
  const response = await fetchImplementation(`/api/board-items?${query.toString()}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`보드 항목을 불러오지 못했습니다 (${response.status})`);
  const payload = await response.json() as { boardItems?: CatalogBoardItem[] };
  return (payload.boardItems ?? [])
    .filter((item) => INLINE_TYPES.has(item.itemType));
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
