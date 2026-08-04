/**
 * @vitest-environment jsdom
 */

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  updateMarkdownDocument,
  type CatalogBoardItem,
  type SessionSummary,
} from "@seosoyoung/soul-ui";

import { TaskBoardResourcePane } from "./TaskBoardResourcePane";
import type { RunSessionLoadState } from "./task-workspace-model";

async function waitForContent(container: ParentNode, selector: string, content: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (container.querySelector(selector)?.textContent?.includes(content)) return;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${selector} to contain ${content}`);
}

describe("TaskBoardResourcePane 세션 탭 우클릭 (🔴30)", () => {
  let container: HTMLDivElement;
  let root: Root;

  const session: SessionSummary = {
    agentSessionId: "s1",
    status: "completed",
    eventCount: 3,
    displayName: "보드 세션",
    agentId: "roselin_codex",
    agentName: "로젤린",
    nodeId: "eiaserinnys",
    createdAt: "2026-07-24T00:00:00Z",
  } as SessionSummary;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  });

  function render(onSessionContextMenu: (session: SessionSummary, event: unknown) => void) {
    flushSync(() => root.render(
      <TaskBoardResourcePane
        taskId="rb-1"
        taskTitle="보드뷰 개선"
        sessionIds={["s1"]}
        sessions={[session]}
        runSessionLoadStates={new Map<string, RunSessionLoadState>([["s1", "ready"]])}
        runHistoryTotal={1}
        runHistoryHasMore={false}
        runHistoryLoading={false}
        activeSessionId={null}
        boardItems={[]}
        openedResources={[]}
        activeTabId="sessions"
        onOpenSession={vi.fn()}
        onLoadMoreRuns={vi.fn(async () => undefined)}
        onOpenDocument={vi.fn()}
        onActiveTabChange={vi.fn()}
        onSessionContextMenu={onSessionContextMenu}
      />,
    ));
  }

  it("세션 행에서 contextmenu 이벤트가 나면 공통 메뉴 콜백을 세션·좌표와 함께 호출한다", () => {
    let capturedSessionId: string | null = null;
    let capturedClientX: number | null = null;
    // 콜백(=TaskBoardWorkspace.openSessionContextMenu)이 preventDefault로 브라우저 기본 메뉴를 막을 수 있도록,
    // 행이 취소 가능한 실제 이벤트를 그대로 전달하는지 확인한다.
    const onSessionContextMenu = vi.fn((session: SessionSummary, event: { preventDefault(): void; clientX: number }) => {
      capturedSessionId = session.agentSessionId;
      capturedClientX = event.clientX;
      event.preventDefault();
    });
    render(onSessionContextMenu as never);

    const row = container.querySelector<HTMLElement>('.v3-run-row[data-session-id="s1"]');
    expect(row).not.toBeNull();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 48 });
    flushSync(() => { row?.dispatchEvent(event); });

    expect(onSessionContextMenu).toHaveBeenCalledTimes(1);
    expect(capturedSessionId).toBe("s1");
    expect(capturedClientX).toBe(120);
    // 전달된 이벤트로 preventDefault가 실제 DOM 이벤트에 반영된다(취소 가능한 실 이벤트 forwarding).
    expect(event.defaultPrevented).toBe(true);
  });

  it("위임 세션을 기본 펼침으로 보여주고 다음 페이지에 도달할 수 있다", () => {
    const delegated: SessionSummary = {
      ...session,
      agentSessionId: "s-child",
      displayName: "위임 세션",
      callerSessionId: "s1",
      createdAt: "2026-07-24T00:01:00Z",
    };
    const onLoadMoreRuns = vi.fn(async () => undefined);
    flushSync(() => root.render(
      <TaskBoardResourcePane
        taskId="rb-1"
        taskTitle="보드뷰 개선"
        sessionIds={["s1", "s-child"]}
        sessions={[session, delegated]}
        runSessionLoadStates={new Map<string, RunSessionLoadState>([
          ["s1", "ready"],
          ["s-child", "ready"],
        ])}
        runHistoryTotal={38}
        runHistoryHasMore
        runHistoryLoading={false}
        activeSessionId={null}
        boardItems={[]}
        openedResources={[]}
        activeTabId="sessions"
        onOpenSession={vi.fn()}
        onOpenDocument={vi.fn()}
        onActiveTabChange={vi.fn()}
        onLoadMoreRuns={onLoadMoreRuns}
      />,
    ));

    expect(container.querySelector('[data-session-id="s-child"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="1개 위임 세션 접기"]')
      ?.getAttribute("aria-expanded")).toBe("true");
    const loadMore = container.querySelector<HTMLButtonElement>('[data-testid="v3-task-board-load-more-runs"]');
    expect(loadMore).not.toBeNull();
    flushSync(() => loadMore?.click());
    expect(onLoadMoreRuns).toHaveBeenCalledTimes(1);
  });
});

describe("TaskBoardResourcePane 마크다운 동기화", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;
  let storedDocument: { id: string; title: string; body: string; version: number };

  const markdownItem: CatalogBoardItem = {
    id: "markdown:doc-a",
    folderId: "folder-a",
    containerKind: "task",
    containerId: "rb-1",
    itemType: "markdown",
    itemId: "doc-a",
    x: 0,
    y: 0,
    metadata: { title: "결정 로그", version: 1 },
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    storedDocument = {
      id: "doc-a",
      title: "결정 로그",
      body: "저장 전 본문",
      version: 1,
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.endsWith("/api/markdown-documents/doc-a")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { title: string; body?: string };
        storedDocument = {
          ...storedDocument,
          title: body.title,
          body: body.body ?? storedDocument.body,
          version: storedDocument.version + 1,
        };
      }
      return new Response(JSON.stringify(storedDocument), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    document.body.replaceChildren();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("다른 표면의 저장 성공 문서를 재조회 없이 즉시 반영한다", async () => {
    flushSync(() => root.render(
      <TaskBoardResourcePane
        taskId="rb-1"
        taskTitle="보드뷰 개선"
        sessionIds={[]}
        sessions={[]}
        runSessionLoadStates={new Map()}
        runHistoryTotal={0}
        runHistoryHasMore={false}
        runHistoryLoading={false}
        activeSessionId={null}
        boardItems={[markdownItem]}
        openedResources={[{ kind: "document", resourceId: "doc-a" }]}
        activeTabId="document:doc-a"
        onOpenSession={vi.fn()}
        onLoadMoreRuns={vi.fn(async () => undefined)}
        onOpenDocument={vi.fn()}
        onActiveTabChange={vi.fn()}
      />,
    ));
    await waitForContent(container, ".v3-task-board-document-copy", "저장 전 본문");

    await updateMarkdownDocument({
      documentId: "doc-a",
      title: "결정 로그",
      body: "중앙 편집기에서 저장한 본문",
      expectedVersion: 1,
    });

    await waitForContent(container, ".v3-task-board-document-copy", "중앙 편집기에서 저장한 본문");
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
