import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  markdownDocumentRouteAuthRequirements,
  type BoardYjsHostHttpClient,
} from "../src/index.js";
import {
  config,
  createAppWithMarkdownDocuments,
} from "./markdown-document-test-harness.js";

describe("markdown document and custom view route harness", () => {
  const fixtures = loadContractFixtures();
  const fixture = fixtures.boardYjsHostProxy;

  it("keeps markdown document and custom view routes disabled on the default app", async () => {
    const app = createApp({ config });

    for (const [method, url, payload] of [
      ["POST", "/api/markdown-documents", { folderId: "folder-a", title: "Note" }],
      ["GET", "/api/markdown-documents/doc-1", undefined],
      ["GET", "/api/custom-views/view-1", undefined],
      ["PUT", "/api/markdown-documents/doc-1", { expectedVersion: 1, title: "New" }],
      ["DELETE", "/api/markdown-documents/doc-1", undefined],
    ] as const) {
      expect(await app.inject({ method, url, payload })).toMatchObject({
        statusCode: 404,
      });
    }

    await app.close();
  });

  it("registers Python auth contract rows for route inventory order 73-75 and 80-81", () => {
    expect(markdownDocumentRouteAuthRequirements).toEqual({
      "POST /api/markdown-documents": true,
      "GET /api/markdown-documents/:document_id": true,
      "GET /api/custom-views/:custom_view_id": true,
      "PUT /api/markdown-documents/:document_id": true,
      "DELETE /api/markdown-documents/:document_id": true,
    });

    const routeRows = fixtures.routeInventory.routes
      .filter((route) =>
        [
          "create_markdown_document",
          "get_markdown_document",
          "get_custom_view",
          "update_markdown_document",
          "delete_markdown_document",
        ].includes(route.name),
      )
      .map((route) => [route.order, route.methods[0], route.path, route.authRequired]);

    expect(routeRows).toEqual([
      [73, "POST", "/api/markdown-documents", true],
      [74, "GET", "/api/markdown-documents/{document_id}", true],
      [75, "GET", "/api/custom-views/{custom_view_id}", true],
      [80, "PUT", "/api/markdown-documents/{document_id}", true],
      [81, "DELETE", "/api/markdown-documents/{document_id}", true],
    ]);
  });

  it("rejects invalid create containers before provider or host access", async () => {
    const { app, calls, httpClient } = createAppWithMarkdownDocuments({
      restricted: false,
    });

    const missing = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { title: "Note" },
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { container: { kind: "session", id: "s1" }, title: "Note" },
    });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ detail: "folderId or container is required" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toEqual({ detail: "invalid board container" });
    expect(calls).toEqual([]);
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("creates a folder-scoped document through the single board host with auth forwarding", async () => {
    const { app, calls, connectionId, httpClient } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: fixture.proxy.method,
      url: fixture.proxy.route,
      headers: {
        authorization: "Bearer test-token",
        "x-extra": "not-forwarded",
      },
      payload: {
        folderId: "folder-a-child",
        title: "Note",
        body: "Body",
        x: 12,
        y: 34,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ document: { id: "doc-1" } });
    expect(calls).toEqual([["listFolders"], ["access"]]);
    expect(httpClient).toHaveBeenCalledWith({
      method: fixture.proxy.method,
      url: "http://localhost:4105/api/markdown-documents",
      upstreamPath: fixture.proxy.upstreamPath,
      headers: { authorization: "Bearer test-token" },
      body: {
        folderId: "folder-a-child",
        container: { kind: "folder", id: "folder-a-child" },
        title: "Note",
        body: "Body",
        x: 12,
        y: 34,
      },
      target: {
        host: "localhost",
        port: 4105,
        nodeId: "board-host",
        connectionId,
      },
    });

    await app.close();
  });

  it("preserves body container while folderId wins access and payload folderId", async () => {
    const { app, calls, httpClient } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: {
        folderId: "folder-a-child",
        container: { kind: "runbook", id: "runbook-1" },
        title: "Runbook note",
        x: 12,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([["listFolders"], ["access"]]);
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          folderId: "folder-a-child",
          container: { kind: "runbook", id: "runbook-1" },
          title: "Runbook note",
          body: "",
        },
      }),
    );

    await app.close();
  });

  it("resolves runbook container folder when create omits folderId", async () => {
    const { app, calls, httpClient } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: {
        container: { kind: "runbook", id: "runbook-1" },
        title: "Runbook note",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      ["resolveContainer", { kind: "runbook", id: "runbook-1" }],
      ["listFolders"],
      ["access"],
    ]);
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          folderId: "folder-a",
          container: { kind: "runbook", id: "runbook-1" },
        }),
      }),
    );

    await app.close();
  });

  it("returns markdown documents with folder_id alias after access check", async () => {
    const { app, calls } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/markdown-documents/doc-snake",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "doc-snake",
      folder_id: "folder-a",
      title: "Snake",
    });
    expect(calls).toEqual([
      ["getDocument", "doc-snake"],
      ["listFolders"],
      ["access"],
    ]);

    await app.close();
  });

  it("returns missing and denied read errors before proxying", async () => {
    const { app, httpClient } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const missingDocument = await app.inject({
      method: "GET",
      url: "/api/markdown-documents/missing",
    });
    const deniedDocument = await app.inject({
      method: "GET",
      url: "/api/markdown-documents/doc-b",
    });
    const missingCustomView = await app.inject({
      method: "GET",
      url: "/api/custom-views/missing",
    });

    expect(missingDocument.statusCode).toBe(404);
    expect(missingDocument.json()).toEqual({ detail: "Document not found" });
    expect(deniedDocument.statusCode).toBe(403);
    expect(deniedDocument.json()).toEqual({ detail: "Folder access denied" });
    expect(missingCustomView.statusCode).toBe(404);
    expect(missingCustomView.json()).toEqual({ detail: "Custom view not found" });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns custom views after folder access check", async () => {
    const { app, calls } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/custom-views/view-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "view-1",
      folderId: "folder-a",
      html: "<p>view</p>",
    });
    expect(calls).toEqual([
      ["getCustomView", "view-1"],
      ["listFolders"],
      ["access"],
    ]);

    await app.close();
  });

  it("rejects update snake expected_version alias and null-only fields", async () => {
    const { app, httpClient } = createAppWithMarkdownDocuments({
      restricted: false,
    });

    const snakeAlias = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expected_version: 1, title: "New" },
    });
    const noFields = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expectedVersion: 1, title: null, body: null },
    });

    expect(snakeAlias.statusCode).toBe(400);
    expect(snakeAlias.json()).toEqual({ detail: "expectedVersion must be a number" });
    expect(noFields.statusCode).toBe(400);
    expect(noFields.json()).toEqual({ detail: "No fields to update" });
    expect(httpClient).not.toHaveBeenCalled();

    await app.close();
  });

  it("updates documents with supplied non-null fields only", async () => {
    const { app, calls, httpClient } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expectedVersion: 7, title: "New", body: null },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      ["getDocument", "doc/one"],
      ["listFolders"],
      ["access"],
    ]);
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        upstreamPath: "/api/markdown-documents/doc%2Fone",
        body: { expectedVersion: 7, title: "New" },
      }),
    );

    await app.close();
  });

  it("deletes documents through the host and preserves non-JSON upstream responses", async () => {
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => ({
      statusCode: 418,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: "deleted",
    }));
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "DELETE",
      url: "/api/markdown-documents/doc%2Fone",
    });

    expect(response.statusCode).toBe(418);
    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.body).toBe("deleted");
    expect(httpClient).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "DELETE",
        upstreamPath: "/api/markdown-documents/doc%2Fone",
      }),
    );

    await app.close();
  });

  it("maps markdown host request failure through the existing proxy envelope", async () => {
    const httpClient: BoardYjsHostHttpClient = vi.fn(async () => {
      throw new Error("network down");
    });
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      httpClient,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { folderId: "folder-a", title: "Note" },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: {
        code: "BOARD_YJS_HOST_REQUEST_FAILED",
        nodeId: "board-host",
      },
    });

    await app.close();
  });

  it("can register markdown and board-yjs host proxy routes together without duplicates", async () => {
    const { app, httpClient } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      vi.fn(async () => ({
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      })),
      true,
    );

    await app.ready();
    const markdownResponse = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { folderId: "folder-a", title: "Note" },
    });
    const boardProxyResponse = await app.inject({
      method: "POST",
      url: "/api/board-yjs/host/update",
      payload: { update: "payload" },
    });

    expect(markdownResponse.statusCode).toBe(200);
    expect(boardProxyResponse.statusCode).toBe(200);
    expect(httpClient).toHaveBeenCalledTimes(2);

    await app.close();
  });
});
