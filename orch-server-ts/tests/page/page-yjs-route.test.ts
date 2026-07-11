import Fastify, { type FastifyBaseLogger } from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { BoardYjsService } from "../../src/board-yjs/board_yjs_service.js";
import { DASHBOARD_AUTH_COOKIE_NAME } from "../../src/board-yjs/board_yjs_auth.js";
import { registerBoardYjsRoutes } from "../../src/board-yjs/board_yjs_route.js";
import { createPageYDocSnapshot } from "../../src/page/page_yjs_model.js";
import { registerPageYjsRoutes } from "../../src/page/page_yjs_route.js";
import { PageYjsService } from "../../src/page/page_service.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()));
});

describe("orch public page Yjs routes", () => {
  it("shares one service across the public websocket and local host operation route", async () => {
    const service = pageServiceDouble();
    const app = Fastify({ logger: false });
    registerPageYjsRoutes(app, {
      createService: () => service,
      authBearerToken: "service-token",
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/page-yjs/host/create-page",
        headers: { authorization: "Bearer service-token" },
        payload: {
          page: { id: "page-1", title: "Page", daily_date: null },
          actor_kind: "system",
          idempotency_key: "create_page:system:route-test",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(service.createPage).toHaveBeenCalledOnce();
      expect(app.hasRoute({ method: "GET", url: "/yjs/page/:pageId" })).toBe(true);
    } finally {
      await app.close();
    }
    expect(service.close).toHaveBeenCalledOnce();
  });

  it("completes bearer handshake, update persistence, and reconnect with a real provider", async () => {
    const repository = new MemoryPageRepository();
    repository.seed("page-1");
    const app = createPageApp(repository, productionAuth());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const url = `${address.replace("http", "ws")}/yjs/page/page-1`;
      const first = connectProvider(url, { token: "service-token" });
      await waitForSync(first);
      first.document.getMap("wire-proof").set("message", "persisted through page host");
      await waitFor(() => repository.storeCount > 0);
      await first.destroy();

      const reconnected = connectProvider(url, { token: "service-token" });
      await waitForSync(reconnected);
      expect(reconnected.document.getMap("wire-proof").get("message"))
        .toBe("persisted through page host");
    } finally {
      await app.close();
    }
  }, 20_000);

  it("accepts cookie, bearer, and development auth while rejecting unauthenticated production", async () => {
    const cookieVerifier = vi.fn().mockResolvedValue({ sub: "dashboard-user" });
    const cases = [
      {
        name: "bearer",
        auth: productionAuth(),
        provider: { token: "service-token" },
      },
      {
        name: "cookie",
        auth: productionAuth({ dashboardAuthEnabled: true, verifyDashboardToken: cookieVerifier }),
        provider: {
          token: "not-the-bearer",
          cookie: `${DASHBOARD_AUTH_COOKIE_NAME}=signed-cookie`,
        },
      },
      {
        name: "development",
        auth: productionAuth({
          authBearerToken: "",
          environment: "development",
          dashboardAuthEnabled: false,
        }),
        provider: {},
      },
    ] as const;

    for (const testCase of cases) {
      const repository = new MemoryPageRepository();
      repository.seed("page-1");
      const app = createPageApp(repository, testCase.auth);
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      try {
        const provider = connectProvider(
          `${address.replace("http", "ws")}/yjs/page/page-1`,
          testCase.provider,
        );
        await waitForSync(provider);
        expect(provider.isSynced, testCase.name).toBe(true);
      } finally {
        await app.close();
      }
    }
    expect(cookieVerifier).toHaveBeenCalledWith("signed-cookie");

    const repository = new MemoryPageRepository();
    repository.seed("page-1");
    const app = createPageApp(repository, productionAuth({ authBearerToken: "" }));
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const expectedAuthLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const provider = connectProvider(`${address.replace("http", "ws")}/yjs/page/page-1`, {});
      await expect(waitForSync(provider)).rejects.toThrow("permission-denied");
      expect(expectedAuthLog).toHaveBeenCalled();
    } finally {
      expectedAuthLog.mockRestore();
      await app.close();
    }

    const mismatchRepository = new MemoryPageRepository();
    mismatchRepository.seed("page-1");
    const mismatchApp = createPageApp(mismatchRepository, productionAuth());
    const mismatchAddress = await mismatchApp.listen({ host: "127.0.0.1", port: 0 });
    const expectedMismatchLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const provider = connectProvider(
        `${mismatchAddress.replace("http", "ws")}/yjs/page/page-1`,
        { token: "service-token", name: "page:another-page" },
      );
      await expect(waitForSync(provider)).rejects.toThrow("permission-denied");
      expect(expectedMismatchLog).toHaveBeenCalled();
    } finally {
      expectedMismatchLog.mockRestore();
      await mismatchApp.close();
    }
  }, 30_000);

  it("closes a corrupted page with 1008 while board WS and dashboard health remain healthy", async () => {
    const pageRepository = new MemoryPageRepository();
    pageRepository.snapshots.set("page:broken", Uint8Array.of(255, 255, 255));
    const boardRepository = new MemoryBoardRepository();
    const app = Fastify({ logger: false });
    app.get("/api/health", async () => ({ status: "ok" }));
    registerBoardYjsRoutes(app, {
      createService: (logger) => new BoardYjsService({
        repository: boardRepository,
        logger,
        hostMode: "orch",
        auth: productionAuth(),
      }),
    });
    registerPageYjsRoutes(app, {
      createService: (logger) => createPageService(pageRepository, productionAuth(), logger),
      authBearerToken: "service-token",
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const close = await connectUntilClose(
        `${address.replace("http", "ws")}/yjs/page/broken`,
      );
      expect(close).toEqual({ code: 1008, reason: "invalid page document" });

      const board = connectBoardProvider(`${address.replace("http", "ws")}/yjs/folder-1`);
      await waitForSync(board);
      const health = await fetch(`${address}/api/health`);
      expect(health.status).toBe(200);
      await expect(health.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await app.close();
    }
  }, 20_000);
});

function createPageApp(
  repository: MemoryPageRepository,
  auth: ReturnType<typeof productionAuth>,
) {
  const app = Fastify({ logger: false });
  registerPageYjsRoutes(app, {
    createService: (logger) => createPageService(repository, auth, logger),
    authBearerToken: auth.authBearerToken,
  });
  return app;
}

function createPageService(
  repository: MemoryPageRepository,
  auth: ReturnType<typeof productionAuth>,
  logger: FastifyBaseLogger,
) {
  return new PageYjsService({ repository, auth, logger });
}

function productionAuth(overrides: Partial<{
  authBearerToken: string;
  environment: string;
  dashboardAuthEnabled: boolean;
  verifyDashboardToken: (token: string) => Promise<Record<string, unknown> | null>;
}> = {}) {
  return {
    authBearerToken: "service-token",
    environment: "production",
    dashboardAuthEnabled: false,
    verifyDashboardToken: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function connectProvider(
  url: string,
  options: { token?: string; cookie?: string; name?: string },
): HocuspocusProvider {
  const WebSocketPolyfill = options.cookie
    ? websocketWithHeaders({ cookie: options.cookie })
    : WebSocket;
  const provider = new HocuspocusProvider({
    url,
    name: options.name ?? "page:page-1",
    document: new Y.Doc(),
    ...(options.token === undefined ? {} : { token: options.token }),
    WebSocketPolyfill,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });
  providers.push(provider);
  return provider;
}

function connectBoardProvider(url: string): HocuspocusProvider {
  const provider = new HocuspocusProvider({
    url,
    name: "board-folder:folder-1",
    document: new Y.Doc(),
    token: "service-token",
    WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket });
  providers.push(provider);
  return provider;
}

function websocketWithHeaders(headers: Record<string, string>): typeof WebSocket {
  return class HeaderWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      if (protocols === undefined) {
        super(address, { headers });
      } else {
        super(address, protocols, { headers });
      }
    }
  } as typeof WebSocket;
}

function waitForSync(provider: HocuspocusProvider): Promise<void> {
  if (provider.isSynced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider sync timed out")), 10_000);
    provider.on("synced", () => {
      clearTimeout(timer);
      resolve();
    });
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
  });
}

