import { describe, expect, it } from "vitest";

import {
  isMarkdownRepresentableBlockType,
  markdownToPageBlocks,
  pageToMarkdown,
} from "../src/markdown.js";
import { PAGE_BLOCK_TYPES } from "../src/types.js";

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

  it("renders generated fractional keys in canonical order across case boundaries", () => {
    const markdown = pageToMarkdown(
      { title: "순서" },
      [
        block("created", null, "k", "paragraph", "아래"),
        block("current", null, "V", "paragraph", "위"),
      ],
    );

    expect(markdown).toBe(["# 순서", "", "위", "아래"].join("\n"));
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

  it("defines the markdown-representable block types in one canonical predicate", () => {
    expect(PAGE_BLOCK_TYPES.filter(isMarkdownRepresentableBlockType))
      .toEqual(["paragraph", "checklist"]);
    expect(isMarkdownRepresentableBlockType("runbook_ref")).toBe(false);
  });

  it("omits structural blocks while retaining their markdown children", () => {
    const markdown = pageToMarkdown(
      { title: "계획" },
      [
        block("task", null, "a", "task_ref", "", { taskId: "task-1", primary: true }),
        block("body", "task", "a", "paragraph", "본문"),
      ],
      { includeBlockIds: true },
    );

    expect(markdown).toBe([
      "# 계획",
      "",
      "<!-- block:body -->",
      "본문",
    ].join("\n"));
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
