import { describe, expect, it } from "vitest";

import {
  findReferenceTrigger,
  parseInlineReferences,
  replaceReferenceTrigger,
} from "./page-reference-parser";

describe("page reference parser", () => {
  it("parses canonical page and block tokens without creating a second representation", () => {
    expect(parseInlineReferences("See [[Daily note]] and ((block-42)).")).toEqual([
      { kind: "text", text: "See " },
      { kind: "page", value: "Daily note", raw: "[[Daily note]]" },
      { kind: "text", text: " and " },
      { kind: "block", value: "block-42", raw: "((block-42))" },
      { kind: "text", text: "." },
    ]);
  });

  it("keeps malformed and empty tokens as plain text", () => {
    expect(parseInlineReferences("[[]] (( )) [[open")).toEqual([
      { kind: "text", text: "[[]] (( )) [[open" },
    ]);
  });

  it("finds only the unmatched trigger immediately before the caret", () => {
    expect(findReferenceTrigger("prefix [[Dai", 12)).toEqual({
      kind: "page",
      start: 7,
      end: 12,
      query: "Dai",
    });
    expect(findReferenceTrigger("done [[Page]] ((blo", 19)).toEqual({
      kind: "block",
      start: 14,
      end: 19,
      query: "blo",
    });
    expect(findReferenceTrigger("done [[Page]]", 13)).toBeNull();
  });

  it("replaces the trigger range and returns the canonical caret", () => {
    expect(replaceReferenceTrigger("See [[Dai later", {
      kind: "page",
      start: 4,
      end: 9,
      query: "Dai",
    }, "[[Daily note]]")).toEqual({
      text: "See [[Daily note]] later",
      caret: 18,
    });
  });
});
