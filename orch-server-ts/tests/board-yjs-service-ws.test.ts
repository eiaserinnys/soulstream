import { performance } from "node:perf_hooks";

import Fastify, { type FastifyBaseLogger } from "fastify";
import {
  HocuspocusProvider,
  type HocuspocusProviderConfiguration,
} from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import {
  createMarkdownYjsDocument,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import { registerBoardYjsRoutes } from "../src/board-yjs/board_yjs_route.js";
import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import { SessionDeletionService } from
  "../src/session/session_deletion_service.js";
import type {
  BoardYjsFolderScope,
  BoardYjsDocumentApplication,
  BoardYjsReplica,
  BoardYjsSeed,
  CatalogBoardItemRow,
} from "../src/board-yjs/board_yjs_types.js";

const providers: HocuspocusProvider[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
          folderId: "task-1",
          },
        position: { x: 100, y: 200 },
      });
      const updated = await service.updateMarkdownDocument(
        { folderId: "task-1" },
        "doc-1",
        { title: "Moved", expectedVersion: 1 },
      );

      expect(moved).toMatchObject({
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
        folderId: "task-1",
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
                repository.revisions.get(application.documentName) ?? null,
              );
            }
          },
        },
      });

      await deletion.deleteSession("session-delete");

      const documentName = "board-folder:task-1";
      const storedSnapshot = repository.snapshots.get(documentName);
      expect(storedSnapshot).toBeDefined();
      const storedDocument = new Y.Doc();
      Y.applyUpdate(storedDocument, storedSnapshot!);
      const storedReplica = readBoardYDocReplica({
        folderId: "folder-1",
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
        sessionId: "session-move",
        x: 10,
        y: 20,
      });
      const oldB = {
        ...oldA,
        folderId: "folder-old-b",
        };
      const reference = {
        ...oldA,
        id: "session-reference:session-move",

        membershipKind: "reference" as const,
      };
      repository.sessionInventory.set("session-move", [oldA, oldB, reference]);
      repository.snapshots.set(
        "board-folder:folder-old-b",
        snapshotWithBoardItems("folder-old-b", [oldB]),
      );
      const referenceSnapshot = snapshotWithBoardItems("folder-old-a", [reference]);
      repository.snapshots.set("board-folder:task-1", referenceSnapshot);

      const moved = await service.moveSessionToFolder("session-move", "folder-target");

      expect(moved).toMatchObject({
        id: "session:session-move",
        folderId: "folder-target",
        });
      expect(readSnapshotItems(repository, "folder-old-a")).toEqual([]);
      expect(readSnapshotItems(repository, "folder-old-b")).toEqual([]);
      expect(readSnapshotItems(repository, "folder-target")).toEqual([
        expect.objectContaining({ id: "session:session-move", itemId: "session-move" }),
      ]);
      expect(repository.snapshots.get("board-folder:task-1")).toBe(referenceSnapshot);
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

