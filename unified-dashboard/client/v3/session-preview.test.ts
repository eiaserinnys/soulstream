import { describe, expect, it } from "vitest";

import {
  codePointLength,
  hasCodePointOverflow,
  singleLinePreview,
} from "./session-preview";

describe("session preview text boundaries", () => {
  it("counts astral emoji as one code point", () => {
    expect(codePointLength("A😀B")).toBe(3);
    expect(hasCodePointOverflow("A😀B", 3)).toBe(false);
    expect(hasCodePointOverflow("A😀B", 2)).toBe(true);
  });

  it("never leaves an unmatched surrogate when truncating", () => {
    const preview = singleLinePreview("가😀나다라", 4);

    expect(preview).toBe("가😀나…");
    expect(preview).not.toMatch(/[\uD800-\uDBFF]$/u);
  });
});
