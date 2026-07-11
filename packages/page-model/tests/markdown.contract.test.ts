import { describe, expect, it } from "vitest";

import { markdownToPageBlocks, pageToMarkdown } from "../src/markdown.js";

describe("page markdown contract", () => {
  it("renders hierarchy, checklist state, and optional block IDs", () => {
    const markdown = pageToMarkdown(
      { title: "계획" },
      [
        block("child", "root", "a", "checklist", "검증", { checked: true }),
        block("root", null, "a", "paragraph", "구현"),
      ],
      { includeBlockIds: true },
    );

    expect(markdown).toBe([
      "# 계획",
      "",
      "<!-- block:root -->",
      "구현",
      "  <!-- block:child -->",
      "  - [x] 검증",
    ].join("\n"));
  });

  it("parses a full-replace document and preserves explicit block IDs", () => {
    let sequence = 0;
    const blocks = markdownToPageBlocks([
      "# 계획",
      "",
      "<!-- block:root -->",
      "구현",
      "  - [ ] 테스트",
      "후속",
    ].join("\n"), {
      title: "계획",
      createId: () => `generated-${++sequence}`,
    });

    expect(blocks).toEqual([
      expect.objectContaining({ id: "root", parent_id: null, type: "paragraph", text: "구현" }),
      expect.objectContaining({
        id: "generated-1",
        parent_id: "root",
        type: "checklist",
        text: "테스트",
        properties: { checked: false },
      }),
      expect.objectContaining({ id: "generated-2", parent_id: null, text: "후속" }),
    ]);
  });
});

function block(
  id: string,
  parentId: string | null,
  positionKey: string,
  blockType: string,
  text: string,
  properties: Record<string, unknown> = {},
) {
  return {
    id,
    page_id: "page-1",
    parent_id: parentId,
    position_key: positionKey,
    block_type: blockType,
    text,
    properties,
    collapsed: false,
  };
}
