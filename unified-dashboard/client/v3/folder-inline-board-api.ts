import { FolderMessageError } from "./folder-messages";
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

export async function fetchFolderBoardItems(
  folderId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  return (await fetchFolderBoardContainerItems(folderId, fetchImplementation, signal))
    .filter((item) => INLINE_TYPES.has(item.itemType));
}

interface FolderBoardItemsRead {
  folderId: string;
  key: number;
  controller: AbortController;
  consumers: number;
  settled: boolean;
  promise: Promise<CatalogBoardItem[]>;
}

// 폴더마다 마지막 열쇠 하나만 둔다. 같은 폴더를 보는 표면(플래너 인라인과
// 워크스페이스)이 같은 열쇠로 읽으면 진행 중 요청에 합류하고 끝난 결과를 재사용한다.
const folderBoardItemReads = new Map<string, FolderBoardItemsRead>();

/** 같은 폴더와 itemInvalidationKey의 읽기를 합치고 재사용하는 공유 읽기. */
export function loadFolderBoardItems(
  folderId: string,
  itemInvalidationKey: number,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  if (signal?.aborted) return Promise.reject(abortError());
  const existing = folderBoardItemReads.get(folderId);
  if (existing && existing.key === itemInvalidationKey) {
    return consumeFolderBoardItems(existing, signal);
  }
  const entry = createFolderBoardItemsRead(folderId, itemInvalidationKey, fetchImplementation);
  folderBoardItemReads.set(folderId, entry);
  return consumeFolderBoardItems(entry, signal);
}

/**
 * 공유 결과를 쓰지 않는 새 읽기. 끝나면 같은 열쇠의 공유 결과를 이 값으로 바꾼다.
 * loadConfirmedResult의 확인 읽기(두 번째 load)가 쓴다.
 */
export async function refreshFolderBoardItems(
  folderId: string,
  itemInvalidationKey: number,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  if (signal?.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const items = await fetchFolderBoardItems(folderId, fetchImplementation, controller.signal);
    const current = folderBoardItemReads.get(folderId);
    if (!current || current.key === itemInvalidationKey) {
      folderBoardItemReads.set(folderId, {
        folderId,
        key: itemInvalidationKey,
        controller,
        consumers: 0,
        settled: true,
        promise: Promise.resolve(items),
      });
    }
    return items;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** load 밖에서 그 폴더의 목록을 바꿨을 때 공유 결과를 버린다. 진행 중 요청의 결과도 다시 저장하지 않는다. */
export function discardFolderBoardItems(folderId: string): void {
  folderBoardItemReads.delete(folderId);
}

function createFolderBoardItemsRead(
  folderId: string,
  key: number,
  fetchImplementation: typeof globalThis.fetch,
): FolderBoardItemsRead {
  const controller = new AbortController();
  const entry: FolderBoardItemsRead = {
    folderId,
    key,
    controller,
    consumers: 0,
    settled: false,
    promise: Promise.resolve([]),
  };
  entry.promise = fetchFolderBoardItems(folderId, fetchImplementation, controller.signal).then(
    (items) => {
      entry.settled = true;
      return items;
    },
    (error: unknown) => {
      entry.settled = true;
      // 실패한 결과는 남기지 않는다. 다음 읽기가 다시 요청한다.
      if (folderBoardItemReads.get(folderId) === entry) folderBoardItemReads.delete(folderId);
      throw error;
    },
  );
  return entry;
}

function consumeFolderBoardItems(
  entry: FolderBoardItemsRead,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  if (signal?.aborted) return Promise.reject(abortError());
  entry.consumers += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", onAbort);
      entry.consumers -= 1;
      // 합류한 소비자가 모두 abort하면 실제 요청을 끊고 지운다.
      if (entry.consumers <= 0 && !entry.settled) {
        entry.controller.abort();
        if (folderBoardItemReads.get(entry.folderId) === entry) {
          folderBoardItemReads.delete(entry.folderId);
        }
      }
      reject(abortError());
    };
    entry.promise.then(
      (items) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(items);
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export async function fetchFolderBoardContainerItems(
  folderId: string,
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  signal?: AbortSignal,
): Promise<CatalogBoardItem[]> {
  const query = new URLSearchParams({ folderId });
  const response = await fetchWithProjectionRetry(
    (requestSignal) => fetchImplementation(`/api/board-items?${query.toString()}`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: requestSignal,
    }),
    signal,
  );
  if (!response.ok) throw new FolderMessageError("folders.errors.boardItems", { status: response.status });
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
  const response = await fetchImplementation(
    `/api/custom-views/${encodeURIComponent(customViewId)}`,
    { credentials: "same-origin", headers: { Accept: "application/json" } },
  );
  if (!response.ok) throw new FolderMessageError("folders.errors.customViewHttp", { status: response.status });
  return await response.json() as CustomViewDocument;
}
