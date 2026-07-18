import { describe, expect, it } from "vitest";

import {
  buildContextBlockOperations,
  estimateContextPayload,
  type ContextPickerSelection,
} from "./context-picker-model";

describe("context picker block mapping", () => {
  it("maps only shared page and atom selections to ordered page operations", () => {
    const selections: ContextPickerSelection[] = [
      { key: "page:design", kind: "page", pageId: "page-design", title: "설계 문서" },
      {
        key: "atom:node-a",
        kind: "atom",
        nodeId: "node-a",
        nodeTitle: "soulstream / 페이지 모델",
        depth: 4,
        titlesOnly: true,
      },
    ];

    const result = buildContextBlockOperations({
      selections,
      afterBlockId: "last-root",
      createTempId: (() => { let value = 0; return () => `temp-${++value}`; })(),
    });

    expect(result).toEqual([
      {
        op: "create_block",
        temp_id: "temp-1",
        parent_id: null,
        after_block_id: "last-root",
        block_type: "paragraph",
        text: "[[설계 문서]]",
        properties: {},
        collapsed: false,
      },
      {
        op: "create_block",
        temp_id: "temp-2",
        parent_id: null,
        after_block_id: null,
        after_temp_id: "temp-1",
        block_type: "atom_ref",
        text: "",
        properties: {
          instance: "atom",
          nodeId: "node-a",
          nodeTitle: "soulstream / 페이지 모델",
          depth: 4,
          titlesOnly: true,
        },
        collapsed: false,
      },
    ]);
  });

  it("estimates the injected payload from character count divided by four", () => {
    expect(estimateContextPayload(["a".repeat(4_000), "b".repeat(2_000)])).toEqual({
      count: 2,
      approximateTokens: 1_500,
      label: "~1.5k tokens",
    });
  });
});
