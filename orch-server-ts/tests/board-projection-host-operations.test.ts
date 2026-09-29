import { describe, expect, it, vi } from "vitest";

import {
  dispatchBoardProjectionHostOperation,
  getBoardProjectionHostOperationSchema,
} from "../src/board-yjs/board_projection_host_operations.js";

describe("board projection host operations", () => {
  it("validates and dispatches board items scoped to a folder and container", async () => {
    const input = { folderId: "folder-1" };
    const schema = getBoardProjectionHostOperationSchema("get-board-items-by-folder");
    const getBoardItemsByFolder = vi.fn(async () => [{ id: "markdown:doc-1" }]);

    expect(schema).toBeDefined();
    expect(schema?.parse(input)).toEqual(input);
    await expect(dispatchBoardProjectionHostOperation(
      "get-board-items-by-folder",
      input,
      { getBoardItemsByFolder } as never,
    )).resolves.toEqual([{ id: "markdown:doc-1" }]);
    expect(getBoardItemsByFolder).toHaveBeenCalledWith("folder-1");
  });

  it("does not register retired projection outbox operations", () => {
    expect(getBoardProjectionHostOperationSchema("mark-checklist-task-projection-dead-letter")).toBeUndefined();
  });
});
