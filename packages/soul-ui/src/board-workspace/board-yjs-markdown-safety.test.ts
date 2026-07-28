import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  getMarkdownYjsText,
  MARKDOWN_BODIES_MAP,
} from "./board-yjs-client";

describe("board markdown Yjs read safety", () => {
  it("does not create an empty Y.Text while the document is still unsynced", () => {
    const doc = new Y.Doc();
    const bodies = doc.getMap<Y.Text>(MARKDOWN_BODIES_MAP);

    expect(bodies.size).toBe(0);
    expect(getMarkdownYjsText(doc, "doc-a")).toBeNull();
    expect(bodies.size).toBe(0);
  });
});
