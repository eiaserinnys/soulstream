import { describe, expect, it } from "vitest";

import {
  parseInlineRefs,
  serializeInlineSegments,
} from "../src/inline_refs.js";

describe("page model inline reference contract", () => {
  it("ports the Serendipity page and block reference token contract", () => {
    const segments = parseInlineRefs("open [[Daily Note]] and ((block-123)) now");

    expect(segments).toEqual([
      { kind: "text", text: "open ", range: { start: 0, end: 5 } },
      {
        kind: "pageRef",
        text: "Daily Note",
        sourceText: "[[Daily Note]]",
        pageTitle: "Daily Note",
        navigation: { kind: "page", title: "Daily Note" },
        range: { start: 5, end: 19 },
      },
      { kind: "text", text: " and ", range: { start: 19, end: 24 } },
      {
        kind: "blockRef",
        text: "block-123",
        sourceText: "((block-123))",
        blockId: "block-123",
        navigation: { kind: "block", blockId: "block-123" },
        range: { start: 24, end: 37 },
      },
      { kind: "text", text: " now", range: { start: 37, end: 41 } },
    ]);
    expect(serializeInlineSegments(segments)).toBe(
      "open [[Daily Note]] and ((block-123)) now",
    );
  });

  it("keeps unmatched and empty reference tokens deterministic", () => {
    expect(parseInlineRefs("before [[unfinished")).toEqual([
      { kind: "text", text: "before ", range: { start: 0, end: 7 } },
      { kind: "text", text: "[[unfinished", range: { start: 7, end: 19 } },
    ]);
    expect(parseInlineRefs("[[]] (())")).toEqual([
      {
        kind: "pageRef",
        text: "",
        sourceText: "[[]]",
        pageTitle: "",
        navigation: { kind: "page", title: "" },
        range: { start: 0, end: 4 },
      },
      { kind: "text", text: " ", range: { start: 4, end: 5 } },
      {
        kind: "blockRef",
        text: "",
        sourceText: "(())",
        blockId: "",
        navigation: { kind: "block", blockId: "" },
        range: { start: 5, end: 9 },
      },
    ]);
  });

  it("reports source offsets in UTF-16 string coordinates", () => {
    expect(parseInlineRefs("한글 [[페이지]] 뒤")).toEqual([
      { kind: "text", text: "한글 ", range: { start: 0, end: 3 } },
      {
        kind: "pageRef",
        text: "페이지",
        sourceText: "[[페이지]]",
        pageTitle: "페이지",
        navigation: { kind: "page", title: "페이지" },
        range: { start: 3, end: 10 },
      },
      { kind: "text", text: " 뒤", range: { start: 10, end: 12 } },
    ]);
  });
});
