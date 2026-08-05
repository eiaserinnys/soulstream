import { describe, expect, it, vi } from "vitest";

import {
  createApp,
  loadContractFixtures,
  markdownDocumentRouteAuthRequirements,
} from "../src/index.js";
import { MarkdownDocumentVersionConflictError } from "../src/board-yjs/markdown_document_version.js";
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
    const { app, calls, service } = createAppWithMarkdownDocuments({
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
    expect(service.createMarkdownDocument).not.toHaveBeenCalled();

    await app.close();
  });

  it("creates a folder-scoped document through the orchestrator-local service", async () => {
    const { app, calls, service } = createAppWithMarkdownDocuments({
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
    expect(response.json()).toMatchObject({ document: { id: "doc-1" } });
    expect(calls).toEqual([["listFolders"], ["access"]]);
    expect(service.createMarkdownDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: "folder-a-child",
        container: { containerKind: "folder", containerId: "folder-a-child" },
        title: "Note",
        body: "Body",
        x: 12,
        y: 34,
      }),
    );

    await app.close();
  });

  it("preserves body container while folderId wins access and payload folderId", async () => {
    const { app, calls, service } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: {
        folderId: "folder-a-child",
        container: { kind: "task", id: "task-1" },
        title: "Task note",
        x: 12,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([["listFolders"], ["access"]]);
    expect(service.createMarkdownDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: "folder-a-child",
        container: { containerKind: "task", containerId: "task-1" },
        title: "Task note",
        body: "",
      }),
    );

    await app.close();
  });

  it("resolves task container folder when create omits folderId", async () => {
    const { app, calls, service } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: {
        container: { kind: "task", id: "task-1" },
        title: "Task note",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(calls).toEqual([
      ["resolveContainer", { kind: "task", id: "task-1" }],
      ["listFolders"],
      ["access"],
    ]);
    expect(service.createMarkdownDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: "folder-a",
        container: { containerKind: "task", containerId: "task-1" },
      }),
    );

    await app.close();
  });

  it("returns container not found before host proxy when task source is missing", async () => {
    const { app, calls, service } = createAppWithMarkdownDocuments({
      restricted: false,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: {
        container: { kind: "task", id: "missing" },
        title: "Task note",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ detail: "Task board container not found" });
    expect(calls).toEqual([
      ["resolveContainer", { kind: "task", id: "missing" }],
    ]);
    expect(service.createMarkdownDocument).not.toHaveBeenCalled();

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
    const { app, service } = createAppWithMarkdownDocuments({
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
    expect(service.createMarkdownDocument).not.toHaveBeenCalled();

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
    const { app, service } = createAppWithMarkdownDocuments({
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
    expect(service.updateMarkdownDocument).not.toHaveBeenCalled();

    await app.close();
  });

  it("updates documents with supplied non-null fields only", async () => {
    const { app, calls, service } = createAppWithMarkdownDocuments({
      restricted: true,
      allowedFolderIds: ["folder-a"],
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expectedVersion: 7, title: "New", body: null },
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      ["getDocument", "doc/one"],
      ["listFolders"],
      ["access"],
    ]);
    expect(service.updateMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "task", containerId: "task-1" },
      "doc/one",
      { expectedVersion: 7, title: "New" },
    );

    await app.close();
  });

  it("updates and deletes documents through the orchestrator-local service", async () => {
    const updateMarkdownDocument = vi.fn(async () => ({
      id: "doc/one", title: "New", body: "After", version: 8,
    }));
    const deleteMarkdownDocument = vi.fn(async () => undefined);
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      { updateMarkdownDocument, deleteMarkdownDocument },
    );

    const update = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expectedVersion: 7, title: "New", body: "After" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: "/api/markdown-documents/doc%2Fone",
    });

    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ title: "New", body: "After", version: 8 });
    expect(updateMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "task", containerId: "task-1" },
      "doc/one",
      { expectedVersion: 7, title: "New", body: "After" },
    );
    expect(remove.statusCode).toBe(204);
    expect(deleteMarkdownDocument).toHaveBeenCalledWith(
      { containerKind: "task", containerId: "task-1" },
      "doc/one",
    );
    await app.close();
  });

  it("maps markdown version conflicts to the public 409 contract", async () => {
    const updateMarkdownDocument = vi.fn(async () => {
      throw new MarkdownDocumentVersionConflictError("doc/one", 7, 8);
    });
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      { updateMarkdownDocument },
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/markdown-documents/doc%2Fone",
      payload: { expectedVersion: 7, title: "New" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ expectedVersion: 7, actualVersion: 8 });
    await app.close();
  });

  it("maps orchestrator-local markdown failures through the host operation envelope", async () => {
    const createMarkdownDocument = vi.fn(async () => {
      throw new Error("network down");
    });
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      { createMarkdownDocument },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { folderId: "folder-a", title: "Note" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: {
        code: "BOARD_YJS_HOST_OPERATION_FAILED",
      },
    });

    await app.close();
  });

  it("can register markdown and board-yjs host operation routes together without duplicates", async () => {
    const { app } = createAppWithMarkdownDocuments(
      { restricted: false },
      {},
      {},
      true,
    );

    await app.ready();
    const markdownResponse = await app.inject({
      method: "POST",
      url: "/api/markdown-documents",
      payload: { folderId: "folder-a", title: "Note" },
    });
    expect(markdownResponse.statusCode).toBe(201);
    expect(app.hasRoute({
      method: "POST",
      url: "/api/board-yjs/host/:operation",
    })).toBe(true);

    await app.close();
  });
});
