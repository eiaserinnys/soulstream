// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import type { PageDocumentBlock } from "../page";
import { PageBlockEditor } from "./PageBlockEditor";

describe("PageBlockEditor auto height", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let scrollHeight = 80;
  let scrollHeightSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollHeight = 80;
    scrollHeightSpy = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
      .mockImplementation(() => scrollHeight);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    scrollHeightSpy.mockRestore();
  });

  it("fits content height and asks its virtual row to remeasure after width changes", async () => {
    const onHeightChange = vi.fn();
    const editorBlock = block("A long wrapped block");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <PageBlockEditor
        block={editorBlock}
        onKeyInput={vi.fn()}
        onPasteInput={vi.fn()}
        onSelectBlock={vi.fn()}
        onHeightChange={onHeightChange}
      />,
    ));
    const textarea = container.querySelector("textarea")!;
    expect(textarea.style.height).toBe("80px");
    expect(onHeightChange).toHaveBeenCalledTimes(1);

    scrollHeight = 100;
    editorBlock.text.insert(editorBlock.text.length, " with more content");
    await settle();
    expect(textarea.style.height).toBe("100px");
    expect(onHeightChange).toHaveBeenCalledTimes(2);

    scrollHeight = 120;
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(textarea.style.height).toBe("120px");
    expect(onHeightChange).toHaveBeenCalledTimes(3);
  });
});

function block(value: string): PageDocumentBlock {
  const doc = new Y.Doc();
  const text = doc.getText("text");
  text.insert(0, value);
  return {
    id: "block-1",
    parentId: null,
    positionKey: "a0",
    type: "paragraph",
    text,
    textValue: value,
    properties: {},
    collapsed: false,
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
