// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { readPageDocument, type ApplyPageOperationsInput, type PageApiClient } from "../page";
import { PageOutliner } from "./PageOutliner";

describe("PageOutliner", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let heightSpy: ReturnType<typeof vi.spyOn>;
  let widthSpy: ReturnType<typeof vi.spyOn>;
  let rectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tree" ? 600 : 40;
    });
    widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.pageEditorCaretMarker === "true") {
        const offset = Number(this.dataset.caretOffset);
        const line = Math.min(2, Math.floor(offset / 10));
        return domRect(line * 20, 16, 1);
      }
      if (this.dataset.pageEditorCaretMirror === "true") return domRect(0, 60, 100);
      const height = this.getAttribute("role") === "tree" ? 600 : 40;
      return domRect(0, height, 800);
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    heightSpy.mockRestore();
    widthSpy.mockRestore();
    rectSpy.mockRestore();
  });

  it("keeps a 2,000 block page virtualized near the viewport", async () => {
    const doc = createPageDoc(2_000);
    await render(doc, createApi());
    const mountedRows = container!.querySelectorAll("[data-page-editor-row]");
    expect(mountedRows.length).toBeGreaterThan(0);
    expect(mountedRows.length).toBeLessThanOrEqual(40);
    expect(container!.querySelector('[data-testid="page-outliner"]')).not.toBeNull();
  });

  it("does not mount descendants hidden by a collapsed block", async () => {
    const doc = createPageDoc(2);
    const blockMap = doc.getMap<Y.Map<unknown>>("blocks");
    blockMap.get("block-0")!.set("collapsed", true);
    blockMap.get("block-1")!.set("parentId", "block-0");
    await render(doc, createApi());
    expect(container!.querySelectorAll("[data-page-editor-row]")).toHaveLength(1);
    expect(container!.querySelector('[data-block-id="block-1"]')).toBeNull();
  });

  it("maps Enter to the editor-core split intent and one HTTP batch", async () => {
    const doc = createPageDoc(2);
    const api = createApi();
    await render(doc, api);
    const first = container!.querySelector<HTMLTextAreaElement>('[data-block-id="block-0"] textarea')!;
    first.setSelectionRange(2, 2);
    flushSync(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: expect.arrayContaining([
        expect.objectContaining({ op: "update_block_text", block_id: "block-0" }),
        expect.objectContaining({ op: "create_block" }),
      ]),
    }));

  });

  it("maps Tab to an editor-core indent intent and one HTTP batch", async () => {
    const doc = createPageDoc(2);
    const api = createApi();
    await render(doc, api);
    const second = container!.querySelector<HTMLTextAreaElement>('[data-block-id="block-1"] textarea')!;
    flushSync(() => second.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [expect.objectContaining({ op: "move_block", block_id: "block-1", parent_id: "block-0" })],
    }));
  });

  it("maps Shift+Tab to an editor-core outdent intent", async () => {
    const doc = createPageDoc(2);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    const api = createApi();
    await render(doc, api);
    const second = editor("block-1");
    dispatchKey(second, "Tab", 0, { shiftKey: true });
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [expect.objectContaining({
        op: "move_block",
        block_id: "block-1",
        parent_id: null,
        after_block_id: "block-0",
      })],
    }));
  });

  it.each([
    ["Backspace", "block-1", 0],
    ["Delete", "block-0", 7],
  ] as const)("maps %s only at a text boundary to a merge batch", async (key, blockId, offset) => {
    const doc = createPageDoc(2);
    const api = createApi();
    await render(doc, api);
    dispatchKey(editor(blockId), key, offset);
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [
        expect.objectContaining({ op: "update_block_text", block_id: "block-0" }),
        expect.objectContaining({ op: "delete_block_subtree", block_id: "block-1" }),
      ],
    }));
  });

  it.each([
    ["ArrowLeft", "block-1", 0, "block-0", 7],
    ["ArrowRight", "block-0", 7, "block-1", 0],
    ["ArrowUp", "block-1", 0, "block-0", 0],
    ["ArrowDown", "block-0", 7, "block-1", 7],
  ] as const)("moves %s across a block edge through post-render focus", async (key, fromId, offset, targetId, targetOffset) => {
    await render(createPageDoc(2), createApi());
    dispatchKey(editor(fromId), key, offset);
    await settleFocus();
    expect(document.activeElement).toBe(editor(targetId));
    expect(editor(targetId).selectionStart).toBe(targetOffset);
    expect(editor(targetId).selectionEnd).toBe(targetOffset);
  });

  it("keeps ArrowUp/Down native on a wrapped middle line and crosses only first/last visual lines", async () => {
    const doc = createPageDoc(3);
    setBlockText(doc, "block-1", "12345678901234567890123456789");
    await render(doc, createApi());
    const wrapped = editor("block-1");
    wrapped.focus();

    const middleUp = dispatchKey(wrapped, "ArrowUp", 15);
    const middleDown = dispatchKey(wrapped, "ArrowDown", 15);
    expect(middleUp.defaultPrevented).toBe(false);
    expect(middleDown.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(wrapped);

    dispatchKey(wrapped, "ArrowUp", 5);
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-0"));

    wrapped.focus();
    dispatchKey(wrapped, "ArrowDown", 25);
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-2"));
  });

  it("extends a contiguous Shift+Arrow selection and deletes it as one batch", async () => {
    const api = createApi();
    await render(createPageDoc(3), api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    expect(container!.querySelector('[data-block-id="block-0"]')?.getAttribute("aria-selected")).toBe("true");
    expect(container!.querySelector('[data-block-id="block-1"]')?.getAttribute("aria-selected")).toBe("true");
    dispatchKey(first, "Delete", 7);
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [
        { op: "delete_block_subtree", block_id: "block-0" },
        { op: "delete_block_subtree", block_id: "block-1" },
      ],
    }));
  });

  it("maps paste and paste-over-selection from real textarea clipboard events", async () => {
    const api = createApi();
    await render(createPageDoc(3), api);
    const first = editor("block-0");
    first.setSelectionRange(2, 2);
    dispatchPaste(first, "One\nTwo");
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: expect.arrayContaining([
        expect.objectContaining({ op: "update_block_text", block_id: "block-0" }),
        expect.objectContaining({ op: "create_block", text: expect.stringContaining("Two") }),
      ]),
    }));
  });

  it("replaces a Shift-selected range through pasteOverSelection", async () => {
    const api = createApi();
    await render(createPageDoc(3), api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    dispatchPaste(first, "Replacement");
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: expect.arrayContaining([
        expect.objectContaining({ op: "create_block", text: "Replacement" }),
        { op: "delete_block_subtree", block_id: "block-0" },
        { op: "delete_block_subtree", block_id: "block-1" },
      ]),
    }));
  });

  it("applies only the latest queued focus request", async () => {
    await render(createPageDoc(3), createApi());
    const first = editor("block-0");
    const third = editor("block-2");
    first.setSelectionRange(7, 7);
    third.setSelectionRange(0, 0);
    flushSync(() => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      third.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    });
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-1"));
    expect(editor("block-1").selectionStart).toBe(7);
  });

  it("blocks structural shortcuts during IME composition", async () => {
    const doc = createPageDoc(1);
    const api = createApi();
    await render(doc, api);
    const editor = container!.querySelector("textarea")!;
    flushSync(() => editor.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    flushSync(() => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();
    expect(api.applyOperations).not.toHaveBeenCalled();
  });

  it("creates the first block through HTTP instead of writing structure into Y.Doc", async () => {
    const doc = createPageDoc(0);
    const api = createApi();
    await render(doc, api);
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-testid="page-editor-create-first"]')!.click());
    await settle();
    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [expect.objectContaining({ op: "create_block", parent_id: null, after_block_id: null })],
    }));
    expect(doc.getMap("blocks").size).toBe(0);
  });

  it("shows a conflict and requires an explicit resync", async () => {
    const doc = createPageDoc(2);
    const onResync = vi.fn();
    const api = createApi({
      applyOperations: vi.fn(async () => { throw new (await import("../page")).PageApiError("conflict", 409, "conflict"); }),
    });
    await render(doc, api, onResync);
    const second = container!.querySelector<HTMLTextAreaElement>('[data-block-id="block-1"] textarea')!;
    flushSync(() => second.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })));
    await settle();
    expect(container!.querySelector('[data-editor-state="conflict"]')).not.toBeNull();
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-testid="page-editor-resync"]')!.click());
    await settle();
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-editor-state="resyncing"]')).not.toBeNull();
  });

  async function render(doc: Y.Doc, api: PageApiClient, onResync = vi.fn()) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const snapshot = readPageDocument(doc, "page-1");
    flushSync(() => root!.render(
      <PageOutliner
        pageId="page-1"
        doc={doc}
        blocks={snapshot.blocks}
        mutationVersion={snapshot.page.mutationVersion}
        apiClient={api}
        onResync={onResync}
      />,
    ));
    await settle();
  }

  function editor(blockId: string): HTMLTextAreaElement {
    return container!.querySelector<HTMLTextAreaElement>(`[data-block-id="${blockId}"] textarea`)!;
  }
});

