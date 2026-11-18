import type { CatalogBoardItem } from "@seosoyoung/soul-ui";
import { describe, expect, it, vi } from "vitest";

import {
  discardFolderBoardItems,
  loadFolderBoardItems,
  refreshFolderBoardItems,
} from "./folder-inline-board-api";

const item = (itemId: string) => ({
  id: `markdown-${itemId}`,
  itemType: "markdown",
  itemId,
  folderId: "folder",
  metadata: { title: itemId },
}) as unknown as CatalogBoardItem;

function json(items: CatalogBoardItem[]): Response {
  return new Response(JSON.stringify({ boardItems: items }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

interface PendingCall {
  signal: AbortSignal | null;
  resolve(response: Response): void;
  reject(error: unknown): void;
}

function controllableFetch() {
  const calls: PendingCall[] = [];
  const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ signal: init?.signal ?? null, resolve, reject });
  }));
  return { fetchMock: fetchMock as unknown as typeof globalThis.fetch, calls };
}

const signalOf = () => {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
};

describe("shared folder board items read", () => {
  it("joins an in-flight request from the same folder and invalidation key", async () => {
    const { fetchMock, calls } = controllableFetch();
    const first = loadFolderBoardItems("join-folder", 1, fetchMock);
    const second = loadFolderBoardItems("join-folder", 1, fetchMock);
    expect(calls).toHaveLength(1);

    calls[0].resolve(json([item("doc-1")]));
    await expect(first).resolves.toMatchObject([{ itemId: "doc-1" }]);
    await expect(second).resolves.toMatchObject([{ itemId: "doc-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses the finished result while the invalidation key is unchanged", async () => {
    const { fetchMock, calls } = controllableFetch();
    const first = loadFolderBoardItems("reuse-folder", 1, fetchMock);
    calls[0].resolve(json([item("doc-1")]));
    await first;

    await expect(loadFolderBoardItems("reuse-folder", 1, fetchMock))
      .resolves.toMatchObject([{ itemId: "doc-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requests again when the invalidation key changes and keeps only the last key", async () => {
    const { fetchMock, calls } = controllableFetch();
    const first = loadFolderBoardItems("key-folder", 1, fetchMock);
    calls[0].resolve(json([item("doc-1")]));
    await first;

    const second = loadFolderBoardItems("key-folder", 2, fetchMock);
    expect(calls).toHaveLength(2);
    calls[1].resolve(json([item("doc-2")]));
    await expect(second).resolves.toMatchObject([{ itemId: "doc-2" }]);

    const third = loadFolderBoardItems("key-folder", 1, fetchMock);
    expect(calls).toHaveLength(3);
    calls[2].resolve(json([item("doc-3")]));
    await expect(third).resolves.toMatchObject([{ itemId: "doc-3" }]);
  });

  it("keeps no failed result so the next read requests again", async () => {
    const { fetchMock, calls } = controllableFetch();
    const failed = loadFolderBoardItems("failure-folder", 1, fetchMock);
    calls[0].reject(new Error("board read failed"));
    await expect(failed).rejects.toThrow("board read failed");

    const retried = loadFolderBoardItems("failure-folder", 1, fetchMock);
    expect(calls).toHaveLength(2);
    calls[1].resolve(json([item("doc-1")]));
    await expect(retried).resolves.toMatchObject([{ itemId: "doc-1" }]);
  });

  it("aborts only the consumer that aborted and keeps the shared request for the rest", async () => {
    const { fetchMock, calls } = controllableFetch();
    const one = signalOf();
    const two = signalOf();
    const first = loadFolderBoardItems("partial-abort-folder", 1, fetchMock, one.signal);
    const second = loadFolderBoardItems("partial-abort-folder", 1, fetchMock, two.signal);

    one.controller.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(calls[0].signal?.aborted).toBe(false);

    calls[0].resolve(json([item("doc-1")]));
    await expect(second).resolves.toMatchObject([{ itemId: "doc-1" }]);
  });

  it("aborts the real request and drops it when every joined consumer aborts", async () => {
    const { fetchMock, calls } = controllableFetch();
    const one = signalOf();
    const two = signalOf();
    const first = loadFolderBoardItems("all-abort-folder", 1, fetchMock, one.signal);
    const second = loadFolderBoardItems("all-abort-folder", 1, fetchMock, two.signal);

    one.controller.abort();
    two.controller.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    await expect(second).rejects.toHaveProperty("name", "AbortError");
    expect(calls[0].signal?.aborted).toBe(true);

    const retried = loadFolderBoardItems("all-abort-folder", 1, fetchMock);
    expect(calls).toHaveLength(2);
    calls[1].resolve(json([item("doc-1")]));
    await expect(retried).resolves.toMatchObject([{ itemId: "doc-1" }]);
  });

  it("drops the shared result when the list is changed outside the load", async () => {
    const { fetchMock, calls } = controllableFetch();
    const first = loadFolderBoardItems("discard-folder", 1, fetchMock);
    calls[0].resolve(json([item("doc-1")]));
    await first;

    discardFolderBoardItems("discard-folder");
    const second = loadFolderBoardItems("discard-folder", 1, fetchMock);
    expect(calls).toHaveLength(2);
    calls[1].resolve(json([item("doc-2")]));
    await expect(second).resolves.toMatchObject([{ itemId: "doc-2" }]);
  });

  it("requests fresh for the confirmation read and reuses its value afterwards", async () => {
    const { fetchMock, calls } = controllableFetch();
    const first = loadFolderBoardItems("refresh-folder", 1, fetchMock);
    calls[0].resolve(json([item("doc-1")]));
    await first;

    const refreshed = refreshFolderBoardItems("refresh-folder", 1, fetchMock);
    expect(calls).toHaveLength(2);
    calls[1].resolve(json([item("doc-2")]));
    await expect(refreshed).resolves.toMatchObject([{ itemId: "doc-2" }]);

    await expect(loadFolderBoardItems("refresh-folder", 1, fetchMock))
      .resolves.toMatchObject([{ itemId: "doc-2" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
