/**
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createBoardWorkspaceOperations } from "./board-workspace-operations";

class MockXMLHttpRequest {
  static requests: MockXMLHttpRequest[] = [];

  upload: { onprogress?: (event: ProgressEvent) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  status = 200;
  method = "";
  url = "";
  headers: Record<string, string> = {};

  constructor() {
    MockXMLHttpRequest.requests.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(body: Blob) {
    this.upload.onprogress?.({
      lengthComputable: true,
      loaded: body.size,
      total: body.size,
    } as ProgressEvent);
    this.onload?.();
  }

  getResponseHeader(name: string) {
    return name.toLowerCase() === "etag" ? `"etag-${MockXMLHttpRequest.requests.length}"` : null;
  }
}

function makeOperations() {
  return createBoardWorkspaceOperations({
    updateBoardItemPositionUrl: (id) => `/api/board-items/${id}/position`,
    moveBoardItemToContainerUrl: (id) => `/api/board-items/${id}/container`,
    createMarkdownDocumentUrl: "/api/markdown-documents",
    initBoardAssetUrl: (target) => target.container.kind === "folder"
      ? `/api/board/${target.folderId}/assets/init`
      : `/api/board-containers/${target.container.kind}/${target.container.id}/assets/init`,
    commitBoardAssetUrl: (target, assetId) => target.container.kind === "folder"
      ? `/api/board/${target.folderId}/assets/${assetId}/commit`
      : `/api/board-containers/${target.container.kind}/${target.container.id}/assets/${assetId}/commit`,
  });
}

describe("createBoardWorkspaceOperations asset upload", () => {
  const originalXHR = globalThis.XMLHttpRequest;

  afterEach(() => {
    globalThis.XMLHttpRequest = originalXHR;
    MockXMLHttpRequest.requests = [];
    vi.restoreAllMocks();
  });

  it("forwards markdown creation container payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      document: { id: "doc-1", title: "Task note", body: "body", version: 1 },
      boardItem: {
        id: "markdown:doc-1",
        folderId: "root",
        containerKind: "task",
        containerId: "rb-1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 40,
        y: 80,
        metadata: {},
      },
    }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeOperations().createMarkdownDocument({
      folderId: "root",
      container: { kind: "task", id: "rb-1" },
      title: "Task note",
      body: "body",
      x: 40,
      y: 80,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/markdown-documents", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        folderId: "root",
        container: { kind: "task", id: "rb-1" },
        title: "Task note",
        body: "body",
        x: 40,
        y: 80,
      }),
    }));
  });

  it("moves board items to a target container", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      ok: true,
      boardItem: {
        id: "markdown:doc-1",
        folderId: "root",
        containerKind: "task",
        containerId: "rb-1",
        itemType: "markdown",
        itemId: "doc-1",
        x: 120,
        y: 240,
        metadata: {},
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await makeOperations().moveBoardItemToContainer({
      boardItemId: "markdown:doc-1",
      container: { kind: "task", id: "rb-1" },
      x: 120,
      y: 240,
      idempotencyKey: "move-1",
    });

    expect(result.boardItem.containerKind).toBe("task");
    expect(fetchMock).toHaveBeenCalledWith("/api/board-items/markdown:doc-1/container", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        container: { kind: "task", id: "rb-1" },
        x: 120,
        y: 240,
        idempotencyKey: "move-1",
      }),
    }));
  });

  it("runs init, direct PUT, then commit for single-file uploads", async () => {
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: "asset-1",
        uploadMode: "single",
        uploadUrl: "https://r2.example/put",
        headers: { "Content-Type": "image/png" },
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        asset: { id: "asset-1" },
        boardItem: {
          id: "asset:asset-1",
          folderId: "f1",
          itemType: "asset",
          itemId: "asset-1",
          x: 40,
          y: 80,
          metadata: {},
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];

    const result = await makeOperations().uploadBoardAsset({
      folderId: "f1",
      file: new File(["abc"], "photo.png", { type: "image/png" }),
      x: 40,
      y: 80,
      onProgress: (value) => progress.push(value),
    });

    expect(result.boardItem.itemType).toBe("asset");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/board/f1/assets/init");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/board/f1/assets/asset-1/commit");
    expect(MockXMLHttpRequest.requests[0]?.url).toBe("https://r2.example/put");
    expect(MockXMLHttpRequest.requests[0]?.headers["Content-Type"]).toBe("image/png");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      x: 40,
      y: 80,
      parts: [],
    });
    expect(progress.at(-1)).toBe(100);
  });

  it("uses container asset routes for task board uploads", async () => {
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: "asset-task",
        uploadMode: "single",
        uploadUrl: "https://r2.example/task-put",
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        asset: { id: "asset-task" },
        boardItem: {
          id: "asset:asset-task",
          folderId: "root",
          containerKind: "task",
          containerId: "rb-1",
          itemType: "asset",
          itemId: "asset-task",
          x: 120,
          y: 160,
          metadata: {},
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeOperations().uploadBoardAsset({
      folderId: "root",
      container: { kind: "task", id: "rb-1" },
      file: new File(["abc"], "artifact.png", { type: "image/png" }),
      x: 120,
      y: 160,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/board-containers/task/rb-1/assets/init");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/board-containers/task/rb-1/assets/asset-task/commit");
    expect(MockXMLHttpRequest.requests[0]?.url).toBe("https://r2.example/task-put");
  });

  it("uploads every multipart part and forwards ETags to commit", async () => {
    globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        assetId: "asset-multi",
        uploadMode: "multipart",
        uploadId: "upload-1",
        partSize: 5,
        parts: [
          { partNumber: 1, uploadUrl: "https://r2.example/part-1" },
          { partNumber: 2, uploadUrl: "https://r2.example/part-2" },
        ],
      }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        asset: { id: "asset-multi" },
        boardItem: {
          id: "asset:asset-multi",
          folderId: "f1",
          itemType: "asset",
          itemId: "asset-multi",
          x: 20,
          y: 40,
          metadata: {},
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await makeOperations().uploadBoardAsset({
      folderId: "f1",
      file: new File(["abcdefgh"], "movie.mp4", { type: "video/mp4" }),
      x: 20,
      y: 40,
    });

    expect(MockXMLHttpRequest.requests.map((request) => request.url)).toEqual([
      "https://r2.example/part-1",
      "https://r2.example/part-2",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      parts: [
        { partNumber: 1, etag: "\"etag-1\"" },
        { partNumber: 2, etag: "\"etag-2\"" },
      ],
    });
  });
});
