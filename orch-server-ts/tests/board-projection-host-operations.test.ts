import { describe, expect, it, vi } from "vitest";

import {
  dispatchBoardProjectionHostOperation,
  getBoardProjectionHostOperationSchema,
} from "../src/board-yjs/board_projection_host_operations.js";

describe("board projection host operations", () => {
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
