/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
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
import { MarkdownDocumentPanel } from "./MarkdownDocumentPanel";

interface SyncAwareTestRuntime extends BoardYjsRuntime {
  hasInitialSync: () => boolean;
  completeInitialSync: () => void;
  mutations: {
    title: ReturnType<typeof vi.fn>;
    body: ReturnType<typeof vi.fn>;
  };
}

function createInitiallyUnsyncedRuntime(folderId: string): SyncAwareTestRuntime {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const listeners = new Set<() => void>();
  const container = { kind: "folder" as const, id: folderId };
  let initialSyncComplete = false;
  const mutations = {
    title: vi.fn(),
    body: vi.fn(),
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const runtime: SyncAwareTestRuntime = {
    folderId,
    container,
    containerKey: `folder:${folderId}`,
    doc,
    awareness,
    isProviderBacked: true,
    hasInitialSync: () => initialSyncComplete,
    completeInitialSync: () => {
      createMarkdownYjsDocument(doc, folderId, {
        documentId: "doc-a",
        title: "Design note",
        body: "Original body",
        x: 0,
        y: 0,
      });
      initialSyncComplete = true;
      notify();
    },
    mutations,
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
    getMarkdownText: (documentId) => {
      const existing = doc.getMap<Y.Text>("markdownBodies").get(documentId);
      return existing ?? doc.getText(`unsafe-unsynced:${documentId}`);
    },
    updateMarkdownTitle: (documentId, title) => {
      mutations.title(documentId, title);
      updateMarkdownYjsTitle(doc, documentId, title);
      notify();
    },
    updateMarkdownBody: (documentId, body) => {
      mutations.body(documentId, body);
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
  return runtime;
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${message}`);
}

describe("MarkdownDocumentPanel restore safety", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let runtime: SyncAwareTestRuntime;
  let unregisterRuntime: (() => void) | null = null;

  beforeEach(() => {
    useDashboardStore.getState().reset();
    useDashboardStore.getState().selectFolder("folder-a");
    runtime = createInitiallyUnsyncedRuntime("folder-a");
    unregisterRuntime = registerBoardYjsRuntime(runtime);
    useDashboardStore.getState().requestBoardDocumentEdit("doc-a");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(createElement(MarkdownDocumentPanel));
    });
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    unregisterRuntime?.();
    runtime.awareness.destroy();
    runtime.doc.destroy();
    container?.remove();
    vi.restoreAllMocks();
  });

  it("keeps the edit request pending until first sync, then opens the original body", async () => {
    await settle();

    expect(container?.querySelector('[data-testid="markdown-codemirror-editor"]')).toBeNull();
    expect(useDashboardStore.getState().pendingBoardDocumentEditId).toBe("doc-a");
    expect(runtime.doc.getMap<Y.Text>("markdownBodies").size).toBe(0);

    flushSync(() => runtime.completeInitialSync());

    await waitFor(
      () => container?.querySelector(".cm-content")?.textContent?.includes("Original body") === true,
      "the synced markdown editor with its original body",
    );
    expect(container?.querySelector(".cm-content")?.textContent).toContain("Original body");
    expect(useDashboardStore.getState().pendingBoardDocumentEditId).toBeNull();
  });

  it("does not save title or body while the document body is still unloaded", async () => {
    const title = container?.querySelector<HTMLInputElement>('input[aria-label="Document title"]');
    expect(title).not.toBeNull();

    flushSync(() => {
      title?.focus();
      title?.blur();
    });
    await settle();

    expect(runtime.mutations.title).not.toHaveBeenCalled();
    expect(runtime.mutations.body).not.toHaveBeenCalled();
  });
});
