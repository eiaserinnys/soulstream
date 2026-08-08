import { describe, expect, it, vi } from "vitest";

import type {
  BoardYjsDocumentApplication,
  CatalogBoardItemRow,
} from "../src/board-yjs/board_yjs_types.js";
import {
  SessionBoardMoveService,
} from "../src/session/session_board_move_service.js";

describe("SessionBoardMoveService", () => {
  it("uses projection and cache inventory to remove every stale primary source and create the target", async () => {
    const sourceItems = [
      sessionItem("folder-old-a"),
      sessionItem("folder-old-b"),
      sessionItem("task-reference", "task", "reference", "session-reference:session-a"),
    ];
    const applications = [
      application("folder-old-a", []),
      application("folder-old-b", []),
      application("folder-target", [sessionItem("folder-target")]),
    ];
    const commitSessionMove = vi.fn(async () => undefined);
    const service = new SessionBoardMoveService({
      board: {
        async withSessionBoardMoveApplications(input, persist) {
          expect(input.sessionId).toBe("session-a");
          expect(input.boardItems).toEqual(sourceItems);
          expect(input.targetScope).toEqual({
            folderId: "folder-target",
            containerKind: "folder",
            containerId: "folder-target",
          });
          await persist({
            movedBoardItem: sessionItem("folder-target"),
            boardApplications: applications,
          });
          return sessionItem("folder-target");
        },
      },
      repository: {
        listSessionBoardItems: vi.fn(async () => sourceItems),
        commitSessionMove,
      },
    });

    const moved = await service.moveSessionToFolder("session-a", "folder-target");

    expect(moved).toMatchObject({
      id: "session:session-a",
      folderId: "folder-target",
      containerKind: "folder",
      containerId: "folder-target",
    });
    expect(commitSessionMove).toHaveBeenCalledWith({
      sessionId: "session-a",
      folderId: "folder-target",
      boardApplications: applications,
    });
  });

  it("removes canonical cards without fabricating a destination when folder is null", async () => {
    const sourceItems = [sessionItem("folder-old")];
    const applicationRows = [application("folder-old", [])];
    const commitSessionMove = vi.fn(async () => undefined);
    const service = new SessionBoardMoveService({
      board: {
        async withSessionBoardMoveApplications(input, persist) {
          expect(input.targetScope).toBeNull();
          await persist({ movedBoardItem: null, boardApplications: applicationRows });
          return null;
        },
      },
      repository: {
        listSessionBoardItems: vi.fn(async () => sourceItems),
        commitSessionMove,
      },
    });

    await expect(service.moveSessionToFolder("session-a", null)).resolves.toBeNull();
    expect(commitSessionMove).toHaveBeenCalledWith({
      sessionId: "session-a",
      folderId: null,
      boardApplications: applicationRows,
    });
  });

  it("serializes inventory reads so a concurrent move sees the preceding destination", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = deferred<void>();
    const inventory = [sessionItem("folder-old")];
    const listSessionBoardItems = vi.fn(async () => [...inventory]);
    let moveNumber = 0;
    const service = new SessionBoardMoveService({
      board: {
        async withSessionBoardMoveApplications(input, persist) {
          moveNumber += 1;
          if (moveNumber === 1) {
            firstEntered.resolve();
            await firstBlocked;
          }
          const moved = sessionItem(input.targetScope!.containerId);
          await persist({ movedBoardItem: moved, boardApplications: [] });
          inventory.splice(0, inventory.length, moved);
          return moved;
        },
      },
      repository: {
        listSessionBoardItems,
        commitSessionMove: vi.fn(async () => undefined),
      },
    });

    const first = service.moveSessionToFolder("session-a", "folder-first");
    await firstEntered.promise;
    const second = service.moveSessionToFolder("session-a", "folder-second");
    await Promise.resolve();
    expect(listSessionBoardItems).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(listSessionBoardItems).toHaveBeenCalledTimes(2);
    expect(inventory[0]?.containerId).toBe("folder-second");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sessionItem(
  containerId: string,
  containerKind: "folder" | "task" = "folder",
  membershipKind: "primary" | "reference" = "primary",
  id = "session:session-a",
): CatalogBoardItemRow {
  return {
    id,
    folderId: containerKind === "folder" ? containerId : "folder-target",
    containerKind,
    containerId,
    membershipKind,
    sourceTaskItemId: null,
    itemType: "session",
    itemId: "session-a",
    x: 0,
    y: 0,
    metadata: {},
  };
}

function application(
  containerId: string,
  boardItems: CatalogBoardItemRow[],
): BoardYjsDocumentApplication {
  return {
    documentName: `board-folder:${containerId}`,
    scope: { folderId: containerId, containerKind: "folder", containerId },
    snapshot: new Uint8Array(),
    replica: { boardItems, markdownDocuments: [] },
  };
}
