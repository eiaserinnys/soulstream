import Fastify, { type FastifyBaseLogger } from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { registerBoardYjsRoutes } from "../src/board-yjs/board_yjs_route.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsReplica,
  BoardYjsSeed,
} from "../src/board-yjs/board_yjs_types.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()));
});

describe("orch BoardYjsService", () => {
  it("keeps direct mutation disabled in the default node mode", async () => {
    const service = createService("node");
    await expect(service.updateBoardItemPosition(
      { containerKind: "folder", containerId: "folder-1" },
      "markdown:doc-1",
      10,
      20,
    )).rejects.toThrow(/only allowed when BOARD_YJS_HOST_MODE=orch/);
    await service.close();
  });

  it("closes the public websocket with 1013 in node mode", async () => {
    const app = createBoardApp("node");
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const close = await connectUntilClose(`${address.replace("http", "ws")}/yjs/folder-1`);
      expect(close).toEqual({ code: 1013, reason: "board Yjs documents are hosted on orch" });
    } finally {
      await app.close();
    }
  });

  it("executes direct mutations and preserves markdown content across containers in orch mode", async () => {
    const service = createService("orch");
    try {
      const created = await service.createMarkdownDocument({
        folderId: "folder-1",
        title: "Original",
        body: "Preserved body",
        x: 10,
        y: 20,
        documentId: "doc-1",
      });
      const moved = await service.moveBoardItemToContainer({
        boardItem: created.boardItem,
        targetScope: {
          folderId: "folder-1",
          containerKind: "task",
          containerId: "task-1",
        },
        position: { x: 100, y: 200 },
      });
      const updated = await service.updateMarkdownDocument(
        { containerKind: "task", containerId: "task-1" },
        "doc-1",
        { title: "Moved", expectedVersion: 1 },
      );

      expect(moved).toMatchObject({
        containerKind: "task",
        containerId: "task-1",
        x: 100,
        y: 200,
      });
      expect(updated).toEqual({
        id: "doc-1",
        title: "Moved",
        body: "Preserved body",
        version: 2,
      });
    } finally {
      await service.close();
    }
  });

  it("completes the real HocuspocusProvider sync handshake and relays Y.Doc updates in orch mode", async () => {
    const repository = new MemoryBoardYjsRepository();
    const app = createBoardApp("orch", repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const url = `${address.replace("http", "ws")}/yjs/folder-1`;
      const left = connectProvider(url);
      await waitForSync(left);
      const right = connectProvider(url);
      await waitForSync(right);

      left.document.getMap("wire-proof").set("message", "synced through orch");

      await waitFor(() =>
        right.document.getMap("wire-proof").get("message") === "synced through orch"
      );
      expect(repository.appendedUpdates).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  }, 20_000);
});

function createBoardApp(
  hostMode: "node" | "orch",
  repository = new MemoryBoardYjsRepository(),
) {
  const app = Fastify({ logger: false });
  registerBoardYjsRoutes(app, {
    createService: (logger) => createService(hostMode, repository, logger),
  });
  return app;
}

function createService(
  hostMode: "node" | "orch",
  repository = new MemoryBoardYjsRepository(),
  logger = silentLogger(),
) {
  return new BoardYjsService({
    repository,
    logger,
    hostMode,
    auth: {
      authBearerToken: "wire-token",
      environment: "production",
      dashboardAuthEnabled: false,
      verifyDashboardToken: vi.fn().mockResolvedValue(null),
    },
  });
}

function connectProvider(url: string): HocuspocusProvider {
  const configuration = {
    url,
    name: "board-folder:folder-1",
    document: new Y.Doc(),
    token: "wire-token",
    WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket };
  const provider = new HocuspocusProvider(configuration);
  providers.push(provider);
  return provider;
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

function silentLogger(): FastifyBaseLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
    level: "silent",
    silent: vi.fn(),
  };
  return logger as unknown as FastifyBaseLogger;
}

class MemoryBoardYjsRepository {
  readonly snapshots = new Map<string, Uint8Array>();
  appendedUpdates = 0;

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

  async backfillTaskBoardItemsIntoSnapshot(
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

  async appendBoardYjsUpdate(): Promise<void> {
    this.appendedUpdates += 1;
  }

  async syncBoardYjsReplica(
    _container: BoardYjsContainerScope,
    _replica: BoardYjsReplica,
  ): Promise<void> {}
}
