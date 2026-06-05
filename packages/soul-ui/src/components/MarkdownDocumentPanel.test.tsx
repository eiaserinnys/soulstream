/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import type { BoardYjsRuntime } from "../board-workspace";
import {
  catalogBoardItemsFromYDoc,
  createMarkdownYjsDocument,
  deleteBoardYjsItem,
  getOrCreateMarkdownText,
  registerBoardYjsRuntime,
  updateMarkdownYjsBody,
  updateMarkdownYjsTitle,
  upsertBoardYjsItem,
} from "../board-workspace";
import { useDashboardStore } from "../stores/dashboard-store";
import { createMarkdownEditorExtensions } from "./MarkdownCodeMirrorEditor";
import { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";

function renderPanel(options: { folderId?: string } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  useDashboardStore.getState().reset();
  if (options.folderId) {
    useDashboardStore.getState().selectFolder(options.folderId);
  }
  useDashboardStore.getState().setActiveBoardDocument("doc-a");
  flushSync(() => {
    root.render(createElement(MarkdownDocumentPanel));
  });
  return { container, root };
}

async function waitForSelector<T extends Element>(container: ParentNode, selector: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const element = container.querySelector<T>(selector);
    if (element) return element;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForFetchBody(fetchMock: ReturnType<typeof vi.fn>, body: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const matched = fetchMock.mock.calls.some(([, init]) => init?.method === "PUT" && init.body === body);
    if (matched) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for fetch body ${body}. Calls: ${JSON.stringify(fetchMock.mock.calls)}`);
}

async function waitForText(container: ParentNode, selector: string, text: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (container.querySelector(selector)?.textContent === text) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${selector} text ${text}`);
}

async function waitForEditorView(container: ParentNode): Promise<EditorView> {
  const editor = await waitForSelector<HTMLElement>(container, ".cm-editor");
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("CodeMirror EditorView not found");
  return view;
}

function replaceEditorDoc(view: EditorView, value: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: value },
  });
}

function dispatchEditorKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

function createStandaloneEditor(params: {
  doc?: string;
  yText?: Y.Text;
  awareness?: Awareness;
  undoManager?: Y.UndoManager;
  onChange?: (value: string) => void;
}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: params.yText ? params.yText.toString() : params.doc ?? "",
      extensions: createMarkdownEditorExtensions({
        yText: params.yText ?? null,
        awareness: params.awareness ?? null,
        undoManager: params.undoManager ?? null,
        onChange: params.onChange ?? (() => undefined),
        onBlur: () => undefined,
        onEscape: () => undefined,
      }),
    }),
  });
  return {
    view,
    destroy: () => {
      view.destroy();
      parent.remove();
    },
  };
}

function createRuntime(folderId: string): BoardYjsRuntime {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  createMarkdownYjsDocument(doc, folderId, {
    documentId: "doc-a",
    title: "Design note",
    body: "Initial body",
    x: 0,
    y: 0,
  });
  return {
    folderId,
    doc,
    awareness,
    isProviderBacked: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBoardItems: () => catalogBoardItemsFromYDoc(folderId, doc),
    updateBoardItemPosition: () => undefined,
    upsertBoardItem: (boardItem) => {
      upsertBoardYjsItem(doc, boardItem);
      notify();
    },
    deleteBoardItem: (boardItemId) => {
      deleteBoardYjsItem(doc, boardItemId);
      notify();
    },
    createMarkdownDocument: (input) => {
      const created = createMarkdownYjsDocument(doc, folderId, input);
      notify();
      return created;
    },
    getMarkdownText: (documentId) => getOrCreateMarkdownText(doc, documentId),
    updateMarkdownTitle: (documentId, title) => {
      updateMarkdownYjsTitle(doc, documentId, title);
      notify();
    },
    updateMarkdownBody: (documentId, body) => {
      updateMarkdownYjsBody(doc, documentId, body);
      notify();
    },
    deleteMarkdownDocument: (documentId) => {
      deleteBoardYjsItem(doc, `markdown:${documentId}`);
      doc.getMap<Y.Text>("markdownBodies").delete(documentId);
      notify();
    },
    setLocalSelection: () => undefined,
    getRemoteSelections: () => [],
  };
}

