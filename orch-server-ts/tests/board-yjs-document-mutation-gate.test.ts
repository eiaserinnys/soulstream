import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { BoardYjsDocumentMutationGate } from
  "../src/board-yjs/board_yjs_document_mutation_gate.js";
import { BoardYjsService } from "../src/board-yjs/board_yjs_service.js";
import type { CatalogBoardItemRow } from "../src/board-yjs/board_yjs_types.js";

describe("Board Y.Doc mutation gate", () => {
  it("blocks every Board Y.Doc mutation entry point at the same guard", async () => {
    const service = createNodeService();
    const deny = vi.fn(async () => {
      throw new Error("document mutation gate denied");
    });
    Object.assign(service as unknown as { documentMutationGate: unknown }, {
      documentMutationGate: {
        withMutation: deny,
      },
    });

    const paths = [
      {
        name: "withDirectContainerConnection",
        expectedNames: ["board-folder:folder-a"],
        run: () => service.removeBoardItem(
          {  folderId: "folder-a" },
          "session:a",
        ),
      },
      {
        name: "folder identity",
        expectedNames: ["board-folder:folder-a"],
        run: () => service.withFolderBoardApplication({
          folderId: "child", parentFolderId: "folder-a", previousParentFolderId: null,
          title: "Child", archived: false,
        }, vi.fn()),
      },
      {
        name: "staged session board move",
        expectedNames: ["board-folder:folder-a", "board-folder:folder-b"],
        run: () => service.withSessionBoardMoveApplications({
          sessionId: "a",
          boardItems: [boardItem("session")],
          targetScope: {
            folderId: "folder-b",
            },
        }, vi.fn()),
      },
      {
        name: "folder identity move",
        expectedNames: ["board-folder:folder-a", "board-folder:folder-b"],
        run: () => service.withFolderBoardApplication({
          folderId: "child", parentFolderId: "folder-b", previousParentFolderId: "folder-a",
          title: "Child", archived: false,
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

function boardItem(itemType: "session" | "subfolder"): CatalogBoardItemRow {
  return {
    id: `${itemType}:a`,
    folderId: "folder-a",
    membershipKind: "primary",
    sourceChecklistItemId: null,
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
    persistBoardItemMove: vi.fn(),
    logger: silentLogger(),
    auth: {
      authBearerToken: "test-token",
      environment: "production",
      dashboardAuthEnabled: false,
      resolveDashboardUserFromHeaders: vi.fn().mockResolvedValue(null),
    },
  });
}

function silentLogger(): FastifyBaseLogger {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
    child: () => logger, level: "silent", silent: vi.fn(),
  };
  return logger as unknown as FastifyBaseLogger;
}
