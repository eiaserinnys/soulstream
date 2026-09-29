
import Fastify, { type FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { CustomViewRevisionConflictError } from
  "../src/board-yjs/board_projection_types.js";
import type {
  BoardYjsFolderScope,
  BoardYjsReplica,
  BoardYjsSeed,
} from "../src/board-yjs/board_yjs_types.js";
import {
  createOrchestratorRuntimeComposition,
  loadContractFixtures,
  parseOrchServerConfig,
  registerBoardYjsHostProxyRoutes,
} from "../src/index.js";


const fixture = loadContractFixtures().boardYjsHostProxy;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("orch-local Board Yjs host operation routes", () => {
  it("shares one BoardYjsService between local host operations and public websockets", async () => {
    const service = createServiceDouble();
    const createService = vi.fn(() => service);
    const runtime = createOrchestratorRuntimeComposition({
      config: parseOrchServerConfig({
        environment: "test",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "test-token",
      }),
      boardYjsRoutes: { createService },
    });
    try {
      await runtime.app.ready();
      expect(createService).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.app.close();
    }
    expect(service.close).toHaveBeenCalledTimes(1);
  });

  it("accepts every canonical host operation fixture", async () => {
    // P2 owns the worker client; this server contract sends the shared wire fixtures directly.
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, { authBearerToken: "test-token", service: createServiceDouble() });
    try {
      for (const item of fixture.directOperations) {
        const response = await app.inject({ method: "POST", url: `/api/board-yjs/host/${item.operation}`,
          headers: { authorization: "Bearer test-token" }, payload: item.body });
        expect(response.statusCode, item.operation).toBe(200);
        expect(response.json()).toEqual(responseForOperation(item.operation));
      }
    } finally { await app.close(); }
  });

  it("requires the service bearer in orch mode and never accepts a dashboard cookie", async () => {
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service: createServiceDouble(),
    } as never);
    try {
      const missing = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/remove-board-item",
        headers: { cookie: "soulstream_auth=dashboard-jwt" },
        payload: fixture.directOperations.find((item) =>
          item.operation === "remove-board-item"
        )?.body,
      });
      expect(missing.statusCode).toBe(401);
      expect(missing.json()).toMatchObject({
        detail: { error: { code: "UNAUTHORIZED" } },
      });
    } finally {
      await app.close();
    }
  });

  it("dispatches projection reads through the authenticated local host allowlist", async () => {
    const projectionHost = {
      listFolderItems: vi.fn(async () => ({
        items: [],
        total: 0,
        counts: {
          session: 0,
          markdown: 0,
          subfolder: 0,
          asset: 0,
          frame: 0,
          custom_view: 0,
        },
        scan: null,
      })),
    };
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service: createServiceDouble(),
      projectionHost: projectionHost as never,
    });
    const payload = {
      folderId: "task-1",
      query: null,
      includeArchived: false,
      itemTypes: null,
      limit: 50,
      cursor: 0,
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/list-folder-items",
        headers: { authorization: "Bearer test-token" },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ items: [], total: 0 });
      expect(projectionHost.listFolderItems).toHaveBeenCalledWith(payload);
    } finally {
      await app.close();
    }
  });

  it("returns a structured 409 when custom-view revision CAS fails", async () => {
    const projectionHost = {
      patchCustomViewRecord: vi.fn(async () => {
        throw new CustomViewRevisionConflictError("cv-1", 3, 5);
      }),
    };
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service: createServiceDouble(),
      projectionHost: projectionHost as never,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/patch-custom-view-record",
        headers: { authorization: "Bearer test-token" },
        payload: {
          customViewId: "cv-1",
          boardItemId: "custom_view:cv-1",
          expectedRevision: 3,
          html: "<main></main>",
          actorKind: "agent",
          actorSessionId: "sess-actor",
          idempotencyKey: "custom-view:patch:cv-1",
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        detail: {
          error: {
            code: "CUSTOM_VIEW_REVISION_CONFLICT",
            message: "custom view revision conflict for cv-1: expected 3, actual 5",
            customViewId: "cv-1",
            expectedRevision: 3,
            actualRevision: 5,
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("does not expose a live-host runbook residue migration operation", async () => {
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service: createServiceDouble(),
    } as never);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/migrate-runbook-residue",
        headers: { authorization: "Bearer test-token" },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns the original 422 validation and 500 operation error envelopes", async () => {
    const service = createServiceDouble();
    vi.mocked(service.deleteMarkdownDocument).mockRejectedValueOnce(new Error("write failed"));
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service,
    } as never);
    try {
      const invalid = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/update-board-item-position",
        headers: { authorization: "Bearer test-token" },
        payload: {},
      });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({
        detail: { error: { code: "INVALID_BOARD_YJS_HOST_REQUEST" } },
      });

      const failed = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/delete-markdown-document",
        headers: { authorization: "Bearer test-token" },
        payload: fixture.directOperations.find((item) =>
          item.operation === "delete-markdown-document"
        )?.body,
      });
      expect(failed.statusCode).toBe(500);
      expect(failed.json()).toEqual({
        detail: {
          error: {
            code: "BOARD_YJS_HOST_OPERATION_FAILED",
            message: "write failed",
          },
        },
      });
    } finally {
      await app.close();
    }
  });

  it("reconciles board_items after an orch-local host operation", async () => {
    const repository = new CapturingBoardYjsRepository();
    const service = createRealService(repository);
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      authBearerToken: "test-token",
      service,
    } as never);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/board-yjs/host/create-markdown-document",
        headers: { authorization: "Bearer test-token" },
        payload: fixture.directOperations[0]?.body,
      });
      expect(response.statusCode).toBe(200);
      await waitFor(() => repository.replicas.length > 0);
      expect(repository.replicas.at(-1)?.boardItems).toEqual([
        expect.objectContaining({ id: "markdown:doc-1", itemId: "doc-1" }),
      ]);
    } finally {
      await service.close();
      await app.close();
    }
  });
});

