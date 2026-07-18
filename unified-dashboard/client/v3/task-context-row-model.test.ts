import { describe, expect, it } from "vitest";

import {
  deleteOptimisticTaskContextBlock,
  updateOptimisticTaskAtomReference,
} from "./task-context-row-model";

describe("task context row optimistic patches", () => {
  it("patches only the selected atom_ref and preserves unrelated properties", () => {
    const blocks = [
      block("guidance-1", "guidance", { enabled: true, scope: "task" }),
      block("atom-1", "atom_ref", {
        instance: "atom",
        nodeId: "node-a",
        nodeTitle: "soulstream",
        depth: 3,
        titlesOnly: false,
        futureKey: "preserve",
      }),
    ];

    expect(updateOptimisticTaskAtomReference(blocks, "atom-1", {
      depth: 5,
      titlesOnly: true,
    })).toEqual([
      blocks[0],
      expect.objectContaining({
        id: "atom-1",
        properties: expect.objectContaining({
          nodeTitle: "soulstream",
          depth: 5,
          titlesOnly: true,
          futureKey: "preserve",
        }),
      }),
    ]);
  });

  it("removes only the requested direct context block", () => {
    const blocks = [
      block("atom-1", "atom_ref", { instance: "atom", nodeId: "node-a" }),
      block("page-1", "paragraph", {}),
    ];
    expect(deleteOptimisticTaskContextBlock(blocks, "atom-1")).toEqual([blocks[1]]);
  });
});

function block(id: string, blockType: string, properties: Record<string, unknown>) {
  return {
    id,
    page_id: "task-1",
    parent_id: null,
    position_key: id,
    block_type: blockType,
    text: "",
    properties,
    collapsed: false,
  };
}
