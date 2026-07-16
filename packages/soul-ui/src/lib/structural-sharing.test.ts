import { describe, expect, it } from "vitest";

import { retainEqualSet, retainEqualValue } from "./structural-sharing";

describe("structural sharing", () => {
  it("keeps the complete value when an equivalent JSON response is rebuilt", () => {
    const previous = {
      pages: [{ id: "page-a", title: "업무" }],
      cursor: null,
    };
    const next = {
      pages: previous.pages.map((page) => ({ ...page })),
      cursor: null,
    };

    expect(retainEqualValue(previous, next)).toBe(previous);
  });

  it("reuses unchanged children while replacing the changed branch", () => {
    const previous = {
      pages: [
        { id: "page-a", title: "이전 제목" },
        { id: "page-b", title: "유지" },
      ],
    };
    const next = {
      pages: [
        { ...previous.pages[0], title: "새 제목" },
        { ...previous.pages[1] },
      ],
    };

    const retained = retainEqualValue(previous, next);

    expect(retained).not.toBe(previous);
    expect(retained.pages[0]).not.toBe(previous.pages[0]);
    expect(retained.pages[1]).toBe(previous.pages[1]);
  });

  it("keeps an equivalent Set identity and replaces a changed Set", () => {
    const previous = new Set(["task-a", "task-b"]);

    expect(retainEqualSet(previous, new Set(["task-b", "task-a"]))).toBe(previous);
    expect(retainEqualSet(previous, new Set(["task-a"]))).not.toBe(previous);
  });
});