function responseForOperation(operation: string): unknown {
  if ([
    "remove-task-board-item",
    "remove-board-item",
    "update-board-item-position",
    "delete-markdown-document",
  ].includes(operation)) return { ok: true };
  return { operation, wire: "original" };
}

function createServiceDouble() {
  const result = (operation: string) => vi.fn().mockResolvedValue(responseForOperation(operation));
  return {
    createMarkdownDocument: result("create-markdown-document"),
    upsertSessionBoardItem: result("upsert-session-board-item"),
    moveSessionToFolder: result("move-session-to-folder"),
    upsertCustomViewBoardItem: result("upsert-custom-view-board-item"),
    removeBoardItem: result("remove-board-item"),
    updateBoardItemPosition: result("update-board-item-position"),
    moveBoardItemToContainer: result("move-board-item-to-folder"),
    updateMarkdownDocument: result("update-markdown-document"),
    deleteMarkdownDocument: result("delete-markdown-document"),
    handleConnection: vi.fn(),
    handleContainerConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BoardYjsService;
}

function createRealService(repository: CapturingBoardYjsRepository): BoardYjsService {
  return new BoardYjsService({
    repository,
    logger: silentLogger() as FastifyBaseLogger,
    auth: {
      authBearerToken: "test-token",
      environment: "production",
      dashboardAuthEnabled: false,
      resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
    },
  });
}

class CapturingBoardYjsRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  readonly revisions = new Map<string, number>();
  readonly replicas: BoardYjsReplica[] = [];

  async loadBoardYjsSnapshot(documentName: string) {
    const snapshot = this.snapshots.get(documentName);
    return snapshot
      ? { snapshot, revision: this.revisions.get(documentName) ?? 1 }
      : null;
  }
  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }
  async resolveBoardYjsFolderScope(
    container: BoardYjsFolderScope,
  ): Promise<BoardYjsFolderScope> {
    return {
      ...container,
    };
  }
  async backfillTaskBoardItemsIntoSnapshot(
    _documentName: string,
    _container: BoardYjsFolderScope,
    snapshot: { snapshot: Uint8Array; revision: number },
  ) {
    return snapshot;
  }
  async loadBoardYjsSeed(): Promise<BoardYjsSeed> {
    return { boardItems: [], markdownDocuments: [] };
  }
  async storeBoardYjsSnapshot(
    documentName: string,
    snapshot: Uint8Array,
    expectedRevision: number | null,
    projection?: { replica: BoardYjsReplica },
  ) {
    const actualRevision = this.revisions.get(documentName) ?? null;
    if (actualRevision !== expectedRevision) return null;
    const revision = (actualRevision ?? 0) + 1;
    this.snapshots.set(documentName, snapshot);
    this.revisions.set(documentName, revision);
    if (projection) this.replicas.push(projection.replica);
    return { snapshot, revision };
  }
}

function silentLogger() {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => logger, level: "silent", silent: vi.fn(),
  };
  return logger;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
