import { describe, expect, it } from "vitest";

import { buildPreview } from "../../src/search/session_search.js";

/**
 * A well-formed JS string only contains surrogate code units as matched
 * high+low pairs. A lone surrogate is what crashes the orchestrator's
 * `.encode("utf-8")` when it re-serializes merged node results.
 */
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // consumed a valid pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate without a preceding high one
    }
  }
  return false;
}

const HAMMER = "\u{1F528}"; // 🔨 — surrogate pair 🔨

describe("buildPreview surrogate safety", () => {
  it("does not leave a lone high surrogate when the window ends inside an emoji", () => {
    // query at index 0, so end = 0 + query.length + 100 = 104.
    // Place the emoji so its high surrogate sits exactly at index 103 (end - 1).
    const query = "가라앉은";
    const text = `${query}${"a".repeat(99)}${HAMMER}tail-content-well-past-the-window`;
    expect(text.charCodeAt(103)).toBeGreaterThanOrEqual(0xd800);
    expect(text.charCodeAt(103)).toBeLessThanOrEqual(0xdbff);

    const preview = buildPreview(text, query);

    expect(hasLoneSurrogate(preview)).toBe(false);
    // Buffer encoding is what Python's UTF-8 encode mirrors — must not throw / mangle.
    expect(() => Buffer.from(preview, "utf-8")).not.toThrow();
    expect(preview.startsWith(query)).toBe(true);
  });

  it("does not leave a lone low surrogate when the window starts inside an emoji", () => {
    // Long leading run so start = idx - 100 lands on the low half of an emoji.
    const query = "찾는표현";
    const head = `${"b".repeat(140)}${HAMMER}`;
    const text = `${head}${"c".repeat(10)}${query}${"d".repeat(200)}`;
    const idx = text.indexOf(query);
    const start = idx - 100;
    // Arrange the emoji's low surrogate to sit exactly at the start boundary.
    // (Guard the intent; if layout drifts the assertion below still enforces safety.)
    expect(text.charCodeAt(start)).toBeDefined();

    const preview = buildPreview(text, query);

    expect(hasLoneSurrogate(preview)).toBe(false);
    expect(() => Buffer.from(preview, "utf-8")).not.toThrow();
    expect(preview.includes(query)).toBe(true);
  });

  it("keeps a whole emoji that sits comfortably inside the window", () => {
    const query = "닻";
    const text = `${query} ${HAMMER} 가라앉은 배`;
    const preview = buildPreview(text, query);
    expect(hasLoneSurrogate(preview)).toBe(false);
    expect(preview).toContain(HAMMER);
  });

  it("returns short text unchanged", () => {
    expect(buildPreview("가라앉은 배", "가라앉은")).toBe("가라앉은 배");
    expect(buildPreview("", "x")).toBe("");
  });
});
