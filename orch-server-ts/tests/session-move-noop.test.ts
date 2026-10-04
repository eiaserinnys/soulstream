import Fastify from "fastify";
import { HocuspocusProvider, type HocuspocusProviderConfiguration } from "@hocuspocus/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";

import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import { registerBoardYjsRoutes } from "../src/board-yjs/board_yjs_route.js";
import { createBoardYDocSnapshot, readBoardYDocReplica } from "../src/board-yjs/board_yjs_model.js";
import type { BoardYjsPersistenceRepository } from "../src/board-yjs/board_yjs_persistence.js";
import type { BoardYjsSnapshotProjection } from "../src/board-yjs/board_yjs_snapshot_store.js";
import type { BoardYjsDocumentApplication, CatalogBoardItemRow } from "../src/board-yjs/board_yjs_types.js";
import { SessionBoardMoveService } from "../src/session/session_board_move_service.js";

// Reuse the real BoardYjsService, memory CAS repository and provider handshake
// patterns from board-yjs-service-ws.test.ts; assignments are separate DB facts.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("session move no-op", () => {
  it.each(["folder", "board", "batch"])("returns the existing success result without writes or move notifications via %s", async path => {
    const f = fixture();
    const result = path === "batch"
      ? await f.move.moveSessionsToFolder(["root"], "target")
      : path === "folder"
        ? await f.move.moveSessionToFolder("root", "target")
        : await f.move.moveSessionBoardItem({ sessionId: "root", targetScope: { folderId: "target" }, position: { x: 10, y: 20 } });
    expect(result).toEqual(path === "batch" ? { count: 2, sessionIds: ["root", "child"], didCommit: false } : item("root"));
    expect(f.repository.storeBoardYjsSnapshot).not.toHaveBeenCalled();
    expect(f.repository.project).not.toHaveBeenCalled();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.notifyCards).not.toHaveBeenCalled();
    expect(f.notifyFolders).not.toHaveBeenCalled();
    expect(f.notifyBoard).not.toHaveBeenCalled();
    expect(f.board.getStats().activeDocuments).toBe(0);
  });

  it.each(["child", "card"])("runs the existing move when only the %s DB folder differs", async different => {
    const f = fixture();
    if (different === "child") f.assignments.set("child", "source");
    else f.cards.set("root-card", "source");
    await f.move.moveSessionBoardItem({ sessionId: "root", targetScope: { folderId: "target" } });
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.assignments.get("child")).toBe("target");
    expect(f.cards.get("root-card")).toBe("target");
    expect(f.notifyBoard).toHaveBeenCalledOnce();
  });

  it("cleans a primary source residue even when target live items and DB assignments match", async () => {
    const f = fixture();
    f.inventory.push(item("root", "source"));
    f.repository.seed("source", [item("root", "source")]);
    await f.move.moveSessionToFolder("root", "target");
    expect(f.commit).toHaveBeenCalledOnce();
    expect(f.repository.items("source")).toEqual([]);
  });

  it("ignores reference memberships outside the destination", async () => {
    const f = fixture();
    f.inventory.push({ ...item("root", "source"), id: "reference:root", membershipKind: "reference" });
    await f.move.moveSessionToFolder("root", "target");
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.repository.storeBoardYjsSnapshot).not.toHaveBeenCalled();
  });

  it("moves when explicit coordinates differ from the live item", async () => {
    const f = fixture();
    const moved = await f.move.moveSessionBoardItem({ sessionId: "root", targetScope: { folderId: "target" }, position: { x: 30, y: 40 } });
    expect(moved).toMatchObject({ x: 30, y: 40 });
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it("recreates a live-deleted item while its DB projection and snapshot still contain it", async () => {
    const f = fixture();
    const provider = await connect(f);
    const blocked = f.repository.blockNextStore();
    provider.document.getMap("boardItems").delete("session:root");
    await blocked.entered;
    expect(f.repository.items("target").map(row => row.itemId)).toContain("root");
    expect(f.inventory.map(row => row.itemId)).toContain("root");
    f.commit.mockImplementationOnce(async ({ boardApplications }) => {
      await f.repository.apply(boardApplications);
      blocked.release();
    });
    try {
      await f.move.moveSessionToFolder("root", "target");
      await waitFor(() => provider.document.getMap("boardItems").has("session:root"));
      expect(f.commit).toHaveBeenCalledOnce();
      expect(f.repository.items("target").map(row => row.itemId)).toContain("root");
    } finally { blocked.release(); }
  });

  it("reads live coordinates instead of stale DB inventory coordinates", async () => {
    const f = fixture();
    const provider = await connect(f);
    const blocked = f.repository.blockNextStore();
    const values = provider.document.getMap<Record<string, unknown>>("boardItems");
    values.set("session:root", { ...values.get("session:root"), x: 30, y: 40 });
    await blocked.entered;
    f.repository.storeBoardYjsSnapshot.mockClear();
    try {
      const moved = await f.move.moveSessionBoardItem({ sessionId: "root", targetScope: { folderId: "target" }, position: { x: 30, y: 40 } });
      expect(moved).toMatchObject({ x: 30, y: 40 });
      expect(f.commit).not.toHaveBeenCalled();
      expect(f.repository.storeBoardYjsSnapshot).not.toHaveBeenCalled();
      expect(f.notifyBoard).not.toHaveBeenCalled();
    } finally { blocked.release(); }
  });
});

