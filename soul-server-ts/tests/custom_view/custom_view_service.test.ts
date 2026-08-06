import { describe, expect, it, vi } from "vitest";

import {
  CustomViewRevisionConflictError,
  CustomViewService,
} from "../../src/custom_view/custom_view_service.js";
import type { CatalogBoardItemRow, CustomViewRow } from "../../src/db/session_db_types.js";

const customView: CustomViewRow = {
  id: "cv-1",
  boardItemId: "custom_view:cv-1",
  title: "Progress panel",
  html: "<section></section>",
  revision: 1,
  archived: false,
  createdActorKind: "agent",
  createdSessionId: "sess-actor",
  createdEventId: 1,
  updatedActorKind: "agent",
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
    const createCustomViewRecord = vi.fn(
      async (params: { id: string; boardItemId: string }) => {
        order.push("db");
        return {
          customView: {
            ...customView,
            id: params.id,
            boardItemId: params.boardItemId,
          },
          eventId: 7,
        };
      },
    );
    const boardYjs = {
      getCustomView: vi.fn(async () => null),
      createCustomViewRecord,
      upsertCustomViewBoardItem: vi.fn(async (input: { boardItemId: string; customViewId: string }) => {
        order.push("yjs");
        return {
          ...boardItem,
          id: input.boardItemId,
          itemId: input.customViewId,
        };
      }),
      removeBoardItem: vi.fn(async () => undefined),
      resolveBoardYjsContainerScope: vi.fn(async () => ({
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "rb-1",
      })),
    };
    const emitCatalogUpdated = vi.fn(async () => undefined);
    const emitCustomViewUpdated = vi.fn(async () => undefined);
    const service = new CustomViewService(
      {
        getAllFolders: vi.fn(async () => []),
      },
      boardYjs as never,
      {
        emitCatalogUpdated,
        emitCustomViewUpdated,
      },
    );

    const result = await service.createCustomView({
      actorKind: "agent",
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
    expect(createCustomViewRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        boardItemId: result.boardItem.id,
        html: "<section></section>",
      }),
    );
    expect(emitCatalogUpdated).toHaveBeenCalledWith(
      [],
      {},
      {
        [result.boardItem.id]: result.boardItem,
      },
    );
    expect(emitCustomViewUpdated).toHaveBeenCalledWith(
      "sess-actor",
      result.customView.id,
      result.boardItem.id,
      1,
    );
  });

  it("propagates revision CAS conflicts without updating the Y.Doc board item", async () => {
    const boardYjs = {
      getCustomView: vi.fn(async () => ({
        customView: { ...customView, revision: 5 },
        boardItem,
      })),
      patchCustomViewRecord: vi.fn(async () => {
        throw new CustomViewRevisionConflictError("cv-1", 3, 5);
      }),
      upsertCustomViewBoardItem: vi.fn(async () => boardItem),
      removeBoardItem: vi.fn(async () => undefined),
      resolveBoardYjsContainerScope: vi.fn(async () => ({
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "rb-1",
      })),
    };
    const service = new CustomViewService(
      {
        getAllFolders: vi.fn(async () => []),
      },
      boardYjs as never,
    );

    await expect(service.patchCustomView({
      actorKind: "agent",
      actorSessionId: "sess-actor",
      customViewId: "cv-1",
      expectedRevision: 3,
      title: "Progress panel v2",
      html: "<main></main>",
      idempotencyKey: "idem-patch-custom-view",
    })).rejects.toBeInstanceOf(CustomViewRevisionConflictError);

    expect(boardYjs.upsertCustomViewBoardItem).not.toHaveBeenCalled();
  });

  it("외부 llm 변경은 이벤트 없이 llm provenance를 저장하고 catalog만 갱신한다", async () => {
    const createCustomViewRecord = vi.fn(async (params: {
      actorKind: "llm";
      actorSessionId: null;
    }) => ({
      customView: {
        ...customView,
        createdActorKind: params.actorKind,
        createdSessionId: params.actorSessionId,
        createdEventId: null,
        updatedActorKind: params.actorKind,
        updatedSessionId: params.actorSessionId,
        updatedEventId: null,
      },
      eventId: null,
    }));
    const boardYjs = {
      getCustomView: vi.fn(async () => null),
      createCustomViewRecord,
      upsertCustomViewBoardItem: vi.fn(async () => boardItem),
      removeBoardItem: vi.fn(async () => undefined),
      resolveBoardYjsContainerScope: vi.fn(async () => ({
        folderId: "folder-1",
        containerKind: "task" as const,
        containerId: "rb-1",
      })),
    };
    const emitCatalogUpdated = vi.fn(async () => undefined);
    const emitCustomViewUpdated = vi.fn(async () => undefined);
    const service = new CustomViewService(
      {
        getAllFolders: vi.fn(async () => []),
      },
      boardYjs as never,
      { emitCatalogUpdated, emitCustomViewUpdated },
    );

    const result = await service.createCustomView({
      actorKind: "llm",
      actorSessionId: null,
      container: { containerKind: "task", containerId: "rb-1" },
      title: "LLM panel",
      html: "<section></section>",
      idempotencyKey: "idem-llm-custom-view",
    });

    expect(createCustomViewRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: "llm",
        actorSessionId: null,
      }),
    );
    expect(result.eventId).toBeNull();
    expect(emitCatalogUpdated).toHaveBeenCalledOnce();
    expect(emitCustomViewUpdated).not.toHaveBeenCalled();
  });
});
