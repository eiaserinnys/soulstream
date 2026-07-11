// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { measureTextareaCaretLines } from "./page-editor-caret-geometry";

describe("textarea visual caret geometry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("measures first, middle, and last wrapped visual lines from mirror DOM rects", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "12345678901234567890123456789";
    textarea.style.width = "100px";
    textarea.style.font = "16px / 20px sans-serif";
    document.body.appendChild(textarea);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.pageEditorCaretMarker === "true") {
        const offset = Number(this.dataset.caretOffset);
        const line = Math.min(2, Math.floor(offset / 10));
        return rect(line * 20, 16, 1);
      }
      return rect(0, this.dataset.pageEditorCaretMirror === "true" ? 60 : 20, 100);
    });

    expect(measureTextareaCaretLines(textarea, 15)).toEqual({
      caretTop: 20,
      caretBottom: 36,
      firstLineTop: 0,
      firstLineBottom: 16,
      lastLineTop: 40,
      lastLineBottom: 56,
      tolerancePx: 1.6,
    });
    expect(document.querySelector("[data-page-editor-caret-mirror]")).toBeNull();
    textarea.remove();
  });
});

function rect(top: number, height: number, width: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    left: 0,
    right: width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}
