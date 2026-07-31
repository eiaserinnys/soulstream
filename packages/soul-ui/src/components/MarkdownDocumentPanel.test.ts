/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from "vitest";

import {
  captureMarkdownViewport,
  captureMarkdownReadViewport,
  isDefaultDocumentTitle,
  isScrollbarMouseDown,
  markdownScrollTopForAnchor,
  markdownSelectionOffset,
} from "./markdown-document-view-state";

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

describe("markdown document viewport mapping", () => {
  it("captures the visible center as a height-independent anchor", () => {
    expect(captureMarkdownViewport({
      scrollTop: 400,
      clientHeight: 200,
      scrollHeight: 1_000,
    })).toEqual({ anchor: 0.5 });
  });

  it("maps the same anchor across different read and edit heights", () => {
    expect(markdownScrollTopForAnchor(0.5, {
      clientHeight: 300,
      scrollHeight: 1_600,
    })).toBe(650);
    expect(markdownScrollTopForAnchor(0.95, {
      clientHeight: 300,
      scrollHeight: 1_600,
    })).toBe(1_300);
  });

  it("uses the last exact selection and otherwise derives one from the viewport", () => {
    expect(markdownSelectionOffset(1_000, { anchor: 0.65 })).toBe(650);
    expect(markdownSelectionOffset(1_000, { anchor: 0.65, selectionOffset: 782 })).toBe(782);
    expect(markdownSelectionOffset(12, { anchor: 1, selectionOffset: 99 })).toBe(12);
  });

  it("keeps a recent cursor only while the read viewport stays in the same region", () => {
    const previous = { anchor: 0.5, selectionOffset: 782 };
    expect(captureMarkdownReadViewport({
      scrollTop: 420,
      clientHeight: 200,
      scrollHeight: 1_000,
    }, previous)).toEqual({ anchor: 0.52, selectionOffset: 782 });
    expect(captureMarkdownReadViewport({
      scrollTop: 700,
      clientHeight: 200,
      scrollHeight: 1_000,
    }, previous)).toEqual({ anchor: 0.8 });
  });
});
