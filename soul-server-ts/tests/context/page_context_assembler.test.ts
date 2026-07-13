import { describe, expect, it } from "vitest";

import {
  DefaultPageContextAssembler,
  type PageContextCandidate,
} from "../../src/context/page_context_assembler.js";

function guidance(
  id: string,
  distance: number,
  semanticKey: string,
  text: string,
  positionKey = id,
): PageContextCandidate {
  return {
    category: "guidance",
    semanticKey,
    pageId: "page-1",
    blockId: id,
    positionKey,
    distance,
    text,
    scope: semanticKey.replace("guidance:", ""),
  };
}

describe("DefaultPageContextAssembler", () => {
  it("keeps the nearest semantic key and renders selected context root-to-leaf", () => {
    const assembler = new DefaultPageContextAssembler();
    const item = assembler.assemble(
      { pageId: "page-1", blockId: "anchor" },
      {
        candidates: [
          guidance("near", 1, "guidance:shared", "near"),
          guidance("root", 4, "guidance:root", "root"),
          guidance("far-duplicate", 5, "guidance:shared", "far"),
        ],
        visitedPages: 2,
        failures: [],
        truncated: false,
      },
    );
    const content = item.content as Record<string, any>;

    expect(content.items.map((entry: any) => entry.block_id)).toEqual(["root", "near"]);
    expect(content.metadata.deduplicated).toBe(1);
  });

  it("orders same-depth blocks by the canonical fractional alphabet", () => {
    const item = new DefaultPageContextAssembler().assemble(
      { pageId: "page-1", blockId: "anchor" },
      {
        candidates: [
          guidance("lowercase", 1, "guidance:lowercase", "lowercase", "a"),
          guidance("uppercase", 1, "guidance:uppercase", "uppercase", "Z"),
        ],
        visitedPages: 1,
        failures: [],
        truncated: false,
      },
    );
    const content = item.content as Record<string, any>;
    expect(content.items.map((entry: any) => entry.block_id)).toEqual([
      "uppercase",
      "lowercase",
    ]);
  });

  it("applies category and total budgets near-first and exposes truncation metadata", () => {
    const assembler = new DefaultPageContextAssembler({
      guidanceChars: 6,
      atomRefChars: 100,
      totalChars: 8,
    });
    const item = assembler.assemble(
      { pageId: "page-1", blockId: "anchor" },
      {
        candidates: [
          guidance("far", 3, "guidance:far", "abcdef"),
          guidance("near", 1, "guidance:near", "12345"),
          {
            category: "atom_ref",
            semanticKey: "atom_ref:atom:n1",
            pageId: "page-1",
            blockId: "atom",
            positionKey: "z",
            distance: 2,
            instance: "atom",
            nodeId: "n1",
          },
        ],
        visitedPages: 1,
        failures: [],
        truncated: false,
      },
    );
    const content = item.content as Record<string, any>;

    expect(content.items.find((entry: any) => entry.block_id === "near")).toMatchObject({
      text: "12345",
    });
    expect(content.metadata.truncation.categories.guidance).toMatchObject({
      limit: 6,
      used: 6,
      omitted: 1,
    });
    expect(content.metadata.truncation.total).toMatchObject({
      limit: 8,
      used: 8,
    });
  });
});
