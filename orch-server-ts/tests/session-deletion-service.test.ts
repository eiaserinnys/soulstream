import { describe, expect, it, vi } from "vitest";

import { assertBoardItemProjectionParity } from
  "../src/board-yjs/board_yjs_projection_verification.js";
import type {
  BoardYjsContainerScope,
  BoardYjsReplica,
  CatalogBoardItemRow,
} from "../src/board-yjs/board_yjs_types.js";
import {
  SessionDeletionService,
  type SessionDeletionBoardApplication,
} from "../src/session/session_deletion_service.js";

describe("SessionDeletionService", () => {
  it("removes every projected session card from canonical replicas before deleting the session", async () => {
    const events: string[] = [];
    const boardItems = [
      sessionBoardItem("session:session-a", "folder", "folder-1"),
      sessionBoardItem("session-reference:session-a", "task", "task-1", "reference"),
    ];
    const applications = [
      boardApplication({
        folderId: "folder-1",
        containerKind: "folder",
        containerId: "folder-1",
      }),
      boardApplication({
        folderId: "folder-1",
        containerKind: "task",
        containerId: "task-1",
      }),
    ];
    const deleteSession = vi.fn(async (input: {
      sessionId: string;
      boardApplications: readonly SessionDeletionBoardApplication[];
    }) => {
      events.push("delete-session");
      expect(input.sessionId).toBe("session-a");
      expect(input.boardApplications).toBe(applications);
      for (const application of input.boardApplications) {
        assertBoardItemProjectionParity({
          label: application.documentName,
          ydocItems: application.replica.boardItems,
          projectionItems: [],
        });
      }
    });
    const service = new SessionDeletionService({
      board: {
        async withBoardItemRemovalApplications(items, persist) {
          events.push("stage-canonical-removal");
          expect(items).toEqual(boardItems);
          const result = await persist(applications);
          events.push("commit-live-ydoc");
          return result;
        },
      },
      repository: {
        async listSessionBoardItems(sessionId) {
          events.push("list-session-cards");
          expect(sessionId).toBe("session-a");
          return boardItems;
        },
        deleteSession,
      },
    });

    await service.deleteSession("session-a");

    expect(events).toEqual([
      "list-session-cards",
      "stage-canonical-removal",
      "delete-session",
      "commit-live-ydoc",
    ]);
    expect(deleteSession).toHaveBeenCalledOnce();
  });

  it("deletes an unmounted session without fabricating a Y.Doc application", async () => {
    const deleteSession = vi.fn().mockResolvedValue(undefined);
    const board = {
      withBoardItemRemovalApplications: vi.fn(),
    };
    const service = new SessionDeletionService({
      board,
      repository: {
        listSessionBoardItems: vi.fn().mockResolvedValue([]),
        deleteSession,
      },
    });

    await service.deleteSession("session-unmounted");

    expect(board.withBoardItemRemovalApplications).not.toHaveBeenCalled();
    expect(deleteSession).toHaveBeenCalledWith({
      sessionId: "session-unmounted",
      boardApplications: [],
    });
  });
});

function sessionBoardItem(
  id: string,
  containerKind: "folder" | "task",
  containerId: string,
  membershipKind: "primary" | "reference" = "primary",
): CatalogBoardItemRow {
  return {
    id,
    folderId: "folder-1",
    containerKind,
    containerId,
    membershipKind,
    itemType: "session",
    itemId: "session-a",
    x: 0,
    y: 0,
    metadata: {},
  };
}

function boardApplication(
  scope: BoardYjsContainerScope,
): SessionDeletionBoardApplication {
  const replica: BoardYjsReplica = { boardItems: [], markdownDocuments: [] };
  return {
    documentName: `board-${scope.containerKind}:${scope.containerId}`,
    scope,
    snapshot: new Uint8Array(),
    replica,
  };
}
