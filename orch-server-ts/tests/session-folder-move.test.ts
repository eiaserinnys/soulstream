import { describe, expect, it, vi } from "vitest";
import { SessionFolderMoveService } from "../src/session/session_folder_move_service.js";

describe("session folder move", () => {
  it("moves the session tree and emits folder and card notifications after commit", async () => {
    const commit = vi.fn(async () => ({ cards: [{ cardId: "card", sourceFolderId: "a", folderId: "b" }], folderIds: ["a", "b"] }));
    const onCardsMoveCommitted = vi.fn(async () => {});
    const onFoldersMoveCommitted = vi.fn(async () => {});
    const service = new SessionFolderMoveService({ repository: {
      listSessionMoveTree: async () => ["root", "child"],
      areSessionAssignmentsInFolder: async () => false,
      commitSessionMove: commit,
    }, onCardsMoveCommitted, onFoldersMoveCommitted });
    await expect(service.moveSessionsToFolder(["root"], "b")).resolves.toEqual({ count: 2, sessionIds: ["root", "child"], didCommit: true });
    expect(commit).toHaveBeenCalledWith({ sessionId: "root", sessionIds: ["root", "child"], folderId: "b" });
    expect(onCardsMoveCommitted).toHaveBeenCalledOnce();
    expect(onFoldersMoveCommitted).toHaveBeenCalledWith(["a", "b"]);
  });

  it("does not write or notify when all assignments already match", async () => {
    const commit = vi.fn();
    const notify = vi.fn();
    const service = new SessionFolderMoveService({ repository: {
      listSessionMoveTree: async () => ["root"], areSessionAssignmentsInFolder: async () => true, commitSessionMove: commit,
    }, onFoldersMoveCommitted: notify });
    await expect(service.moveSessionsToFolder(["root"], "a")).resolves.toEqual({ count: 1, sessionIds: ["root"], didCommit: false });
    expect(commit).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