describe("direct mutation timing", () => {
  it("does not log when the whole direct mutation stays under 1000ms", async () => {
    const logger = silentLogger();
    const service = createService(new MemoryBoardYjsRepository(), logger);
    const clock = installFakeClock();
    installControlledDirectMutation(service, {
      clock,
      gateWaitMs: 100,
      connectMs: 200,
      transactMs: 400,
      disconnectMs: 299,
    });
    try {
      await expect(
        service.updateMarkdownDocument(
          { folderId: "folder-1" },
          "missing",
          { expectedVersion: 1 },
        ),
      ).resolves.toBeNull();
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("logs one timing line when the whole direct mutation reaches exactly 1000ms", async () => {
    const logger = silentLogger();
    const service = createService(new MemoryBoardYjsRepository(), logger);
    const clock = installFakeClock();
    installControlledDirectMutation(service, {
      clock,
      gateWaitMs: 400,
      connectMs: 200,
      transactMs: 300,
      disconnectMs: 100,
    });
    try {
      await expect(
        service.updateMarkdownDocument(
          { folderId: "folder-1" },
          "missing",
          { expectedVersion: 1 },
        ),
      ).resolves.toBeNull();
      expect(singleLoggedPayload(logger)).toEqual({
        documentName: "board-folder:folder-1",
        totalMs: 1000,
        gateWaitMs: 400,
        connectMs: 200,
        transactMs: 300,
        disconnectMs: 100,
        outcome: "ok",
        failedStage: null,
      });
    } finally {
      await service.close();
    }
  });

  it("logs the failed connect stage and rethrows the original error", async () => {
    const logger = silentLogger();
    const service = createService(new MemoryBoardYjsRepository(), logger);
    const clock = installFakeClock();
    const connectError = new Error("connect failed for confidential-token");
    installControlledDirectMutation(service, {
      clock,
      gateWaitMs: 10,
      connectMs: 990,
      connectError,
    });
    try {
      await expect(
        service.updateMarkdownDocument(
          { folderId: "folder-1" },
          "doc-1",
          { expectedVersion: 1 },
        ),
      ).rejects.toBe(connectError);
      const payload = singleLoggedPayload(logger);
      expect(payload).toEqual({
        documentName: "board-folder:folder-1",
        totalMs: 1000,
        gateWaitMs: 10,
        connectMs: 990,
        transactMs: null,
        disconnectMs: null,
        outcome: "error",
        failedStage: "connect",
      });
      expect(JSON.stringify(payload)).not.toContain("confidential-token");
    } finally {
      await service.close();
    }
  });

  it("logs the failed transact stage and rethrows the original error", async () => {
    const logger = silentLogger();
    const service = createService(new MemoryBoardYjsRepository(), logger);
    const clock = installFakeClock();
    const transactError = new Error("store hook failed for confidential-body");
    installControlledDirectMutation(service, {
      clock,
      gateWaitMs: 10,
      connectMs: 10,
      transactMs: 980,
      disconnectMs: 10,
      transactError,
    });
    try {
      await expect(
        service.updateMarkdownDocument(
          { folderId: "folder-1" },
          "doc-1",
          { expectedVersion: 1 },
        ),
      ).rejects.toBe(transactError);
      const payload = singleLoggedPayload(logger);
      expect(payload).toEqual({
        documentName: "board-folder:folder-1",
        totalMs: 1010,
        gateWaitMs: 10,
        connectMs: 10,
        transactMs: 980,
        disconnectMs: 10,
        outcome: "error",
        failedStage: "transact",
      });
      expect(JSON.stringify(payload)).not.toContain("confidential-body");
    } finally {
      await service.close();
    }
  });

  it("logs only timing fields and never document content", async () => {
    const logger = silentLogger();
    const service = createService(new MemoryBoardYjsRepository(), logger);
    const clock = installFakeClock();
    const document = new Y.Doc();
    createMarkdownYjsDocument(document, { folderId: "folder-1" }, {
      title: "Confidential title",
      body: "confidential body",
      x: 0,
      y: 0,
      documentId: "doc-secret",
    });
    installControlledDirectMutation(service, {
      clock,
      gateWaitMs: 10,
      connectMs: 20,
      transactMs: 1000,
      disconnectMs: 10,
      document,
    });
    try {
      const updated = await service.updateMarkdownDocument(
        { folderId: "folder-1" },
        "doc-secret",
        { title: "Updated confidential", body: "new confidential body", expectedVersion: 1 },
      );
      expect(updated).toEqual({
        id: "doc-secret",
        title: "Updated confidential",
        body: "new confidential body",
        version: 2,
      });
      const payload = singleLoggedPayload(logger);
      expect(Object.keys(payload).sort()).toEqual([
        "connectMs",
        "disconnectMs",
        "documentName",
        "failedStage",
        "gateWaitMs",
        "outcome",
        "totalMs",
        "transactMs",
      ]);
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("confidential");
      expect(serialized).not.toContain("Confidential");
    } finally {
      await service.close();
    }
  });
});

function singleLoggedPayload(logger: FastifyBaseLogger): Record<string, unknown> {
  const info = vi.mocked(logger.info);
  expect(info).toHaveBeenCalledOnce();
  return info.mock.calls[0]?.[0] as Record<string, unknown>;
}

interface FakeClock {
  advance(ms: number): void;
}

function installFakeClock(): FakeClock {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
  };
}

interface ControlledDirectMutationOptions {
  clock: FakeClock;
  gateWaitMs: number;
  connectMs?: number;
  transactMs?: number;
  disconnectMs?: number;
  connectError?: Error;
  transactError?: Error;
  document?: Y.Doc;
}

function installControlledDirectMutation(
  service: BoardYjsService,
  options: ControlledDirectMutationOptions,
): void {
  const internals = service as unknown as {
    hocuspocus: {
      openDirectConnection(documentName: string, context?: unknown): Promise<unknown>;
    };
    documentMutationGate: unknown;
  };
  const document = options.document ?? new Y.Doc();
  const connection = {
    async transact(transaction: (doc: Y.Doc) => void): Promise<void> {
      options.clock.advance(options.transactMs ?? 0);
      transaction(document);
      if (options.transactError) throw options.transactError;
    },
    async disconnect(): Promise<void> {
      options.clock.advance(options.disconnectMs ?? 0);
    },
  };
  vi.spyOn(internals.hocuspocus, "openDirectConnection").mockImplementation(async () => {
    options.clock.advance(options.connectMs ?? 0);
    if (options.connectError) throw options.connectError;
    return connection;
  });
  Object.assign(internals, {
    documentMutationGate: {
      async withMutation<T>(
        documentNames: readonly string[],
        work: () => Promise<T>,
      ): Promise<T> {
        void documentNames;
        options.clock.advance(options.gateWaitMs);
        return await work();
      },
    },
  });
}

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
        sessionIds: [input.sessionId],
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
      resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
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
  readonly revisions = new Map<string, number>();
  readonly sessionInventory = new Map<string, CatalogBoardItemRow[]>();

  async apply(applications: readonly BoardYjsDocumentApplication[]): Promise<void> {
    for (const application of applications) {
      await this.storeBoardYjsSnapshot(
        application.documentName,
        application.snapshot,
        this.revisions.get(application.documentName) ?? null,
      );
    }
  }

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
  ) {
    const actualRevision = this.revisions.get(documentName) ?? null;
    if (expectedRevision !== actualRevision) return null;
    const revision = (actualRevision ?? 0) + 1;
    this.snapshots.set(documentName, snapshot);
    this.revisions.set(documentName, revision);
    return { snapshot, revision };
  }
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
    }, document).boardItems;
}
