import Fastify, { type FastifyBaseLogger } from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import { registerBoardYjsRoutes } from "../src/board-yjs/board_yjs_route.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { SessionDeletionService } from
  "../src/session/session_deletion_service.js";
import type {
  BoardYjsContainerRef,
  BoardYjsContainerScope,
  BoardYjsDocumentApplication,
  BoardYjsReplica,
  BoardYjsSeed,
  CatalogBoardItemRow,
} from "../src/board-yjs/board_yjs_types.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.destroy()));
});

describe("orch BoardYjsService", () => {
  it("rejects a protocol document name that differs from the routed document", async () => {
    const repository = new MemoryBoardYjsRepository();
    const app = createBoardApp(repository);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const provider = connectProvider(
        `${address.replace("http", "ws")}/yjs/folder-1`,
        "board-folder:folder-2",
      );
      await expect(waitForSync(provider)).rejects.toThrow("permission-denied");
      expect(repository.snapshots.has("board-folder:folder-2")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("executes direct mutations and preserves markdown content across containers in orch mode", async () => {
    const service = createService();
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

  it("deletes a session card from canonical Y.Doc storage and passes projection verification", async () => {
    const repository = new MemoryBoardYjsRepository();
    const service = createService(repository);
    try {
      const boardItem = await service.upsertSessionBoardItem({
        folderId: "folder-1",
        container: { containerKind: "task", containerId: "task-1" },
        sessionId: "session-delete",
        x: 10,
        y: 20,
      });
      const deletion = new SessionDeletionService({
        board: service,
        repository: {
          async listSessionBoardItems(sessionId) {
            expect(sessionId).toBe("session-delete");
            return [boardItem];
          },
          async deleteSession({ sessionId, boardApplications }) {
            expect(sessionId).toBe("session-delete");
            expect(boardApplications).toHaveLength(1);
            for (const application of boardApplications) {
              await repository.storeBoardYjsSnapshot(
                application.documentName,
                application.snapshot,
              );
            }
          },
        },
      });

      await deletion.deleteSession("session-delete");

      const documentName = "board:task:task-1";
      const storedSnapshot = repository.snapshots.get(documentName);
      expect(storedSnapshot).toBeDefined();
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, storedSnapshot!);
      const storedReplica = readBoardYDocReplica({
        folderId: "folder-1",
        containerKind: "task",
        containerId: "task-1",
      }, storedDocument);
      expect(storedReplica.boardItems).toEqual([]);
      assertBoardItemProjectionParity({
        label: documentName,
        ydocItems: storedReplica.boardItems,
        projectionItems: [],
      });
    } finally {
      await service.close();
    }
  });

  it("removes every cache-only primary residue and creates one destination card", async () => {
    const repository = new MemoryBoardYjsRepository();
    const service = createService(repository);
    try {
      const oldA = await service.upsertSessionBoardItem({
        folderId: "folder-old-a",
        container: { containerKind: "folder", containerId: "folder-old-a" },
        sessionId: "session-move",
        x: 10,
        y: 20,
      });
      const oldB = {
        ...oldA,
        folderId: "folder-old-b",
        containerId: "folder-old-b",
      };
      const reference = {
        ...oldA,
        id: "session-reference:session-move",
        containerKind: "task" as const,
        containerId: "task-1",
        membershipKind: "reference" as const,
      };
      repository.sessionInventory.set("session-move", [oldA, oldB, reference]);
      repository.snapshots.set(
        "board-folder:folder-old-b",
        snapshotWithBoardItems("folder-old-b", [oldB]),
      );
      const referenceSnapshot = snapshotWithBoardItems("folder-old-a", [reference]);
      repository.snapshots.set("board:task:task-1", referenceSnapshot);

      const moved = await service.moveSessionToFolder("session-move", "folder-target");

      expect(moved).toMatchObject({
        id: "session:session-move",
        folderId: "folder-target",
        containerId: "folder-target",
      });
      expect(readSnapshotItems(repository, "folder-old-a")).toEqual([]);
      expect(readSnapshotItems(repository, "folder-old-b")).toEqual([]);
      expect(readSnapshotItems(repository, "folder-target")).toEqual([
        expect.objectContaining({ id: "session:session-move", itemId: "session-move" }),
      ]);
      expect(repository.snapshots.get("board:task:task-1")).toBe(referenceSnapshot);
    } finally {
      await service.close();
    }
  });

  it("completes the real HocuspocusProvider sync handshake and relays Y.Doc updates in orch mode", async () => {
    const repository = new MemoryBoardYjsRepository();
    const app = createBoardApp(repository);
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
      await waitFor(() => repository.snapshots.size > 0);
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, [...repository.snapshots.values()].at(-1)!);
      expect(storedDocument.getMap("wire-proof").get("message"))
        .toBe("synced through orch");
    } finally {
      await app.close();
    }
  }, 20_000);
});

function createBoardApp(
  repository = new MemoryBoardYjsRepository(),
) {
  const app = Fastify({ logger: false });
  registerBoardYjsRoutes(app, {
    createService: (logger) => createService(repository, logger),
  });
  return app;
}

function createService(
  repository = new MemoryBoardYjsRepository(),
  logger = silentLogger(),
) {
  let service!: BoardYjsService;
  service = new BoardYjsService({
    repository,
    logger,
    persistBoardItemMove: async ({ boardApplications }) => {
      await repository.apply(boardApplications);
    },
    moveSessionBoardItem: async (input) => {
      const boardItems = repository.sessionInventory.get(input.sessionId) ?? [];
      return await service.withSessionBoardMoveApplications({
        ...input,
        boardItems,
      }, async ({ boardApplications }) => {
        await repository.apply(boardApplications);
        const references = boardItems.filter((item) =>
          (item.membershipKind ?? "primary") === "reference"
        );
        const staged = boardApplications.flatMap((application) =>
          application.replica.boardItems.filter((item) =>
            item.itemType === "session" && item.itemId === input.sessionId
          )
        );
        repository.sessionInventory.set(input.sessionId, [...references, ...staged]);
      });
    },
    auth: {
      authBearerToken: "wire-token",
      environment: "production",
      dashboardAuthEnabled: false,
      verifyDashboardToken: vi.fn().mockResolvedValue(null),
    },
  });
  return service;
}

function connectProvider(
  url: string,
  name = "board-folder:folder-1",
): HocuspocusProvider {
  const configuration = {
    url,
    name,
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
  readonly sessionInventory = new Map<string, CatalogBoardItemRow[]>();

  async apply(applications: readonly BoardYjsDocumentApplication[]): Promise<void> {
    for (const application of applications) {
      await this.storeBoardYjsSnapshot(application.documentName, application.snapshot);
    }
  }

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

  async syncBoardYjsReplica(
    _container: BoardYjsContainerScope,
    _replica: BoardYjsReplica,
  ): Promise<void> {}
}

function snapshotWithBoardItems(
  folderId: string,
  boardItems: CatalogBoardItemRow[],
): Uint8Array {
  const document = new Y.Doc();
  for (const item of boardItems) {
    document.getMap("boardItems").set(item.id, {
      item_type: item.itemType,
      item_id: item.itemId,
      x: item.x,
      y: item.y,
      membership_kind: item.membershipKind,
      source_task_item_id: item.sourceTaskItemId,
      metadata: item.metadata,
    });
  }
  return Y.encodeStateAsUpdate(document);
}

function readSnapshotItems(
  repository: MemoryBoardYjsRepository,
  folderId: string,
): CatalogBoardItemRow[] {
  const document = new Y.Doc();
  const snapshot = repository.snapshots.get(`board-folder:${folderId}`);
  if (snapshot) Y.applyUpdate(document, snapshot);
  return readBoardYDocReplica({
    folderId,
    containerKind: "folder",
    containerId: folderId,
  }, document).boardItems;
}
