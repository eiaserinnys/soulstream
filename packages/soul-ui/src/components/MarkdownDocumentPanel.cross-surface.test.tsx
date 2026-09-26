/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";

describe("MarkdownDocumentPanel container ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
  });

  it("keeps a same-id document update inside its explicitly selected container", async () => {
    const firstRuntime = createRuntime("folder-a", "First container body");
    const secondRuntime = createRuntime("folder-b", "Second container body");
    for (const runtime of [firstRuntime, secondRuntime]) {
      cleanups.push(registerBoardYjsRuntime(runtime));
      cleanups.push(() => {
        runtime.awareness.destroy();
        runtime.doc.destroy();
      });
    }

    flushSync(() => root.render(createElement("div", null,
      createElement("section", { "data-testid": "first" }, createElement(MarkdownDocumentPanel, props("folder-a"))),
      createElement("section", { "data-testid": "second" }, createElement(MarkdownDocumentPanel, props("folder-b"))),
    )));

    const first = container.querySelector<HTMLElement>("[data-testid='first']");
    const second = container.querySelector<HTMLElement>("[data-testid='second']");
    await waitForText(first, "First container body");
    await waitForText(second, "Second container body");

    flushSync(() => secondRuntime.updateMarkdownBody("doc-a", "Updated second container"));

    await waitForText(second, "Updated second container");
    expect(first?.querySelector('[data-testid="markdown-read-body"]')?.textContent)
      .toContain("First container body");
  });
});

function props(folderId: string) {
  return {
    documentId: "doc-a",
    container: { kind: "folder" as const, id: folderId },
    onPendingEditConsumed: () => undefined,
    onClose: () => undefined,
    onDeleted: () => undefined,
  };
}

function createRuntime(folderId: string, body: string): BoardYjsRuntime {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  createMarkdownYjsDocument(doc, folderId, {
    documentId: "doc-a",
    title: "Design note",
    body,
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
    updateMarkdownBody: (documentId, nextBody) => {
      updateMarkdownYjsBody(doc, documentId, nextBody);
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

async function waitForText(container: ParentNode | null, text: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (container?.querySelector('[data-testid="markdown-read-body"]')?.textContent?.includes(text)) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for markdown text ${text}`);
}
