import { readFile } from "node:fs/promises";

import Fastify, { type FastifyBaseLogger } from "fastify";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
} from "../src/board-yjs/board_yjs_types.js";
import {
  InMemoryNodeRegistry,
  createOrchestratorRuntimeComposition,
  loadContractFixtures,
  parseOrchServerConfig,
  registerBoardYjsHostProxyRoutes,
  resolveBoardYjsHostTarget,
  type BoardYjsHostHttpClient,
} from "../src/index.js";

type ActualClient = Record<string, (...args: unknown[]) => Promise<unknown>>;

const fixture = loadContractFixtures().boardYjsHostProxy;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("orch-local Board Yjs host operation routes", () => {
  it("resolves orch mode to self without consulting zero or multiple host capabilities", () => {
    const empty = createRegistry();
    expect(resolveBoardYjsHostTarget(empty, "orch")).toEqual({ kind: "self" });

    const duplicate = createRegistry();
    registerNode(duplicate, "host-1", 4105, true);
    registerNode(duplicate, "host-2", 4106, true);
    expect(resolveBoardYjsHostTarget(duplicate, "orch")).toEqual({ kind: "self" });
  });

  it("shares one BoardYjsService between local host operations and public websockets", async () => {
    const service = createServiceDouble();
    const createService = vi.fn(() => service);
    const runtime = createOrchestratorRuntimeComposition({
      config: parseOrchServerConfig({
        environment: "test",
        databaseUrl: "postgres://soulstream_test@localhost/soulstream_test",
        authBearerToken: "test-token",
        boardYjsHostMode: "orch",
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

  it("replays all actual BoardYjsHostClient requests and preserves the internal route wire", async () => {
    const registry = createRegistry();
    const httpClient: BoardYjsHostHttpClient = vi.fn();
    const service = createServiceDouble();
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      registry,
      httpClient,
      hostMode: "orch",
      authBearerToken: "test-token",
      service,
    } as never);
    const requests = new Map<string, { headers: Record<string, string>; body: unknown }>();
    const wireResponses = new Map<string, { statusCode: number; body: unknown }>();
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const operation = parsed.pathname.split("/").at(-1) ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as unknown;
      const headers = init?.headers as Record<string, string> ?? {};
      requests.set(operation, { headers, body });
      const response = await app.inject({
        method: "POST",
        url: parsed.pathname,
        headers,
        payload: JSON.stringify(body),
      });
      const responseBody = response.body ? response.json() as unknown : undefined;
      wireResponses.set(operation, { statusCode: response.statusCode, body: responseBody });
      const responseHeaders = Object.fromEntries(
        Object.entries(response.headers)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      return new Response(response.body, {
        status: response.statusCode,
        headers: responseHeaders,
      });
    });

    try {
      const Client = await loadActualBoardYjsHostClient();
      const client = new Client({
        orch: {
          baseUrl: "http://orch.local",
          headers: { authorization: "Bearer test-token" },
        },
        logger: silentLogger(),
      });

      for (const item of fixture.directOperations) {
        await invokeActualClient(client, item.operation, item.body);
        expect(requests.get(item.operation)).toEqual({
          headers: {
            authorization: "Bearer test-token",
            "content-type": "application/json",
          },
          body: item.body,
        });
        expect(wireResponses.get(item.operation)).toEqual({
          statusCode: 200,
          body: responseForOperation(item.operation),
        });
      }
      expect(httpClient).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires the service bearer in orch mode and never accepts a dashboard cookie", async () => {
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      registry: createRegistry(),
      httpClient: vi.fn(),
      hostMode: "orch",
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

  it("returns the original 422 validation and 500 operation error envelopes", async () => {
    const service = createServiceDouble();
    vi.mocked(service.deleteMarkdownDocument).mockRejectedValueOnce(new Error("write failed"));
    const app = Fastify({ logger: false });
    registerBoardYjsHostProxyRoutes(app, {
      registry: createRegistry(),
      httpClient: vi.fn(),
      hostMode: "orch",
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
      registry: createRegistry(),
      httpClient: vi.fn(),
      hostMode: "orch",
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

async function loadActualBoardYjsHostClient(): Promise<new (config: unknown) => ActualClient> {
  const sourceUrl = new URL(
    "../../soul-server-ts/src/collaboration/board_yjs_host_client.ts",
    import.meta.url,
  );
  const source = await readFile(sourceUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`;
  const loaded = await import(moduleUrl) as { BoardYjsHostClient: new (config: unknown) => ActualClient };
  return loaded.BoardYjsHostClient;
}

async function invokeActualClient(
  client: ActualClient,
  operation: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  switch (operation) {
    case "remove-runbook-board-item":
      return await client.removeRunbookBoardItem?.(body.folderId, body.boardItemId);
    case "remove-board-item":
      return await client.removeBoardItem?.(body.container, body.boardItemId);
    case "update-board-item-position":
      return await client.updateBoardItemPosition?.(
        body.container,
        body.boardItemId,
        body.x,
        body.y,
      );
    case "update-markdown-document":
      return await client.updateMarkdownDocument?.(
        body.container,
        body.documentId,
        body.fields,
      );
    case "delete-markdown-document":
      return await client.deleteMarkdownDocument?.(body.container, body.documentId);
    default: {
      const method = operation.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return await client[method]?.(body);
    }
  }
}

function responseForOperation(operation: string): unknown {
  if ([
    "remove-runbook-board-item",
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
    upsertRunbookBoardItem: result("upsert-runbook-board-item"),
    upsertCustomViewBoardItem: result("upsert-custom-view-board-item"),
    removeRunbookBoardItem: result("remove-runbook-board-item"),
    removeBoardItem: result("remove-board-item"),
    updateBoardItemPosition: result("update-board-item-position"),
    moveBoardItemToContainer: result("move-board-item-to-container"),
    updateMarkdownDocument: result("update-markdown-document"),
    deleteMarkdownDocument: result("delete-markdown-document"),
    handleConnection: vi.fn(),
    handleContainerConnection: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as BoardYjsService;
}

function createRegistry(): InMemoryNodeRegistry {
  return new InMemoryNodeRegistry({ nowMs: () => 1_700_000_000_000 });
}

function registerNode(
  registry: InMemoryNodeRegistry,
  nodeId: string,
  port: number,
  isHost: boolean,
): void {
  registry.registerNode({
    type: "node_register",
    node_id: nodeId,
    host: "localhost",
    port,
    agents: [],
    capabilities: { board_yjs_host: isHost },
  });
}

function createRealService(repository: CapturingBoardYjsRepository): BoardYjsService {
  return new BoardYjsService({
    repository,
    logger: silentLogger() as FastifyBaseLogger,
    hostMode: "orch",
    auth: {
      authBearerToken: "test-token",
      environment: "production",
      dashboardAuthEnabled: false,
      verifyDashboardToken: vi.fn().mockResolvedValue(null),
    },
  });
}

class CapturingBoardYjsRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  readonly replicas: BoardYjsReplica[] = [];

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }
  async resolveBoardYjsContainerScope(
    container: BoardYjsContainerRef,
  ): Promise<BoardYjsContainerScope> {
    return {
      folderId: container.containerKind === "folder" ? container.containerId : "folder-1",
      ...container,
    };
  }
  async backfillRunbookBoardItemsIntoSnapshot(
    _documentName: string,
    _container: BoardYjsContainerScope,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> {
    return snapshot;
  }
  async loadBoardYjsSeed(): Promise<BoardYjsSeed> {
    return { boardItems: [], markdownDocuments: [] };
  }
  async storeBoardYjsSnapshot(documentName: string, snapshot: Uint8Array): Promise<void> {
    this.snapshots.set(documentName, snapshot);
  }
  async markBoardYjsDocumentSynced(): Promise<void> {}
  async appendBoardYjsUpdate(): Promise<void> {}
  async syncBoardYjsReplica(
    _container: BoardYjsContainerScope,
    replica: BoardYjsReplica,
  ): Promise<void> {
    this.replicas.push(replica);
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