function connectUntilClose(url: string): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("error", reject);
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pageServiceDouble() {
  const result = {
    page: { id: "page-1", title: "Page", version: 1 },
    blocks: [],
    operation: { id: "operation-1" },
    temp_id_mapping: {},
  };
  return {
    createPage: vi.fn().mockResolvedValue(result),
    mutatePage: vi.fn().mockResolvedValue(result),
    handleConnection: vi.fn(),
    assertWebsocketAuthConfigured: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as PageYjsService & {
    createPage: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

class MemoryPageRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  storeCount = 0;

  seed(pageId: string): void {
    this.snapshots.set(`page:${pageId}`, createPageYDocSnapshot({
      page: {
        id: pageId,
        title: "Page",
        dailyDate: null,
        mutationVersion: 1,
        archived: false,
        metadata: {},
      },
      blocks: [],
    }));
  }

  async getPageYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async storePageYjsState(input: { documentName: string; snapshot: Uint8Array }): Promise<void> {
    this.snapshots.set(input.documentName, input.snapshot);
    this.storeCount += 1;
  }

  async hasPageOperation(): Promise<boolean> {
    return false;
  }

  async getPageMutationByIdempotencyKey(): Promise<null> {
    return null;
  }

  async getPageTimestamps(): Promise<{ pageCreatedAt: Date; pageUpdatedAt: Date }> {
    return { pageCreatedAt: new Date(0), pageUpdatedAt: new Date(0) };
  }

  async findPageIdByTitle(): Promise<null> { return null; }
  async findPageIdByDailyDate(): Promise<null> { return null; }
  async listPages() { return { items: [], next_cursor: null }; }
  async getPageBacklinks() { return { items: [], next_cursor: null }; }

  async commitPageMutation(): Promise<never> {
    throw new Error("not used in websocket route tests");
  }
}

class MemoryBoardRepository {
  readonly snapshots = new Map<string, Uint8Array>();

  async getBoardYjsSnapshot(documentName: string): Promise<Uint8Array | null> {
    return this.snapshots.get(documentName) ?? null;
  }

  async resolveBoardYjsContainerScope(container: { containerKind: "folder" | "runbook"; containerId: string }) {
    return {
      folderId: container.containerKind === "folder" ? container.containerId : "folder-1",
      ...container,
    };
  }

  async backfillRunbookBoardItemsIntoSnapshot(
    _documentName: string,
    _container: unknown,
    snapshot: Uint8Array,
  ): Promise<Uint8Array> {
    return snapshot;
  }

  async loadBoardYjsSeed() {
    return { boardItems: [], markdownDocuments: [] };
  }

  async storeBoardYjsSnapshot(documentName: string, snapshot: Uint8Array): Promise<void> {
    this.snapshots.set(documentName, snapshot);
  }

  async markBoardYjsDocumentSynced(): Promise<void> {}
  async appendBoardYjsUpdate(): Promise<void> {}
  async syncBoardYjsReplica(): Promise<void> {}
}
