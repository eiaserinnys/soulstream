import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { BoardYjsDocumentMutationGate } from
  "../src/board-yjs/board_yjs_document_mutation_gate.js";
import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import type { CatalogBoardItemRow } from "../src/board-yjs/board_yjs_types.js";

describe("Board Y.Doc migration/mutation gate", () => {
  it("serializes a direct mutation behind migration so it cannot save a stale snapshot", async () => {
    const gate = new BoardYjsDocumentMutationGate();
    const migrationEntered = deferred<void>();
    const releaseMigration = deferred<void>();
    let persisted = "legacy";
    let mutationObserved: string | null = null;

    const migration = gate.withMigration(["board:task:task-a"], async () => {
      migrationEntered.resolve();
      await releaseMigration.promise;
      persisted = "migrated";
    });
    await migrationEntered.promise;

    const mutation = gate.withMutation(["board:task:task-a"], async () => {
      mutationObserved = persisted;
      persisted = `${persisted}+mutation`;
    });
    await Promise.resolve();
    expect(mutationObserved).toBeNull();

    releaseMigration.resolve();
    await Promise.all([migration, mutation]);
    expect(mutationObserved).toBe("migrated");
    expect(persisted).toBe("migrated+mutation");
  });

  it("blocks every Board Y.Doc mutation entry point at the same guard", async () => {
    const service = createNodeService();
    const deny = vi.fn(async () => {
      throw new Error("document mutation gate denied");
    });
    Object.assign(service as unknown as { documentMutationGate: unknown }, {
      documentMutationGate: {
        withMutation: deny,
        withMigration: vi.fn(),
        isMigrationActive: vi.fn(() => false),
      },
    });

    const paths = [
      {
        name: "withDirectContainerConnection",
        expectedNames: ["board-folder:folder-a"],
        run: () => service.removeBoardItem(
          { containerKind: "folder" as const, containerId: "folder-a" },
          "session:a",
        ),
      },
      {
        name: "withTaskBoardApplication",
        expectedNames: ["board-folder:folder-a"],
        run: () => service.withTaskBoardApplication({
          folderId: "folder-a",
          boardItemId: "task:task-a",
          taskId: "task-a",
          title: "Task A",
          archived: false,
          x: 0,
          y: 0,
        }, vi.fn()),
      },
      {
        name: "moveBoardItemBetweenDocuments",
        expectedNames: ["board-folder:folder-a", "board:task:task-a"],
        run: () => service.moveBoardItemToContainer({
          boardItem: boardItem("session"),
          targetScope: {
            folderId: "folder-a",
            containerKind: "task",
            containerId: "task-a",
          },
        }),
      },
      {
        name: "staged task board move",
        expectedNames: ["board-folder:folder-a", "board:task:task-a"],
        run: () => service.withTaskBoardMoveApplication({
          boardItem: boardItem("task"),
          targetScope: {
            folderId: "folder-a",
            containerKind: "task",
            containerId: "task-a",
          },
        }, vi.fn()),
      },
    ];

    for (const path of paths) {
      deny.mockClear();
      await expect(path.run(), path.name).rejects.toThrow("document mutation gate denied");
      expect(deny, path.name).toHaveBeenCalledOnce();
      expect(deny, path.name).toHaveBeenCalledWith(path.expectedNames, expect.any(Function));
    }
    await service.close();
  });
});

function boardItem(itemType: "session" | "task"): CatalogBoardItemRow {
  return {
    id: `${itemType}:a`,
    folderId: "folder-a",
    containerKind: "folder",
    containerId: "folder-a",
    membershipKind: "primary",
    sourceTaskItemId: null,
    itemType,
    itemId: "a",
    x: 0,
    y: 0,
    metadata: {},
  };
}

function createNodeService(): BoardYjsService {
  return new BoardYjsService({
    repository: {} as never,
    logger: silentLogger(),
    hostMode: "node",
    auth: {
      authBearerToken: "test-token",
      environment: "production",
      dashboardAuthEnabled: false,
      verifyDashboardToken: vi.fn().mockResolvedValue(null),
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function silentLogger(): FastifyBaseLogger {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => logger, level: "silent", silent: vi.fn(),
  };
  return logger as unknown as FastifyBaseLogger;
}
