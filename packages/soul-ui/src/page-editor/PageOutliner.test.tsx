// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  decodeStructuredClipboard,
  encodeStructuredClipboard,
  PAGE_BLOCK_CLIPBOARD_MIME,
  type StructuredClipboardPayload,
} from "@soulstream/page-editor-core";

import {
  createSessionSummaryIndex,
  readPageDocument,
  type ApplyPageOperationsInput,
  type PageApiClient,
  type PageMutationResponse,
} from "../page";
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

  it("dispatches session_ref as an atomic read-only renderer", async () => {
    const doc = createPageDoc(1);
    const block = doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!;
    block.set("type", "session_ref");
    const properties = block.get("properties") as Y.Map<unknown>;
    properties.set("sessionId", "session-a");
    const onOpenSession = vi.fn();
    await render(doc, createApi(), vi.fn(), {
      sessionIndex: createSessionSummaryIndex([{
        agentSessionId: "session-a",
        status: "running",
        eventCount: 0,
        prompt: "Referenced session",
      }]),
      onOpenSession,
      lens: "running",
    });

    expect(container!.querySelector("textarea")).toBeNull();
    expect(container!.querySelector("[data-session-ref='session-a']")).not.toBeNull();
    flushSync(() => container!.querySelector<HTMLElement>("[role='button']")!.click());
    expect(onOpenSession).toHaveBeenCalledWith(expect.objectContaining({ agentSessionId: "session-a" }));
  });

  it("offers page autocomplete and inserts only the canonical inline token", async () => {
    const doc = createPageDoc(1);
    const api = createApi({
      searchPages: vi.fn(async () => ({ items: [{ pageId: "page-daily", title: "Daily note" }] })),
    });
    await render(doc, api);

    changeEditor(editor("block-0"), "[[Dai");
    await waitFor(() => container!.querySelector('[role="listbox"]')?.textContent?.includes("Daily note") === true);
    expect(container!.querySelector('[role="listbox"]')?.textContent).toContain("Daily note");
    dispatchKey(editor("block-0"), "Enter", 5);
    await settle();

    expect((doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!.get("text") as Y.Text).toString())
      .toBe("[[Daily note]]");
    expect(api.applyOperations).not.toHaveBeenCalled();
  });

  it("offers block autocomplete and inserts the canonical block id token", async () => {
    const doc = createPageDoc(1);
    const api = createApi({
      searchBlocks: vi.fn(async () => ({
        items: [{ blockId: "block-target", pageId: "page-source", pageTitle: "Source", textPreview: "Decision" }],
      })),
    });
    await render(doc, api);

    changeEditor(editor("block-0"), "((Dec");
    await waitFor(() => container!.querySelector('[role="listbox"]')?.textContent?.includes("Decision") === true);
    dispatchKey(editor("block-0"), "Enter", 5);
    await settle();

    expect((doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!.get("text") as Y.Text).toString())
      .toBe("((block-target))");
  });

  it("focuses a deep-linked block after the virtual row is available", async () => {
    await render(createPageDoc(4), createApi(), vi.fn(), { focusBlockId: "block-3" });
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-3"));
    expect(editor("block-3").selectionStart).toBe(0);
  });

  it("retries deep-link focus when a collapsed target becomes visible", async () => {
    const doc = createPageDoc(2);
    const blocks = doc.getMap<Y.Map<unknown>>("blocks");
    blocks.get("block-0")!.set("collapsed", true);
    blocks.get("block-1")!.set("parentId", "block-0");
    const api = createApi();
    await render(doc, api, vi.fn(), { focusBlockId: "block-1" });
    expect(container!.querySelector('[data-block-id="block-1"]')).toBeNull();

    flushSync(() => blocks.get("block-0")!.set("collapsed", false));
    await rerender(doc, api, vi.fn(), { focusBlockId: "block-1" });
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-1"));
  });

  it("converts a session autocomplete selection through the serialized mutation queue", async () => {
    const doc = createPageDoc(1);
    const api = createApi({ searchPages: vi.fn(async () => ({ items: [] })) });
    await render(doc, api, vi.fn(), {
      sessionIndex: createSessionSummaryIndex([{
        agentSessionId: "session-a",
        status: "completed",
        eventCount: 1,
        displayName: "Release review",
      }]),
    });

    changeEditor(editor("block-0"), "[[Release");
    await settle();
    dispatchKey(editor("block-0"), "Enter", 9);
    await settle();

    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [
        { op: "update_block_text", block_id: "block-0", text: "" },
        {
          op: "update_block_type_and_properties",
          block_id: "block-0",
          block_type: "session_ref",
          properties: { sessionId: "session-a", primary: false },
        },
      ],
    }));
  });

  it("suppresses autocomplete confirmation while IME composition is active", async () => {
    const api = createApi({
      searchPages: vi.fn(async () => ({ items: [{ pageId: "page-korean", title: "한글" }] })),
    });
    await render(createPageDoc(1), api);
    const target = editor("block-0");

    flushSync(() => target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    changeEditor(target, "[[한");
    dispatchKey(target, "Enter", 3);
    await settle();
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
    expect(api.applyOperations).not.toHaveBeenCalled();

    flushSync(() => target.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
    await waitFor(() => container!.querySelector('[role="listbox"]')?.textContent?.includes("한글") === true);
    expect(container!.querySelector('[role="listbox"]')?.textContent).toContain("한글");
  });

  it("does not reopen autocomplete when a dismissed search resolves late", async () => {
    let resolveSearch!: (value: { items: Array<{ pageId: string; title: string }> }) => void;
    const api = createApi({
      searchPages: vi.fn(() => new Promise<{ items: Array<{ pageId: string; title: string }> }>((resolve) => {
        resolveSearch = resolve;
      })),
    });
    await render(createPageDoc(1), api);
    const target = editor("block-0");

    changeEditor(target, "[[Dai");
    expect(container!.querySelector('[role="listbox"]')).not.toBeNull();
    dispatchKey(target, "Escape", 5);
    expect(container!.querySelector('[role="listbox"]')).toBeNull();

    resolveSearch({ items: [{ pageId: "page-daily", title: "Daily note" }] });
    await settle();
    expect(container!.querySelector('[role="listbox"]')).toBeNull();
  });

  it("renders resolved tokens read-only, isolates missing targets, and re-enters textarea editing", async () => {
    const doc = createPageDoc(1);
    setBlockText(doc, "block-0", "See [[Daily note]] ((block-2)) ((deleted))");
    const onOpenPage = vi.fn();
    const onOpenBlock = vi.fn();
    const api = createApi({
      searchPages: vi.fn(async () => ({ items: [{ pageId: "page-daily", title: "Daily note" }] })),
      getBlock: vi.fn(async (blockId) => {
        if (blockId === "deleted") throw new Error("not found");
        return { id: blockId, pageId: "page-source", pageTitle: "Source", parentId: null, positionKey: "a", blockType: "paragraph", text: "Decision", properties: {}, collapsed: false };
      }),
    });
    await render(doc, api, vi.fn(), { onOpenPage, onOpenBlock });
    await settle();

    expect(container!.querySelector("textarea")).toBeNull();
    const pageToken = container!.querySelector<HTMLButtonElement>('[data-reference-kind="page"]')!;
    const blockToken = container!.querySelector<HTMLButtonElement>('[data-reference-value="block-2"]')!;
    flushSync(() => pageToken.click());
    flushSync(() => blockToken.click());
    expect(onOpenPage).toHaveBeenCalledWith("page-daily");
    expect(onOpenBlock).toHaveBeenCalledWith("page-source", "block-2");
    expect(container!.querySelector('[data-reference-value="deleted"][data-reference-state="missing"]'))
      .not.toBeNull();

    flushSync(() => container!.querySelector<HTMLElement>('[data-page-rich-text="block-0"]')!.click());
    await settle();
    const editable = editor("block-0");
    expect(editable.value).toBe("See [[Daily note]] ((block-2)) ((deleted))");

    editable.setSelectionRange(4, 18);
    const clipboard = clipboardTransfer();
    const copyEvent = dispatchClipboard(editable, "copy", clipboard.transfer);
    expect(copyEvent.defaultPrevented).toBe(false);
    expect(editable.value.slice(editable.selectionStart, editable.selectionEnd)).toBe("[[Daily note]]");

    changeEditor(editable, "See  ((block-2)) ((deleted))");
    expect((doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!.get("text") as Y.Text).toString())
      .toBe("See  ((block-2)) ((deleted))");
  });

  it("maps middle Enter to ordered split intents in one HTTP batch", async () => {
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
        expect.objectContaining({ op: "create_block", after_block_id: "block-0" }),
      ]),
    }));

  });

  it("selects the exact /세션 command without mutating the page", async () => {
    const doc = createPageDoc(1);
    const block = doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!;
    (block.get("text") as Y.Text).delete(0, (block.get("text") as Y.Text).length);
    (block.get("text") as Y.Text).insert(0, "/세션");
    const api = createApi();
    const onCreateSessionDraft = vi.fn();
    const expectedVersion = readPageDocument(doc, "page-1").page.mutationVersion;
    await render(doc, api, vi.fn(), { onCreateSessionDraft });

    const target = editor("block-0");
    target.setSelectionRange(3, 3);
    flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    await settle();

    expect(onCreateSessionDraft).toHaveBeenCalledWith(expect.objectContaining({
      pageId: "page-1",
      blockId: "block-0",
      expectedVersion,
    }));
    expect(api.applyOperations).not.toHaveBeenCalled();
  });

  it("maps start Enter to an empty current block followed by the original text", async () => {
    const doc = createPageDoc(1);
    const api = createApi();
    await render(doc, api);

    dispatchKey(editor("block-0"), "Enter", 0);
    await settle();

    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [
        { op: "update_block_text", block_id: "block-0", text: "" },
        expect.objectContaining({ op: "create_block", after_block_id: "block-0", text: "Block 0" }),
      ],
    }));
  });

  it("keeps end Enter below the current row and focuses the created textarea at zero", async () => {
    const doc = createPageDoc(1);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-0")!.set("positionKey", "V");
    setBlockText(doc, "block-0", "Current");
    const api = createApi();
    await render(doc, api);

    dispatchKey(editor("block-0"), "Enter", "Current".length);
    dispatchKey(editor("block-0"), "Enter", "Current".length);
    await settle();
    expect(api.applyOperations).toHaveBeenCalledTimes(1);
    const request = vi.mocked(api.applyOperations).mock.calls[0]?.[1];
    const create = request?.operations.find((operation) => operation.op === "create_block");
    expect(create).toMatchObject({ parent_id: null, after_block_id: "block-0", text: "" });
    if (!create || create.op !== "create_block") throw new Error("missing Enter create operation");

    addProjectedBlock(doc, { id: `created-${create.temp_id}`, positionKey: "k", text: "" });
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await settleFocus();

    expect([...container!.querySelectorAll("[data-page-editor-row]")].map((row) => row.getAttribute("data-block-id")))
      .toEqual(["block-0", `created-${create.temp_id}`]);
    expect(document.activeElement).toBe(editor(`created-${create.temp_id}`));
    expect(editor(`created-${create.temp_id}`).selectionStart).toBe(0);

    dispatchKey(editor(`created-${create.temp_id}`), "Enter", 0);
    await settle();
    expect(api.applyOperations).toHaveBeenCalledTimes(2);
    const nextRequest = vi.mocked(api.applyOperations).mock.calls[1]?.[1];
    const nextCreate = nextRequest?.operations.find((operation) => operation.op === "create_block");
    expect(nextCreate).toMatchObject({ parent_id: null, after_block_id: `created-${create.temp_id}`, text: "" });
    if (!nextCreate || nextCreate.op !== "create_block") throw new Error("missing repeated Enter create operation");

    addProjectedBlock(doc, { id: `created-${nextCreate.temp_id}`, positionKey: "s", text: "" });
    doc.getMap("pageMeta").set("mutationVersion", 5);
    await rerender(doc, api);
    await settleFocus();

    expect([...container!.querySelectorAll("[data-page-editor-row]")].map((row) => row.getAttribute("data-block-id")))
      .toEqual(["block-0", `created-${create.temp_id}`, `created-${nextCreate.temp_id}`]);
    expect(document.activeElement).toBe(editor(`created-${nextCreate.temp_id}`));
    expect(editor(`created-${nextCreate.temp_id}`).selectionStart).toBe(0);
  });

  it("outdents an empty nested block on Enter and keeps focus on that block", async () => {
    const doc = createPageDoc(2);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    setBlockText(doc, "block-1", "");
    const api = createApi();
    await render(doc, api);

    dispatchKey(editor("block-1"), "Enter", 0);
    await settle();

    expect(api.applyOperations).toHaveBeenCalledWith("page-1", expect.objectContaining({
      operations: [expect.objectContaining({
        op: "move_block",
        block_id: "block-1",
        parent_id: null,
        after_block_id: "block-0",
      })],
    }));
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", null);
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await settleFocus();
    expect(document.activeElement).toBe(editor("block-1"));
    expect(editor("block-1").selectionStart).toBe(0);
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
    [0, 0],
    [2, 5],
    [7, 7],
  ] as const)("preserves Tab selection range %i..%i after projection", async (anchor, focus) => {
    const doc = createPageDoc(2);
    const api = createApi();
    await render(doc, api);
    const second = editor("block-1");
    second.focus();
    second.setSelectionRange(anchor, focus);

    flushSync(() => second.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    })));
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await settleFocus();

    expect(document.activeElement).toBe(editor("block-1"));
    expect(editor("block-1").selectionStart).toBe(anchor);
    expect(editor("block-1").selectionEnd).toBe(focus);
  });

  it("preserves Shift+Tab caret after projection", async () => {
    const doc = createPageDoc(2);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    const api = createApi();
    await render(doc, api);
    dispatchKey(editor("block-1"), "Tab", 4, { shiftKey: true });
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", null);
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await settleFocus();
    expect(editor("block-1").selectionStart).toBe(4);
    expect(editor("block-1").selectionEnd).toBe(4);
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

  it("extends Shift+Arrow across four blocks and contracts from the moving focus edge", async () => {
    await render(createPageDoc(5), createApi());
    const second = editor("block-1");
    second.focus();
    dispatchKey(second, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(second, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(second, "ArrowDown", 7, { shiftKey: true });

    expect(selectedRowIds()).toEqual(["block-1", "block-2", "block-3", "block-4"]);

    dispatchKey(second, "ArrowUp", 0, { shiftKey: true });
    dispatchKey(second, "ArrowUp", 0, { shiftKey: true });
    expect(selectedRowIds()).toEqual(["block-1", "block-2"]);

    dispatchKey(second, "ArrowUp", 0, { shiftKey: true });
    dispatchKey(second, "ArrowUp", 0, { shiftKey: true });
    expect(selectedRowIds()).toEqual(["block-0", "block-1"]);
  });

  it("copies a multi-block selection to plain text and structured MIME without mutation", async () => {
    const doc = createPageDoc(4);
    const properties = doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.get("properties") as Y.Map<unknown>;
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("type", "checklist");
    properties.set("checked", true);
    await render(doc, createApi());
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    const before = readPageDocument(doc, "page-1").blocks.map((block) => block.textValue);
    const clipboard = clipboardTransfer();

    const event = dispatchClipboard(first, "copy", clipboard.transfer);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.data.get("text/plain")).toBe("Block 0\nBlock 1\nBlock 2\nBlock 3");
    const structured = decodeStructuredClipboard(clipboard.data.get(PAGE_BLOCK_CLIPBOARD_MIME)!);
    expect(structured.blocks[1]).toMatchObject({
      text: "Block 1",
      type: "checklist",
      properties: { checked: true },
    });
    expect(readPageDocument(doc, "page-1").blocks.map((block) => block.textValue)).toEqual(before);
  });

  it("pastes the structured MIME produced by a real copy event with fresh IDs", async () => {
    const doc = createPageDoc(3);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    const api = createApi();
    await render(doc, api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    const clipboard = clipboardTransfer();
    dispatchClipboard(first, "copy", clipboard.transfer);

    const destination = editor("block-2");
    destination.focus();
    destination.setSelectionRange(0, destination.value.length);
    dispatchPasteData(destination, Object.fromEntries(clipboard.data));
    await settle();

    const operations = vi.mocked(api.applyOperations).mock.calls[0]?.[1].operations ?? [];
    expect(operations).toEqual([
      { op: "update_block_text", block_id: "block-2", text: "Block 0" },
      {
        op: "update_block_type_and_properties",
        block_id: "block-2",
        block_type: "paragraph",
        properties: {},
      },
      expect.objectContaining({
        op: "create_block",
        parent_id: "block-2",
        text: "Block 1",
      }),
    ]);
    const created = operations.filter((operation) => operation.op === "create_block");
    expect(new Set(created.map((operation) => operation.temp_id)).size).toBe(created.length);
    expect(created.every((operation) => !["block-0", "block-1"].includes(operation.temp_id))).toBe(true);
  });

  it("keeps a single textarea partial selection on native copy", async () => {
    await render(createPageDoc(1), createApi());
    const first = editor("block-0");
    first.focus();
    first.setSelectionRange(1, 4);
    const clipboard = clipboardTransfer();
    const event = dispatchClipboard(first, "copy", clipboard.transfer);
    expect(event.defaultPrevented).toBe(false);
    expect(clipboard.data.size).toBe(0);
  });

  it("cuts only after both clipboard formats are written", async () => {
    const api = createApi();
    await render(createPageDoc(3), api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    const clipboard = clipboardTransfer();

    dispatchClipboard(first, "cut", clipboard.transfer);
    await settle();

    expect([...clipboard.data.keys()]).toEqual([PAGE_BLOCK_CLIPBOARD_MIME, "text/plain"]);
    expect(api.applyOperations).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.applyOperations).mock.calls[0]?.[1].operations).toEqual([
      { op: "delete_block_subtree", block_id: "block-0" },
      { op: "delete_block_subtree", block_id: "block-1" },
      { op: "delete_block_subtree", block_id: "block-2" },
    ]);
  });

  it("cuts a parent-child-sibling range once per structural root", async () => {
    const doc = createPageDoc(3);
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    const api = createApi();
    await render(doc, api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });

    dispatchClipboard(first, "cut", clipboardTransfer().transfer);
    await settle();

    expect(vi.mocked(api.applyOperations).mock.calls[0]?.[1].operations).toEqual([
      { op: "delete_block_subtree", block_id: "block-0" },
      { op: "delete_block_subtree", block_id: "block-2" },
    ]);
  });

  it("does not delete when clipboard writing fails and shows feedback", async () => {
    const api = createApi();
    await render(createPageDoc(2), api);
    const first = editor("block-0");
    first.focus();
    dispatchKey(first, "ArrowDown", 7, { shiftKey: true });
    const clipboard = clipboardTransfer({ failOn: "text/plain" });

    const event = dispatchClipboard(first, "cut", clipboard.transfer);
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(api.applyOperations).not.toHaveBeenCalled();
    expect(container!.querySelector('[data-editor-feedback="error"]')?.textContent)
      .toContain("clipboard");
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

  it("prefers structured MIME and restores block type and properties", async () => {
    const api = createApi();
    const doc = createPageDoc(1);
    setBlockText(doc, "block-0", "");
    await render(doc, api);
    const structured: StructuredClipboardPayload = {
      schema: "soulstream-page-blocks",
      version: 1,
      blocks: [{
        text: "Task",
        type: "checklist",
        properties: { checked: true },
        collapsed: false,
        children: [],
      }],
    };

    dispatchPasteData(editor("block-0"), {
      "text/plain": "fallback",
      [PAGE_BLOCK_CLIPBOARD_MIME]: encodeStructuredClipboard(structured),
    });
    await settle();

    expect(vi.mocked(api.applyOperations).mock.calls[0]?.[1].operations).toEqual([
      { op: "update_block_text", block_id: "block-0", text: "Task" },
      {
        op: "update_block_type_and_properties",
        block_id: "block-0",
        block_type: "checklist",
        properties: { checked: true },
      },
    ]);
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

  it("replays Tab, Shift+Tab, and paste in FIFO order after each projection", async () => {
    const doc = createPageDoc(3);
    const pending: Array<{
      input: ApplyPageOperationsInput;
      resolve(value: PageMutationResponse): void;
    }> = [];
    const api = createApi({
      applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => new Promise<PageMutationResponse>((resolve) => {
        pending.push({ input, resolve });
      })),
    });
    await render(doc, api);
    const second = editor("block-1");
    second.focus();

    dispatchKey(second, "Tab", 4);
    dispatchKey(second, "Tab", 4, { shiftKey: true });
    dispatchPaste(second, "queued paste");
    await waitFor(() => pending.length === 1);
    expect(api.applyOperations).toHaveBeenCalledTimes(1);

    pending[0]!.resolve(operationResponse(pending[0]!.input));
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await waitFor(() => pending.length === 2);

    pending[1]!.resolve(operationResponse(pending[1]!.input));
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", null);
    doc.getMap("pageMeta").set("mutationVersion", 5);
    await rerender(doc, api);
    await waitFor(() => pending.length === 3);

    expect(pending.map(({ input }) => input.operations[0])).toEqual([
      expect.objectContaining({ op: "move_block", block_id: "block-1", parent_id: "block-0" }),
      expect.objectContaining({ op: "move_block", block_id: "block-1", parent_id: null }),
      { op: "update_block_text", block_id: "block-1", text: "Blocqueued pastek 1" },
    ]);
    expect(new Set(pending.map(({ input }) => input.idempotencyKey)).size).toBe(3);
  });

  it("keeps an ambiguous API failure visible while later Tab and paste intents continue safely", async () => {
    const doc = createPageDoc(3);
    const pending: Array<{
      input: ApplyPageOperationsInput;
      resolve(value: PageMutationResponse): void;
    }> = [];
    let callCount = 0;
    const api = createApi({
      applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => {
        callCount += 1;
        if (callCount === 1) throw new Error("connection closed before response");
        return new Promise<PageMutationResponse>((resolve) => pending.push({ input, resolve }));
      }),
    });
    await render(doc, api);
    const second = editor("block-1");

    dispatchKey(second, "Tab", 4);
    dispatchKey(second, "Tab", 4);
    dispatchPaste(second, "queued paste");

    await waitFor(() => vi.mocked(api.applyOperations).mock.calls.length === 2);
    await waitFor(() => container!.querySelector('[data-editor-feedback="error"]') !== null);
    expect(container!.querySelector('[data-editor-feedback="error"]')?.textContent)
      .toContain("could not be confirmed");
    expect(container!.querySelector('[data-editor-feedback="error"]')?.textContent)
      .toContain("2 later edits will continue");

    pending[0]!.resolve(operationResponse(pending[0]!.input));
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await waitFor(() => vi.mocked(api.applyOperations).mock.calls.length === 3);

    expect(container!.querySelector('[data-editor-feedback="error"]')?.textContent)
      .toContain("connection closed before response");
    expect(pending.map(({ input }) => input.operations[0])).toEqual([
      expect.objectContaining({ op: "move_block", block_id: "block-1", parent_id: "block-0" }),
      { op: "update_block_text", block_id: "block-1", text: "Blocqueued pastek 1" },
    ]);
  });

  it("does not wait again when projection arrives before the HTTP response", async () => {
    const doc = createPageDoc(2);
    const pending: Array<{
      input: ApplyPageOperationsInput;
      resolve(value: PageMutationResponse): void;
    }> = [];
    const api = createApi({
      applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => new Promise<PageMutationResponse>((resolve) => {
        pending.push({ input, resolve });
      })),
    });
    await render(doc, api);
    const second = editor("block-1");
    dispatchKey(second, "Tab", 4);
    dispatchKey(second, "Tab", 4, { shiftKey: true });
    await waitFor(() => pending.length === 1);

    doc.getMap<Y.Map<unknown>>("blocks").get("block-1")!.set("parentId", "block-0");
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    pending[0]!.resolve(operationResponse(pending[0]!.input));
    await waitFor(() => pending.length === 2);

    expect(pending[1]!.input.operations[0]).toMatchObject({
      op: "move_block",
      block_id: "block-1",
      parent_id: null,
    });
  });

  it("ignores a completed command after the editor doc is replaced", async () => {
    const oldDoc = createPageDoc(2);
    let resolve!: (value: PageMutationResponse) => void;
    let request!: ApplyPageOperationsInput;
    const api = createApi({
      applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => new Promise<PageMutationResponse>((done) => {
        request = input;
        resolve = done;
      })),
    });
    await render(oldDoc, api);
    dispatchKey(editor("block-1"), "Tab", 4);
    await waitFor(() => request !== undefined);

    const replacementDoc = createPageDoc(2);
    await rerender(replacementDoc, api);
    resolve(operationResponse(request));
    await settle();

    expect(container!.querySelector("[data-editor-state]")).toBeNull();
    expect(container!.querySelector("[data-editor-feedback]")).toBeNull();
  });

  it("fails a stale queued paste explicitly without applying it to another block", async () => {
    const doc = createPageDoc(2);
    const pending: Array<{
      input: ApplyPageOperationsInput;
      resolve(value: PageMutationResponse): void;
    }> = [];
    const api = createApi({
      applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => new Promise<PageMutationResponse>((resolve) => {
        pending.push({ input, resolve });
      })),
    });
    await render(doc, api);
    const second = editor("block-1");
    dispatchKey(second, "Tab", 4);
    dispatchPaste(second, "must not move");
    await waitFor(() => pending.length === 1);

    pending[0]!.resolve(operationResponse(pending[0]!.input));
    await settle();
    doc.getMap<Y.Map<unknown>>("blocks").delete("block-1");
    doc.getMap("pageMeta").set("mutationVersion", 4);
    await rerender(doc, api);
    await waitFor(() => container!.querySelector('[data-editor-feedback="error"]') !== null);

    expect(api.applyOperations).toHaveBeenCalledTimes(1);
    expect(container!.querySelector('[data-editor-feedback="error"]')?.textContent)
      .toContain("no longer exists");
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

  async function render(
    doc: Y.Doc,
    api: PageApiClient,
    onResync = vi.fn(),
    sessionProps: Pick<React.ComponentProps<typeof PageOutliner>, "sessionIndex" | "onOpenSession" | "lens" | "onCreateSessionDraft" | "onOpenPage" | "onOpenBlock" | "focusBlockId"> = {},
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await rerender(doc, api, onResync, sessionProps);
  }

  async function rerender(
    doc: Y.Doc,
    api: PageApiClient,
    onResync = vi.fn(),
    sessionProps: Pick<React.ComponentProps<typeof PageOutliner>, "sessionIndex" | "onOpenSession" | "lens" | "onCreateSessionDraft" | "onOpenPage" | "onOpenBlock" | "focusBlockId"> = {},
  ) {
    const snapshot = readPageDocument(doc, "page-1");
    flushSync(() => root!.render(
      <PageOutliner
        pageId="page-1"
        doc={doc}
        blocks={snapshot.blocks}
        mutationVersion={snapshot.page.mutationVersion}
        apiClient={api}
        onResync={onResync}
        {...sessionProps}
      />,
    ));
    await settle();
  }

  function editor(blockId: string): HTMLTextAreaElement {
    return container!.querySelector<HTMLTextAreaElement>(`[data-block-id="${blockId}"] textarea`)!;
  }

  function selectedRowIds(): string[] {
    return [...container!.querySelectorAll<HTMLElement>('[data-page-editor-row][aria-selected="true"]')]
      .map((row) => row.dataset.blockId!);
  }
});

function addProjectedBlock(
  doc: Y.Doc,
  input: { id: string; parentId?: string | null; positionKey: string; text: string },
): void {
  const block = new Y.Map<unknown>();
  block.set("id", input.id);
  block.set("parentId", input.parentId ?? null);
  block.set("positionKey", input.positionKey);
  block.set("type", "paragraph");
  block.set("text", new Y.Text(input.text));
  block.set("properties", new Y.Map());
  block.set("collapsed", false);
  doc.getMap<Y.Map<unknown>>("blocks").set(input.id, block);
}

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
    searchPages: vi.fn(async () => ({ items: [] })),
    searchBlocks: vi.fn(async () => ({ items: [] })),
    getBlock: vi.fn(async () => { throw new Error("not found"); }),
    getBacklinks: vi.fn(async () => ({ items: [], nextCursor: null })),
    getPage: vi.fn(),
    getDailyPage: vi.fn(),
    setStarred: vi.fn(),
    applyOperations: vi.fn(async (_pageId: string, input: ApplyPageOperationsInput) => operationResponse(input)),
    ...overrides,
  } as PageApiClient;
}

