import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  createBoardYDocSnapshot,
  readBoardYDocReplica,
} from "../src/board-yjs/board_yjs_model.js";
import {
  createBoardYjsPersistence,
  type BoardYjsPersistenceRepository,
} from "../src/board-yjs/board_yjs_persistence.js";

describe("orch board Yjs persistence", () => {
  it("returns the winning snapshot when two connections bootstrap the same missing document", async () => {
    const scope = {
      folderId: "folder-race",
      containerKind: "folder" as const,
      containerId: "folder-race",
    };
    let storedSnapshot: Uint8Array | null = null;
    let storedRevision: number | null = null;
    let initialReads = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReadsStarted = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    const repository = {
      loadBoardYjsSnapshot: vi.fn(async () => {
        initialReads += 1;
        if (initialReads === 2) releaseInitialReads();
        await bothInitialReadsStarted;
        return storedSnapshot && storedRevision
          ? { snapshot: storedSnapshot, revision: storedRevision }
          : null;
      }),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      loadBoardYjsSeed: vi.fn()
        .mockResolvedValueOnce({
          boardItems: [{
            id: "session:first",
            folderId: scope.folderId,
            itemType: "session",
            itemId: "first",
            x: 0,
            y: 0,
            metadata: {},
          }],
          markdownDocuments: [],
        })
        .mockResolvedValueOnce({
          boardItems: [{
            id: "session:second",
            folderId: scope.folderId,
            itemType: "session",
            itemId: "second",
            x: 0,
            y: 0,
            metadata: {},
          }],
          markdownDocuments: [],
        }),
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        snapshot: Uint8Array,
        expectedRevision: number | null,
      ) => {
        if (expectedRevision !== storedRevision) return null;
        storedSnapshot = snapshot;
        storedRevision = (storedRevision ?? 0) + 1;
        return { snapshot, revision: storedRevision };
      }),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);

    const [first, second] = await Promise.all([
      persistence.database.configuration.fetch?.({
        documentName: "board-folder:folder-race",
      } as never),
      persistence.database.configuration.fetch?.({
        documentName: "board-folder:folder-race",
      } as never),
    ]);

    expect(storedSnapshot).not.toBeNull();
    expect(Buffer.from(first as Uint8Array)).toEqual(Buffer.from(storedSnapshot!));
    expect(Buffer.from(second as Uint8Array)).toEqual(Buffer.from(storedSnapshot!));
  });

  it("seeds and projects a missing snapshot in one CAS write", async () => {
    const scope = {
      folderId: "folder-1",
      containerKind: "folder" as const,
      containerId: "folder-1",
    };
    const repository = {
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      loadBoardYjsSeed: vi.fn().mockResolvedValue({
        boardItems: [{
          id: "session:s1",
          folderId: "folder-1",
          itemType: "session",
          itemId: "s1",
          x: 0,
          y: 0,
          metadata: {},
        }],
        markdownDocuments: [],
      }),
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        encoded: Uint8Array,
      ) => ({ snapshot: encoded, revision: 1 })),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);

    const snapshot = await persistence.database.configuration.fetch?.({
      documentName: "board-folder:folder-1",
    } as never);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, snapshot as Uint8Array);
    expect(readBoardYDocReplica(scope, doc).boardItems.map((item) => item.id))
      .toEqual(["session:s1"]);
    expect(repository.storeBoardYjsSnapshot).toHaveBeenCalledWith(
      "board-folder:folder-1",
      expect.any(Uint8Array),
      null,
      {
        scope,
        replica: expect.objectContaining({
          boardItems: [expect.objectContaining({ id: "session:s1" })],
        }),
      },
    );
  });

  it("store derives the replica from the supplied Y.Doc state", async () => {
    const scope = {
      folderId: "folder-1",
      containerKind: "folder" as const,
      containerId: "folder-1",
    };
    const state = createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "session:s1",
        folderId: "folder-1",
        itemType: "session",
        itemId: "s1",
        x: 280,
        y: 160,
        metadata: {},
      }],
      markdownDocuments: [],
    });
    const document = new Y.Doc();
    Y.applyUpdate(document, state);
    const repository = {
      loadBoardYjsSnapshot: vi.fn().mockResolvedValue(null),
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        snapshot: Uint8Array,
      ) => ({ snapshot, revision: 1 })),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);

    await persistence.database.configuration.store?.({
      documentName: "board-folder:folder-1",
      state,
      document,
    } as never);

    expect(repository.storeBoardYjsSnapshot).toHaveBeenCalledWith(
      "board-folder:folder-1",
      expect.any(Uint8Array),
      null,
      {
        scope,
        replica: expect.objectContaining({
          boardItems: [expect.objectContaining({ id: "session:s1", x: 280, y: 160 })],
        }),
      },
    );
  });

  it("merges the winning CRDT snapshot before retrying a conflicted store", async () => {
    const scope = {
      folderId: "folder-merge",
      containerKind: "folder" as const,
      containerId: "folder-merge",
    };
    const localSnapshot = createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "session:local",
        folderId: scope.folderId,
        itemType: "session",
        itemId: "local",
        x: 0,
        y: 0,
        metadata: {},
      }],
      markdownDocuments: [],
    });
    const concurrentSnapshot = createBoardYDocSnapshot({
      ...scope,
      boardItems: [{
        id: "session:concurrent",
        folderId: scope.folderId,
        itemType: "session",
        itemId: "concurrent",
        x: 280,
        y: 160,
        metadata: {},
      }],
      markdownDocuments: [],
    });
    let current = {
      snapshot: createBoardYDocSnapshot({
        ...scope,
        boardItems: [],
        markdownDocuments: [],
      }),
      revision: 1,
    };
    const repository = {
      loadBoardYjsSnapshot: vi.fn(async () => current),
      resolveBoardYjsContainerScope: vi.fn().mockResolvedValue(scope),
      storeBoardYjsSnapshot: vi.fn(async (
        _documentName: string,
        snapshot: Uint8Array,
        expectedRevision: number | null,
      ) => {
        if (expectedRevision === 1) {
          current = { snapshot: concurrentSnapshot, revision: 2 };
          return null;
        }
        current = { snapshot, revision: 3 };
        return current;
      }),
    } as unknown as BoardYjsPersistenceRepository;
    const persistence = createBoardYjsPersistence(repository);
    const document = new Y.Doc();
    Y.applyUpdate(document, localSnapshot);

    await persistence.database.configuration.store?.({
      documentName: "board-folder:folder-merge",
      state: localSnapshot,
      document,
    } as never);

    expect(repository.storeBoardYjsSnapshot).toHaveBeenCalledTimes(2);
    const stored = new Y.Doc();
    Y.applyUpdate(stored, current.snapshot);
    expect(readBoardYDocReplica(scope, stored).boardItems.map((item) => item.id).sort())
      .toEqual(["session:concurrent", "session:local"]);
  });
});
