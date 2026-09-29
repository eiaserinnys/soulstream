import { describe, expect, it, vi } from "vitest";

import {
  dispatchBoardProjectionHostOperation,
  getBoardProjectionHostOperationSchema,
} from "../src/board-yjs/board_projection_host_operations.js";

describe("board projection host operations", () => {
  it("validates and dispatches board items scoped to a folder and container", async () => {
    const container = {  folderId: "task-1" };
    const input = { folderId: "root", container };
    const schema = getBoardProjectionHostOperationSchema("get-board-items-by-container");
    const getBoardItemsByContainer = vi.fn(async () => [{ id: "markdown:doc-1" }]);

    expect(schema).toBeDefined();
    expect(schema?.parse(input)).toEqual(input);
    await expect(dispatchBoardProjectionHostOperation(
      "get-board-items-by-container",
      input,
      { getBoardItemsByContainer } as never,
    )).resolves.toEqual([{ id: "markdown:doc-1" }]);
    expect(getBoardItemsByContainer).toHaveBeenCalledWith("root", container);
  });

  it("validates and dispatches the checklist dead-letter transition", async () => {
    const row = {
      block_id: "block-1",
      page_id: "page-1",
      source_hash: "hash-1",
      actor_kind: "agent" as const,
      actor_session_id: "session-1",
      actor_user_id: null,
      routing_session_id: "session-1",
      attempts: 7,
    };
    const input = { row, nodeId: "node-1", error: "permanent" };
    const schema = getBoardProjectionHostOperationSchema(
      "mark-checklist-task-projection-dead-letter",
    );
    const markDeadLetter = vi.fn(async () => true);

    expect(schema?.parse(input)).toEqual(input);
    await expect(dispatchBoardProjectionHostOperation(
      "mark-checklist-task-projection-dead-letter",
      input,
      { markChecklistTaskProjectionDeadLetter: markDeadLetter } as never,
    )).resolves.toBe(true);
    expect(markDeadLetter).toHaveBeenCalledWith(row, "node-1", "permanent");
  });
});
