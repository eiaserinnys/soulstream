import { describe, expect, it, vi } from "vitest";
import { SessionBoardMoveService } from "../src/session/session_board_move_service.js";

// Reuse session-board-move.test.ts's injected board/repository ports.
describe("session tree move", () => {
  it("stages all descendants once and commits their assigned cards before broadcasting", async () => {
    const order: string[] = [];
    const tree = ["root", "child", "grandchild"];
    const commitSessionMove = vi.fn(async () => { order.push("commit"); });
    const listSessionMoveTree = vi.fn(async () => tree);
    const moved = { id: "session:root", itemType: "session" as const, itemId: "root", folderId: "target", x: 0, y: 0, metadata: {} };
    const service = new SessionBoardMoveService({
      repository: {
        listSessionMoveTree,
        listSessionBoardItems: vi.fn(async () => []),
        commitSessionMove,
      },
      board: {
        async withSessionBoardMoveApplications(input: import("../src/board-yjs/board_yjs_move.js").SessionBoardMoveInput, persist: (move: import("../src/board-yjs/board_yjs_move.js").StagedSessionBoardMove) => Promise<unknown>) {
          expect(input.sessionIds).toEqual(tree);
          await persist({ movedBoardItem: moved, boardApplications: [] });
          order.push("live");
          return moved;
        },
      },
      onBoardMoveCommitted: vi.fn(async (result: { sessionIds: string[] }) => {
        expect(result.sessionIds).toEqual(tree);
        order.push("broadcast");
      }),
    } as never);

    await service.moveSessionBoardItem({ sessionId: "root", targetScope: { folderId: "target" } });
    expect(commitSessionMove).toHaveBeenCalledWith({ sessionId: "root", sessionIds: tree, folderId: "target", boardApplications: [] });
    expect(order).toEqual(["commit", "live", "broadcast"]);
  });

  it("resolves overlapping selected roots as one move set", async () => {
    const listSessionMoveTree = vi.fn(async () => ["root", "child", "grandchild"]);
    const commitSessionMove = vi.fn(async () => undefined);
    const service = new SessionBoardMoveService({
      repository: { listSessionMoveTree, listSessionBoardItems: vi.fn(async () => []), commitSessionMove },
      board: { async withSessionBoardMoveApplications(_input: import("../src/board-yjs/board_yjs_move.js").SessionBoardMoveInput, persist: (move: import("../src/board-yjs/board_yjs_move.js").StagedSessionBoardMove) => Promise<unknown>) {
        await persist({ movedBoardItem: null, boardApplications: [] });
        return null;
      } },
    } as never);
    await service.moveSessionsToFolder(["root", "child"], "target");
    expect(listSessionMoveTree).toHaveBeenCalledWith(["root", "child"]);
    expect(commitSessionMove).toHaveBeenCalledTimes(1);
  });
});
