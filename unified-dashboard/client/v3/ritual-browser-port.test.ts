import { describe, expect, it, vi } from "vitest";

import { removeRitualTaskFromDaily } from "./ritual-browser-port";

describe("removeRitualTaskFromDaily", () => {
  it("deletes only the matching daily mount through the page CAS contract", async () => {
    const applyOperations = vi.fn(async () => ({ temp_id_mapping: {} }));
    const api = {
      getPage: vi.fn(async () => ({
        page: { id: "daily-yesterday", version: 4 },
        blocks: [
          { id: "memo", parent_id: null, block_type: "paragraph", text: "메모", properties: {} },
          { id: "task-mount", parent_id: null, block_type: "paragraph", text: "[[업무]]", properties: {} },
        ],
        state_vector: "AQID",
      })),
      getBacklinks: vi.fn(async () => ({
        items: [{
          id: "link-task",
          sourcePageId: "daily-yesterday",
          sourcePageTitle: "2026년 7월 19일",
          sourceBlockId: "task-mount",
          sourceTextPreview: "[[업무]]",
          linkKind: "mount",
          targetPageId: "task-page",
          targetBlockId: null,
          sourceStart: 0,
          sourceEnd: 6,
        }],
        nextCursor: null,
      })),
      applyOperations,
    };

    await removeRitualTaskFromDaily(
      api as never,
      "daily-yesterday",
      "task-page",
      "업무",
      () => "ritual-remove-1",
    );

    expect(applyOperations).toHaveBeenCalledWith("daily-yesterday", {
      expectedVersion: 4,
      expectedStateVector: new Uint8Array([1, 2, 3]),
      idempotencyKey: "ritual-remove-1",
      reason: "v3 morning ritual daily unmount",
      operations: [{ op: "delete_block_subtree", block_id: "task-mount" }],
    });
  });

  it("is idempotent when the historical daily mount is already absent", async () => {
    const applyOperations = vi.fn();
    const api = {
      getPage: vi.fn(async () => ({
        page: { id: "daily-yesterday", version: 4 },
        blocks: [{ id: "memo", parent_id: null, block_type: "paragraph", text: "메모", properties: {} }],
        state_vector: "AQID",
      })),
      getBacklinks: vi.fn(async () => ({ items: [], nextCursor: null })),
      applyOperations,
    };

    await removeRitualTaskFromDaily(
      api as never,
      "daily-yesterday",
      "task-page",
      "업무",
    );

    expect(applyOperations).not.toHaveBeenCalled();
  });
});