function item(sessionId: string, folderId = "target"): CatalogBoardItemRow {
  return { id: `session:${sessionId}`, folderId, membershipKind: "primary", itemType: "session", itemId: sessionId,
    x: 10, y: 20, metadata: { label: sessionId }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
}

function fixture() {
  const repository = new MemoryRepository();
  const inventory = [item("root"), item("child")];
  repository.seed("target", inventory);
  const assignments = new Map([["root", "target"], ["child", "target"]]);
  const cards = new Map([["root-card", "target"]]);
  const notifyBoard = vi.fn(async () => {});
  const notifyCards = vi.fn(async () => {});
  const notifyFolders = vi.fn(async () => {});
  const commit = vi.fn(async (input: { sessionIds: readonly string[]; folderId: string | null; boardApplications: readonly BoardYjsDocumentApplication[] }) => {
    await repository.apply(input.boardApplications);
    for (const id of input.sessionIds) assignments.set(id, input.folderId!);
    for (const id of cards.keys()) cards.set(id, input.folderId!);
  });
  let board!: BoardYjsService;
  const move = new SessionBoardMoveService({
    board: { withSessionBoardMoveApplications: (input, persist) => board.withSessionBoardMoveApplications(input, persist) },
    repository: {
      listSessionMoveTree: async () => ["root", "child"],
      listSessionBoardItems: async id => inventory.filter(row => row.itemId === id),
      areSessionAssignmentsInFolder: async (ids: readonly string[], folderId: string | null) =>
        ids.every(id => assignments.get(id) === folderId) && [...cards.values()].every(id => id === folderId),
      commitSessionMove: commit,
    },
    onBoardMoveCommitted: notifyBoard, onCardsMoveCommitted: notifyCards, onFoldersMoveCommitted: notifyFolders,
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child: () => logger };
  board = new BoardYjsService({ repository, logger: logger as never,
    moveSessionBoardItem: input => move.moveSessionBoardItem(input),
    auth: { authBearerToken: "test-token", environment: "production", dashboardAuthEnabled: false, resolveDashboardUserFromHeaders: async () => null },
  });
  cleanups.push(() => board.close());
  return { board, move, repository, inventory, assignments, cards, commit, notifyBoard, notifyCards, notifyFolders };
}

class MemoryRepository implements BoardYjsPersistenceRepository {
  readonly snapshots = new Map<string, { snapshot: Uint8Array; revision: number }>();
  readonly project = vi.fn();
  private nextStore: { entered: () => void; held: Promise<void> } | null = null;
  seed(folderId: string, boardItems: CatalogBoardItemRow[]) {
    this.snapshots.set(`board-folder:${folderId}`, { snapshot: createBoardYDocSnapshot({ folderId, boardItems, markdownDocuments: [] }), revision: 1 });
  }
  async loadBoardYjsSnapshot(name: string) { return this.snapshots.get(name) ?? null; }
  async resolveBoardYjsFolderScope(scope: { folderId: string }) { return scope; }
  async loadBoardYjsSeed() { return { boardItems: [], markdownDocuments: [] }; }
  readonly storeBoardYjsSnapshot = vi.fn(async (name: string, snapshot: Uint8Array, expected: number | null, projection?: BoardYjsSnapshotProjection) => {
    const blocked = this.nextStore;
    this.nextStore = null;
    if (blocked) { blocked.entered(); await blocked.held; }
    return this.save(name, snapshot, expected, projection);
  });
  private save(name: string, snapshot: Uint8Array, expected: number | null, projection?: BoardYjsSnapshotProjection) {
    if ((this.snapshots.get(name)?.revision ?? null) !== expected) return null;
    const stored = { snapshot, revision: (expected ?? 0) + 1 };
    this.snapshots.set(name, stored);
    if (projection) this.project(projection);
    return stored;
  }
  async apply(applications: readonly BoardYjsDocumentApplication[]) {
    for (const application of applications) this.save(application.documentName, application.snapshot,
      this.snapshots.get(application.documentName)?.revision ?? null, { scope: application.scope, replica: application.replica });
  }
  items(folderId: string) {
    const doc = new Y.Doc();
    const snapshot = this.snapshots.get(`board-folder:${folderId}`)?.snapshot;
    if (snapshot) Y.applyUpdate(doc, snapshot);
    return readBoardYDocReplica({ folderId }, doc).boardItems;
  }
  blockNextStore() {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    this.nextStore = { entered, held };
    return { entered: started, release };
  }
}

async function connect(f: ReturnType<typeof fixture>) {
  const app = Fastify({ logger: false });
  registerBoardYjsRoutes(app, { createService: () => f.board });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const configuration = { url: `${address.replace("http", "ws")}/yjs/target`, name: "board-folder:target",
    document: new Y.Doc(), token: "test-token", WebSocketPolyfill: WebSocket,
  } as HocuspocusProviderConfiguration & { WebSocketPolyfill: typeof WebSocket };
  const provider = new HocuspocusProvider(configuration);
  cleanups.push(async () => { provider.destroy(); });
  await waitFor(() => provider.isSynced);
  return provider;
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
