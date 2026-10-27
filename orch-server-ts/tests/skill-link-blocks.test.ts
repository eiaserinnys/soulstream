import { describe, expect, it } from "vitest";
import vectors from "./fixtures/link_vectors.json" with { type: "json" };
import {
  findSection,
  parseLinkBlocks,
  stripCompileHeader,
} from "../src/skills/link_blocks.js";

describe("skill link parser shared vectors", () => {
  it.each(vectors.parse_cases)("matches $name", ({ markdown, blocks, errors }) => {
    const parsed = parseLinkBlocks(markdown);
    expect(parsed.blocks.map(({ line, kind, fields }) => ({ line, kind, fields }))).toEqual(blocks);
    expect(parsed.errors.map(({ line, code }) => ({ line, code }))).toEqual(errors);
  });

  it("finds normalized headings outside fenced code and reports missing or ambiguous headings", () => {
    const { markdown, lookups } = vectors.section_cases;
    for (const lookup of lookups) {
      const result = findSection(markdown, lookup.section);
      if (!lookup.found) {
        expect(result).toMatchObject({ found: false, code: lookup.code });
        continue;
      }
      expect(result).toMatchObject({ found: true });
      if (!result.found) throw new Error(`Expected section ${lookup.section} to be found`);
      if (lookup.text_starts !== undefined) expect(result.text.startsWith(lookup.text_starts)).toBe(true);
      for (const text of lookup.text_contains ?? []) expect(result.text).toContain(text);
      for (const text of lookup.text_not_contains ?? []) expect(result.text).not.toContain(text);
    }
  });

  it("removes only the generated first heading line", () => {
    const markdown = vectors.section_cases.markdown;
    expect(stripCompileHeader(markdown)).toBe(markdown.slice(markdown.indexOf("\n") + 1));
  });
});
