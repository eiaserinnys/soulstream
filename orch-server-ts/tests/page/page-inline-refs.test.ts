import { describe, expect, it } from "vitest";

import {
  projectPageLinks,
  traverseResolvedMountPages,
} from "../../src/page/page_link_projection.js";
import type { PageYjsBlockReplica, PageYjsReplica } from "../../src/page/page_yjs_model.js";

describe("page inline reference projection", () => {
  it.each([
    ["[[A]]", "paragraph", ["mount"], [[0, 5]]],
    ["  [[A]]  ", "paragraph", ["mount"], [[2, 7]]],
    ["오늘 [[A]]", "paragraph", ["inline_page"], [[3, 8]]],
    ["**[[A]]**", "paragraph", ["inline_page"], [[2, 7]]],
    ["[[A]] [[B]]", "paragraph", ["inline_page", "inline_page"], [[0, 5], [6, 11]]],
    ["((id))", "paragraph", ["block_ref"], [[0, 6]]],
    ["[[A]]", "checklist", ["inline_page"], [[0, 5]]],
  ])(
    "classifies %j in a %s block",
    (text, type, expectedKinds, expectedRanges) => {
      const links = projectPageLinks(replica(block(text, type)));

      expect(links.map((link) => link.linkKind)).toEqual(expectedKinds);
      expect(links.map((link) => [link.sourceStart, link.sourceEnd])).toEqual(
        expectedRanges,
      );
      expect(links.map((link) => link.ordinal)).toEqual(
        links.map((_, index) => index),
      );
    },
  );

  it("uses a page ref attribute only when the entire token has one matching target", () => {
    const full = projectPageLinks(replica(block("[[A]]", "paragraph", [
      { insert: "[[", attributes: { ref: { kind: "page", targetId: "page-a" } } },
      { insert: "A]]", attributes: { ref: { kind: "page", targetId: "page-a" } } },
    ])));
    const partial = projectPageLinks(replica(block("[[A]]", "paragraph", [
      { insert: "[[A", attributes: { ref: { kind: "page", targetId: "page-a" } } },
      { insert: "]]" },
    ])));
    const mismatched = projectPageLinks(replica(block("[[A]]", "paragraph", [
      { insert: "[[", attributes: { ref: { kind: "page", targetId: "page-a" } } },
      { insert: "A]]", attributes: { ref: { kind: "page", targetId: "page-b" } } },
    ])));
    const wrongKind = projectPageLinks(replica(block("[[A]]", "paragraph", [
      { insert: "[[A]]", attributes: { ref: { kind: "block", targetId: "page-a" } } },
    ])));

    expect(full[0]?.attributeTargetPageId).toBe("page-a");
    expect(partial[0]?.attributeTargetPageId).toBeNull();
    expect(mismatched[0]?.attributeTargetPageId).toBeNull();
    expect(wrongKind[0]?.attributeTargetPageId).toBeNull();
  });

  it("preserves unresolved page titles and raw block IDs", () => {
    const links = projectPageLinks(replica(block("[[  Future Page  ]] ((block-7))")));

    expect(links).toMatchObject([
      {
        id: "block-link:block-1:0",
        targetTitle: "  Future Page  ",
        targetTitleKey: "future page",
        targetBlockRef: null,
      },
      {
        id: "block-link:block-1:1",
        targetTitle: null,
        targetTitleKey: null,
        targetBlockRef: "block-7",
      },
    ]);
  });

  it("cuts cyclic mount traversal with a visited page-ID set", async () => {
    const graph = new Map([
      ["page-a", ["page-b"]],
      ["page-b", ["page-c", "page-a"]],
      ["page-c", ["page-b"]],
    ]);

    await expect(traverseResolvedMountPages(
      "page-a",
      async (pageId) => graph.get(pageId) ?? [],
    )).resolves.toEqual(["page-a", "page-b", "page-c"]);
  });
});

function replica(...blocks: PageYjsBlockReplica[]): PageYjsReplica {
  return {
    page: {
      id: "page-source",
      title: "Source",
      dailyDate: null,
      mutationVersion: 1,
      archived: false,
      metadata: {},
    },
    blocks,
  };
}

function block(
  text: string,
  type = "paragraph",
  textDelta: PageYjsBlockReplica["textDelta"] = [{ insert: text }],
): PageYjsBlockReplica {
  return {
    id: "block-1",
    parentId: null,
    positionKey: "a",
    type,
    text,
    textDelta,
    properties: {},
    collapsed: false,
  };
}