function changeEditor(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.setSelectionRange(value.length, value.length);
  flushSync(() => textarea.dispatchEvent(new Event("input", { bubbles: true })));
}

function operationResponse(input: ApplyPageOperationsInput) {
  return {
    page: { id: "page-1", title: "Page", daily_date: null, version: input.expectedVersion + 1, archived: false, metadata: {}, created_at: "", updated_at: "" },
    blocks: [],
    operation: { id: `operation-${input.idempotencyKey}` },
    temp_id_mapping: Object.fromEntries(input.operations.flatMap((operation) => operation.op === "create_block" ? [[operation.temp_id, `created-${operation.temp_id}`]] : [])),
  };
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
  dispatchPasteData(textarea, { "text/plain": plainText });
}

function dispatchPasteData(
  textarea: HTMLTextAreaElement,
  values: Readonly<Record<string, string>>,
): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => values[type] ?? "",
      files: [],
    },
  });
  flushSync(() => textarea.dispatchEvent(event));
  return event;
}

function clipboardTransfer(options: { failOn?: string } = {}) {
  const data = new Map<string, string>();
  const transfer = {
    files: [],
    getData(type: string) { return data.get(type) ?? ""; },
    setData(type: string, value: string) {
      if (options.failOn === type) throw new Error("clipboard unavailable");
      data.set(type, value);
    },
    clearData() { data.clear(); },
  } as unknown as DataTransfer;
  return { data, transfer };
}

function dispatchClipboard(
  textarea: HTMLTextAreaElement,
  type: "copy" | "cut",
  clipboardData: DataTransfer,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  flushSync(() => textarea.dispatchEvent(event));
  return event;
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

async function waitFor(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("condition was not reached");
}
