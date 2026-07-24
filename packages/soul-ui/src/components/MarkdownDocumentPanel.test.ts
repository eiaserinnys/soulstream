/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import { isDefaultDocumentTitle, isScrollbarMouseDown } from "./MarkdownDocumentPanel";

function target(overrides: {
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
}) {
  return overrides;
}

describe("isScrollbarMouseDown", () => {
  it("detects a press in the vertical scrollbar gutter of a scrollable element", () => {
    const el = target({ clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 900 });
    // offsetX beyond clientWidth = the scrollbar gutter on the right.
    expect(isScrollbarMouseDown(el, 312, 100)).toBe(true);
  });

  it("detects a press in the horizontal scrollbar gutter of a scrollable element", () => {
    const el = target({ clientWidth: 300, clientHeight: 200, scrollWidth: 900, scrollHeight: 200 });
    expect(isScrollbarMouseDown(el, 100, 212)).toBe(true);
  });

  it("ignores a normal content click inside the client box", () => {
    const el = target({ clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 900 });
    expect(isScrollbarMouseDown(el, 120, 100)).toBe(false);
  });

  it("does not treat an out-of-range offset as a scrollbar when that axis cannot scroll", () => {
    // No vertical overflow -> the right gutter is not a live scrollbar.
    const el = target({ clientWidth: 300, clientHeight: 200, scrollWidth: 300, scrollHeight: 200 });
    expect(isScrollbarMouseDown(el, 312, 100)).toBe(false);
    expect(isScrollbarMouseDown(el, 100, 212)).toBe(false);
  });
});

describe("isDefaultDocumentTitle", () => {
  it("treats empty/whitespace and the default placeholder as default", () => {
    expect(isDefaultDocumentTitle("")).toBe(true);
    expect(isDefaultDocumentTitle("   ")).toBe(true);
    expect(isDefaultDocumentTitle("Untitled document")).toBe(true);
    expect(isDefaultDocumentTitle("  untitled DOCUMENT  ")).toBe(true);
  });

  it("keeps a user-authored title", () => {
    expect(isDefaultDocumentTitle("Design note")).toBe(false);
    expect(isDefaultDocumentTitle("Untitled document draft")).toBe(false);
  });
});