function createPageDoc(count: number): Y.Doc {
  const doc = new Y.Doc();
  const meta = doc.getMap("pageMeta");
  meta.set("schemaVersion", 1);
  meta.set("id", "page-1");
  meta.set("title", "Page");
  meta.set("dailyDate", null);
  meta.set("mutationVersion", 3);
  meta.set("archived", false);
  meta.set("metadata", {});
  const blocks = doc.getMap<Y.Map<unknown>>("blocks");
  for (let index = 0; index < count; index += 1) {
    const block = new Y.Map<unknown>();
    block.set("id", `block-${index}`);
    block.set("parentId", null);
    block.set("positionKey", `a${String(index).padStart(5, "0")}`);
    block.set("type", "paragraph");
    block.set("text", new Y.Text(`Block ${index}`));
    block.set("properties", new Y.Map());
    block.set("collapsed", false);
    blocks.set(`block-${index}`, block);
  }
  return doc;
}

function createApi(overrides: Partial<PageApiClient> = {}): PageApiClient {
  return {
    listPages: vi.fn(),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    setStarred: vi.fn(),
    applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => ({
      page: { id: "page-1", title: "Page", daily_date: null, version: input.expectedVersion + 1, archived: false, metadata: {}, created_at: "", updated_at: "" },
      blocks: [],
      operation: { id: "operation-1" },
      temp_id_mapping: Object.fromEntries(input.operations.flatMap((operation) => operation.op === "create_block" ? [[operation.temp_id, `created-${operation.temp_id}`]] : [])),
    })),
    ...overrides,
  } as PageApiClient;
}

function setBlockText(doc: Y.Doc, blockId: string, value: string): void {
  const text = doc.getMap<Y.Map<unknown>>("blocks").get(blockId)!.get("text") as Y.Text;
  text.delete(0, text.length);
  text.insert(0, value);
}

function dispatchKey(
  textarea: HTMLTextAreaElement,
  key: string,
  offset: number,
  options: { shiftKey?: boolean } = {},
): KeyboardEvent {
  textarea.setSelectionRange(offset, offset);
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: options.shiftKey,
  });
  flushSync(() => textarea.dispatchEvent(event));
  return event;
}

function dispatchPaste(textarea: HTMLTextAreaElement, plainText: string): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => type === "text/plain" ? plainText : "",
      files: [],
    },
  });
  flushSync(() => textarea.dispatchEvent(event));
}

function domRect(top: number, height: number, width: number): DOMRect {
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

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function settleFocus() {
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await settle();
}
