/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { useDashboardStore } from "@seosoyoung/soul-ui";

import { TaskInlineBoard } from "./TaskInlineBoard";
import type { TaskMoveTarget } from "./task-move-targets";

const documentItem = {
  id: "markdown:doc-1",
  folderId: "folder-1",
  containerKind: "task" as const,
  containerId: "task-1",
  itemType: "markdown" as const,
  itemId: "doc-1",
  x: 20,
  y: 30,
  metadata: { title: "실수로 만든 문서", version: 1 },
};

describe("TaskInlineBoard document context menu", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let originalFetch: typeof globalThis.fetch;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog({ folders: [], sessions: {}, sessionList: [], boardItems: [documentItem] });
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container?.remove();
    document.body.querySelectorAll("[data-base-ui-portal]").forEach((node) => node.remove());
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it("moves the same board item to another task and removes the source row only after success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/board-items?")) {
        return new Response(JSON.stringify({ boardItems: [documentItem] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/board-items/markdown%3Adoc-1/container" && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          ok: true,
          boardItem: { ...documentItem, containerId: "task-2" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const target = {
      taskId: "task-2",
      page: { id: "page-2", title: "옮길 업무" },
    } as TaskMoveTarget;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(createElement(TaskInlineBoard, {
        taskId: "task-1",
        folderId: "folder-1",
        api: {} as PageApiClient,
        taskMoveTargets: [target],
        activeDocumentId: null,
        onDeletedActiveDocument: vi.fn(),
        onMarkdownDocumentsChanged: vi.fn(),
      }));
    });
    for (let attempt = 0; attempt < 5 && !container.querySelector(".v3-inline-board-row"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync(() => undefined);
    }

    const row = container.querySelector<HTMLElement>(".v3-inline-board-row");
    expect(row?.textContent).toContain("실수로 만든 문서");
    flushSync(() => row!.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 80,
    })));
    const moveAction = Array.from(document.body.querySelectorAll<HTMLElement>("[role='menuitem']"))
      .find((item) => item.textContent?.trim() === "다른 업무로 이동");
    expect(moveAction).not.toBeUndefined();
    flushSync(() => moveAction!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const targetAction = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("옮길 업무"));
    expect(targetAction).not.toBeUndefined();
    flushSync(() => {
      targetAction!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let attempt = 0; attempt < 5 && container.querySelector(".v3-inline-board-row"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync(() => undefined);
    }

    const patchCall = fetchMock.mock.calls.find(([input, init]) => (
      String(input).endsWith("/container") && init?.method === "PATCH"
    ));
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      container: { kind: "task", id: "task-2" },
    });
    expect(container.querySelector(".v3-inline-board-row")).toBeNull();
    expect(useDashboardStore.getState().catalog?.boardItems?.find((item) => item.id === documentItem.id))
      .toMatchObject({ itemId: "doc-1", containerId: "task-2" });
  });

  it("re-fetches inline markdown when the task document revision changes", async () => {
    let storedDocument = {
      id: "doc-1",
      title: "실수로 만든 문서",
      body: "오버레이 저장 전 본문",
      version: 1,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/board-items?")) {
        return new Response(JSON.stringify({ boardItems: [documentItem] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/markdown-documents/doc-1")) {
        return new Response(JSON.stringify(storedDocument), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof globalThis.fetch;
    const boardContainer = document.createElement("div");
    container = boardContainer;
    document.body.appendChild(boardContainer);
    root = createRoot(boardContainer);
    const render = (markdownDocumentsRevision: number) => flushSync(() => {
      root!.render(createElement(TaskInlineBoard, {
        taskId: "task-1",
        folderId: "folder-1",
        api: {} as PageApiClient,
        taskMoveTargets: [],
        activeDocumentId: null,
        onDeletedActiveDocument: vi.fn(),
        onMarkdownDocumentsChanged: vi.fn(),
        markdownDocumentsRevision,
      }));
    });

    render(0);
    for (let attempt = 0; attempt < 10 && !boardContainer.querySelector(".v3-inline-board-row"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      flushSync(() => undefined);
    }
    const expand = boardContainer.querySelector<HTMLButtonElement>(
      '[aria-label="실수로 만든 문서 펼치기"]',
    );
    expect(expand).not.toBeNull();
    flushSync(() => expand!.click());
    await vi.waitFor(() => expect(boardContainer.querySelector(".v3-inline-markdown")?.textContent)
      .toContain("오버레이 저장 전 본문"));

    storedDocument = { ...storedDocument, body: "오버레이 저장 후 본문", version: 2 };
    render(1);
    await vi.waitFor(() => expect(boardContainer.querySelector(".v3-inline-markdown")?.textContent)
      .toContain("오버레이 저장 후 본문"));
  });
});
