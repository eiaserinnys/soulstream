/**
 * @vitest-environment jsdom
 */

import { EditorView } from "@codemirror/view";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  catalogBoardItemsFromYDoc,
  createMarkdownYjsDocument,
  deleteBoardYjsItem,
  getOrCreateMarkdownText,
  registerBoardYjsRuntime,
  updateMarkdownYjsBody,
  updateMarkdownYjsTitle,
  upsertBoardYjsItem,
  type BoardYjsRuntime,
} from "../board-workspace";
import {
  publishMarkdownDocumentUpdate,
  subscribeMarkdownDocumentUpdates,
} from "../lib/markdown-document-operations";
import { useDashboardStore } from "../stores/dashboard-store";
import { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";

describe("MarkdownDocumentPanel cross-surface sync", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "doc-a",
      title: "Design note",
      body: "Initial body",
      version: 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setActiveBoardDocument("doc-a");
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    for (const cleanup of cleanups.splice(0)) cleanup();
    globalThis.fetch = originalFetch;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("applies a confirmed save from another open surface while in read mode", async () => {
    flushSync(() => root.render(createElement(MarkdownDocumentPanel)));
    await waitForSelector(container, '[data-testid="markdown-read-body"]');

    flushSync(() => {
      publishMarkdownDocumentUpdate({
        id: "doc-a",
        title: "Updated elsewhere",
        body: "Saved by another surface",
        version: 2,
      });
    });

    await waitForContent(container, '[data-testid="markdown-read-body"]', "Saved by another surface");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Document title"]')?.value)
      .toBe("Updated elsewhere");
  });

  it("does not overwrite a local draft with another surface update", async () => {
    flushSync(() => root.render(createElement(MarkdownDocumentPanel)));
    const readBody = await waitForSelector<HTMLElement>(container, '[data-testid="markdown-read-body"]');
    flushSync(() => readBody.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const editor = await waitForEditor(container);
    flushSync(() => editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "Local draft" },
    }));

    flushSync(() => {
      publishMarkdownDocumentUpdate({
        id: "doc-a",
        title: "Updated elsewhere",
        body: "Saved by another surface",
        version: 2,
      });
    });

    expect(editor.state.doc.toString()).toBe("Local draft");
  });

  it("publishes the active runtime snapshot to other document surfaces", async () => {
    const runtime = createRuntime("folder-a");
    cleanups.push(registerBoardYjsRuntime(runtime));
    cleanups.push(() => {
      runtime.awareness.destroy();
      runtime.doc.destroy();
    });
    const listener = vi.fn();
    cleanups.push(subscribeMarkdownDocumentUpdates("doc-a", listener));
    useDashboardStore.getState().selectFolder("folder-a");
    flushSync(() => root.render(createElement(MarkdownDocumentPanel)));
    await waitForSelector(container, '[data-testid="markdown-read-body"]');
    listener.mockClear();

    flushSync(() => runtime.updateMarkdownBody("doc-a", "Runtime update"));

    await waitForCondition(() => listener.mock.calls.some(([document]) => (
      document.body === "Runtime update"
    )));
  });
});

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
    container: { kind: "folder", id: folderId },
    containerKey: `folder:${folderId}`,
    doc,
    awareness,
    isProviderBacked: false,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getBoardItems: () => catalogBoardItemsFromYDoc(folderId, doc),
    updateBoardItemPosition: () => undefined,
    upsertBoardItem: (item) => {
      upsertBoardYjsItem(doc, item);
      notify();
    },
    deleteBoardItem: (itemId) => {
      deleteBoardYjsItem(doc, itemId);
      notify();
    },
    createMarkdownDocument: (input) => createMarkdownYjsDocument(doc, folderId, input),
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

async function waitForSelector<T extends Element>(
  container: ParentNode,
  selector: string,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const element = container.querySelector<T>(selector);
    if (element) return element;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

async function waitForContent(container: ParentNode, selector: string, content: string) {
  await waitForCondition(() => container.querySelector(selector)?.textContent?.includes(content) === true);
}

async function waitForEditor(container: ParentNode): Promise<EditorView> {
  const editor = await waitForSelector<HTMLElement>(container, ".cm-editor");
  const view = EditorView.findFromDOM(editor);
  if (!view) throw new Error("CodeMirror EditorView not found");
  return view;
}

async function waitForCondition(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}