describe("MarkdownDocumentPanel", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;
  let cleanupRuntime: (() => void) | undefined;
  const standaloneCleanups: Array<() => void> = [];

  beforeEach(() => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/catalog/markdown-documents/doc-a") && !init) {
        return new Response(JSON.stringify({
          id: "doc-a",
          title: "Design note",
          body: "Initial body",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/api/catalog/markdown-documents/doc-a") && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          id: "doc-a",
          title: body.title,
          body: body.body,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    cleanupRuntime?.();
    cleanupRuntime = undefined;
    for (const cleanup of standaloneCleanups.splice(0)) cleanup();
    vi.restoreAllMocks();
  });

  it("switches to CodeMirror on body click and saves edited body on blur", async () => {
    ({ container, root } = renderPanel());

    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    expect(readBody.textContent).toContain("Initial body");

    flushSync(() => {
      readBody!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const view = await waitForEditorView(container);
    expect(container.querySelector("textarea")).toBeNull();

    flushSync(() => {
      replaceEditorDoc(view, "Edited body");
    });
    await Promise.resolve();

    flushSync(() => {
      view.contentDOM.dispatchEvent(new FocusEvent("blur"));
    });
    await waitForFetchBody(fetchMock, JSON.stringify({ title: "Design note", body: "Edited body" }));

    expect(fetchMock.mock.calls).toContainEqual([
      "/api/catalog/markdown-documents/doc-a",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ title: "Design note", body: "Edited body" }),
      }),
    ]);
    await waitForText(container, '[data-testid="markdown-save-status"]', "저장됨");
    expect(container.querySelector('[data-testid="markdown-save-status"]')?.textContent).toBe("저장됨");
    expect(container.querySelector('button[title="Delete document"]')).not.toBeNull();
  });

  it("restores the last saved body when Escape is pressed", async () => {
    ({ container, root } = renderPanel());

    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    flushSync(() => {
      readBody.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const view = await waitForEditorView(container);

    flushSync(() => {
      replaceEditorDoc(view, "Draft body");
    });

    flushSync(() => {
      dispatchEditorKey(view, "Escape");
    });

    expect(container.querySelector(".cm-editor")).toBeNull();
    expect(container.querySelector('[data-testid="markdown-read-body"]')?.textContent).toContain("Initial body");
  });

  it("applies markdown shortcuts for bold, italic, links, code, and line deletion", () => {
    const editor = createStandaloneEditor({ doc: "alpha beta" });
    standaloneCleanups.push(editor.destroy);

    editor.view.dispatch({ selection: { anchor: 0, head: 5 } });
    dispatchEditorKey(editor.view, "b", { ctrlKey: true });
    expect(editor.view.state.doc.toString()).toBe("**alpha** beta");

    editor.view.dispatch({ selection: { anchor: 10, head: 14 } });
    dispatchEditorKey(editor.view, "i", { ctrlKey: true });
    expect(editor.view.state.doc.toString()).toBe("**alpha** *beta*");

    editor.view.dispatch({ selection: { anchor: 2, head: 7 } });
    dispatchEditorKey(editor.view, "k", { ctrlKey: true });
    expect(editor.view.state.doc.toString()).toBe("**[alpha](url)** *beta*");

    editor.view.dispatch({ selection: { anchor: 18, head: 22 } });
    dispatchEditorKey(editor.view, "/", { ctrlKey: true });
    expect(editor.view.state.doc.toString()).toBe("**[alpha](url)** *`beta`*");

    editor.view.dispatch({ selection: { anchor: 0 } });
    dispatchEditorKey(editor.view, "K", { ctrlKey: true, shiftKey: true });
    expect(editor.view.state.doc.toString()).toBe("");
  });

  it("keeps two CodeMirror views synchronized through the same Y.Text", () => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const yText = doc.getText("body");
    yText.insert(0, "Shared");
    const undoA = new Y.UndoManager(yText);
    const undoB = new Y.UndoManager(yText);
    const a = createStandaloneEditor({ yText, awareness, undoManager: undoA });
    const b = createStandaloneEditor({ yText, awareness, undoManager: undoB });
    standaloneCleanups.push(() => {
      a.destroy();
      b.destroy();
      undoA.destroy();
      undoB.destroy();
      awareness.destroy();
      doc.destroy();
    });

    a.view.dispatch({ changes: { from: 6, insert: " text" } });

    expect(yText.toString()).toBe("Shared text");
    expect(b.view.state.doc.toString()).toBe("Shared text");
  });

  it("binds the panel editor to the active runtime Y.Text", async () => {
    const runtime = createRuntime("folder-a");
    cleanupRuntime = registerBoardYjsRuntime(runtime);
    ({ container, root } = renderPanel({ folderId: "folder-a" }));

    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    expect(readBody.textContent).toContain("Initial body");
    flushSync(() => {
      readBody.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const view = await waitForEditorView(container);

    flushSync(() => {
      replaceEditorDoc(view, "Collaborative body");
    });

    expect(runtime.getMarkdownText("doc-a").toString()).toBe("Collaborative body");
    await waitForText(container, '[data-testid="markdown-save-status"]', "동기화됨");
  });
});
