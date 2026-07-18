import { describe, expect, it, vi } from "vitest";

import {
  CustomViewRevisionConflictError,
  CustomViewService,
} from "../../src/custom_view/custom_view_service.js";
import type { CatalogBoardItemRow, CustomViewRow } from "../../src/db/session_db_types.js";
import type { CustomViewRepository } from "../../src/db/repositories/custom_view_repository.js";

const customView: CustomViewRow = {
  id: "cv-1",
  boardItemId: "custom_view:cv-1",
  title: "Progress panel",
  html: "<section></section>",
  revision: 1,
  archived: false,
  createdSessionId: "sess-actor",
  createdEventId: 1,
  updatedSessionId: "sess-actor",
  updatedEventId: 1,
};

const boardItem: CatalogBoardItemRow = {
  id: "custom_view:cv-1",
  folderId: "folder-1",
  containerKind: "task",
  containerId: "rb-1",
  membershipKind: "primary",
  sourceTaskItemId: null,
  itemType: "custom_view",
  itemId: "cv-1",
  x: 120,
  y: 240,
  metadata: {},
};

describe("CustomViewService", () => {
  it("creates the board tile through Y.Doc before inserting the custom view row", async () => {
    const order: string[] = [];
    const repo = {
      getCustomView: vi.fn(async () => null),
      transaction: vi.fn(async (fn: (sql: unknown) => Promise<void>) => fn({})),
      createCustomViewTx: vi.fn(async (_sql: unknown, params: { id: string; boardItemId: string }) => {
        order.push("db");
        return {
          ...customView,
          id: params.id,
          boardItemId: params.boardItemId,
        };
      }),
    };
    const boardYjs = {
      upsertCustomViewBoardItem: vi.fn(async (input: { boardItemId: string; customViewId: string }) => {
        order.push("yjs");
        return {
          ...boardItem,
          id: input.boardItemId,
          itemId: input.customViewId,
        };
      }),
      removeBoardItem: vi.fn(async () => undefined),
    };
    const service = new CustomViewService(
      {
        customViews: () => repo as unknown as CustomViewRepository,
        appendEventTx: vi.fn(async () => 7),
        getCatalog: vi.fn(async () => ({ folders: [], sessions: {}, boardItems: [] })),
        resolveBoardYjsContainerScope: vi.fn(async () => ({
          folderId: "folder-1",
          containerKind: "task",
          containerId: "rb-1",
        })),
      },
      boardYjs,
      {
        emitCatalogUpdated: vi.fn(async () => undefined),
        emitCustomViewUpdated: vi.fn(async () => undefined),
      },
    );

    const result = await service.createCustomView({
      actorSessionId: "sess-actor",
      container: { containerKind: "task", containerId: "rb-1" },
      title: "Progress panel",
      html: "<section></section>",
      x: 120,
      y: 240,
      idempotencyKey: "idem-create-custom-view",
    });

    expect(order).toEqual(["yjs", "db"]);
    expect(result.boardItem.itemType).toBe("custom_view");
    expect(repo.createCustomViewTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        boardItemId: result.boardItem.id,
        html: "<section></section>",
      }),
    );
  });

  it("propagates revision CAS conflicts without updating the Y.Doc board item", async () => {
    const repo = {
      getCustomView: vi.fn(async () => ({
        customView: { ...customView, revision: 5 },
        boardItem,
      })),
      transaction: vi.fn(async (fn: (sql: unknown) => Promise<void>) => fn({})),
      patchCustomViewTx: vi.fn(async () => {
        throw new CustomViewRevisionConflictError("cv-1", 3, 5);
      }),
    };
    const boardYjs = {
      upsertCustomViewBoardItem: vi.fn(async () => boardItem),
      removeBoardItem: vi.fn(async () => undefined),
    };
    const service = new CustomViewService(
      {
        customViews: () => repo as unknown as CustomViewRepository,
        appendEventTx: vi.fn(async () => 8),
        getCatalog: vi.fn(async () => ({ folders: [], sessions: {}, boardItems: [] })),
        resolveBoardYjsContainerScope: vi.fn(async () => ({
          folderId: "folder-1",
          containerKind: "task",
          containerId: "rb-1",
        })),
      },
      boardYjs,
    );

    await expect(service.patchCustomView({
      actorSessionId: "sess-actor",
      customViewId: "cv-1",
      expectedRevision: 3,
      title: "Progress panel v2",
      html: "<main></main>",
      idempotencyKey: "idem-patch-custom-view",
    })).rejects.toBeInstanceOf(CustomViewRevisionConflictError);

    expect(boardYjs.upsertCustomViewBoardItem).not.toHaveBeenCalled();
  });
});
