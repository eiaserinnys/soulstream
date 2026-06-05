/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { BoardWorkspaceView } from "./BoardWorkspaceView";

const catalog: CatalogState = {
  folders: [
    {
      id: "root",
      name: "Root folder with a very long name that must stay inside the tile",
      sortOrder: 0,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "child-folder",
      name: "Child folder with a very long name that should truncate",
      sortOrder: 1,
      parentFolderId: "root",
      createdAt: "2026-06-03T00:00:00.000Z",
    },
  ],
  sessions: {
    "session-a": { folderId: "root", displayName: null },
  },
  boardItems: [
    {
      id: "subfolder:child-folder",
      folderId: "root",
      itemType: "subfolder",
      itemId: "child-folder",
      x: 40,
      y: 80,
    },
    {
      id: "session:session-a",
      folderId: "root",
      itemType: "session",
      itemId: "session-a",
      x: 200,
      y: 40,
    },
    {
      id: "markdown:doc-a",
      folderId: "root",
      itemType: "markdown",
      itemId: "doc-a",
      x: 360,
      y: 80,
      metadata: {
        title: "Design note",
        preview: "Markdown preview",
      },
    },
  ],
};

const sessions: SessionSummary[] = [
  {
    agentSessionId: "session-a",
    status: "running",
    eventCount: 12,
    agentId: "roselin_codex",
    agentName: "Roselin",
    agentPortraitUrl: "/api/nodes/eias/agents/roselin_codex/portrait",
    prompt: "Session title that should wrap up to three lines inside the tile before it is clamped",
    updatedAt: "2026-06-04T00:00:00.000Z",
    lastMessage: {
      type: "assistant",
      preview: "A long assistant preview that should be clamped to a small number of lines inside the fixed square tile.",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
  },
];

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: IntersectionObserverCallback) {
    MockIntersectionObserver.instances.push(this);
  }

  trigger(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function renderBoard(props: Partial<React.ComponentProps<typeof BoardWorkspaceView>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalog);
  useDashboardStore.getState().selectFolder("root");

  flushSync(() => {
    root.render(createElement(BoardWorkspaceView, { sessions, ...props }));
  });

  return { container, root };
}

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: MouseEventInit = {},
) {
  const PointerCtor = window.PointerEvent ?? window.MouseEvent;
  target.dispatchEvent(new PointerCtor(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  }));
}

describe("BoardWorkspaceView", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalMatchMedia = window.matchMedia;
    MockIntersectionObserver.instances = [];
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
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
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = undefined;
    container = undefined;
    globalThis.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
  });

  it("renders fixed 160px positioned tiles on a 40px dotted canvas", () => {
    ({ container, root } = renderBoard());

    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const folderTile = container.querySelector<HTMLElement>('[data-testid="board-folder-tile"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    const markdownTile = container.querySelector<HTMLElement>('[data-testid="board-markdown-tile"]');

    expect(canvas?.parentElement?.style.backgroundSize).toBe("40px 40px");
    expect(canvas?.style.width).toBe("720px");
    expect(canvas?.style.height).toBe("440px");

    expect(folderTile?.className).toContain("h-40");
    expect(folderTile?.className).toContain("w-40");
    expect(folderTile?.className).toContain("rounded-xl");
    expect(folderTile?.style.left).toBe("40px");
    expect(folderTile?.style.top).toBe("80px");
    expect(sessionTile?.className).toContain("h-40");
    expect(sessionTile?.className).toContain("w-40");
    expect(sessionTile?.className).toContain("rounded-xl");
    expect(sessionTile?.style.left).toBe("200px");
    expect(sessionTile?.style.top).toBe("40px");
    expect(markdownTile?.style.left).toBe("360px");
    expect(markdownTile?.style.top).toBe("80px");
  });

  it("keeps folder names, session titles, markdown previews, and agent profiles bounded inside tiles", () => {
    ({ container, root } = renderBoard());

    expect(container.querySelector('[data-testid="board-folder-title"]')?.className).toContain("truncate");
    expect(container.querySelector('[data-testid="board-session-title"]')?.className).toContain("line-clamp-3");
    expect(container.querySelector('[data-testid="board-session-title"]')?.textContent).toContain(
      "Session title that should wrap",
    );
    expect(container.querySelector('[data-testid="board-session-agent"]')?.textContent).toContain("Roselin");
    expect(container.querySelector<HTMLImageElement>('[data-testid="board-session-agent-avatar"]')?.src).toContain(
      "/api/nodes/eias/agents/roselin_codex/portrait",
    );
    expect(container.querySelector('[data-testid="board-session-preview"]')?.className).toContain("line-clamp-2");
    expect(container.querySelector('[data-testid="board-markdown-title"]')?.className).toContain("line-clamp-2");
    expect(container.querySelector('[data-testid="board-markdown-preview"]')?.textContent).toBe("Markdown preview");
  });

  it("snaps dragged tiles to the 40px grid and persists the board item position", async () => {
    const onUpdateBoardItemPosition = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = renderBoard({ onUpdateBoardItemPosition }));

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointermove", { clientX: 255, clientY: 101 });
      dispatchPointer(window, "pointerup", { clientX: 255, clientY: 101 });
    });
    await Promise.resolve();

    expect(onUpdateBoardItemPosition).toHaveBeenCalledWith("session:session-a", 240, 120);
    expect(sessionTile?.style.left).toBe("240px");
    expect(sessionTile?.style.top).toBe("120px");
  });

  it("creates a markdown document from the New menu at the first open grid slot", async () => {
    const onCreateMarkdownDocument = vi.fn().mockResolvedValue({
      document: {
        id: "doc-new",
        title: "Untitled document",
        body: "",
      },
      boardItem: {
        id: "markdown:doc-new",
        folderId: "root",
        itemType: "markdown",
        itemId: "doc-new",
        x: 0,
        y: 0,
        metadata: {
          title: "Untitled document",
          preview: "",
        },
      },
    });
    ({ container, root } = renderBoard({ onCreateMarkdownDocument }));

    const newButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("New"));
    expect(newButton).not.toBeUndefined();

    flushSync(() => {
      newButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const documentButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("문서"));
    expect(documentButton).not.toBeUndefined();

    flushSync(() => {
      documentButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(onCreateMarkdownDocument).toHaveBeenCalledWith({
      folderId: "root",
      title: "Untitled document",
      body: "",
      x: 0,
      y: 0,
    });
    expect(useDashboardStore.getState().activeBoardDocumentId).toBe("doc-new");
  });

  it("auto-prefetches through a sentinel and suppresses duplicate intersections while pending", async () => {
    let resolveLoad: (() => void) | undefined;
    const onLoadMore = vi.fn(() => new Promise<void>((resolve) => {
      resolveLoad = resolve;
    }));

    ({ container, root } = renderBoard({ hasMore: true, onLoadMore }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const buttonText = Array.from(container.querySelectorAll("button"))
      .map((button) => button.textContent ?? "")
      .join(" ");
    expect(buttonText).not.toContain("Load more");
    expect(container.querySelector('[data-testid="board-load-more-sentinel"]')).not.toBeNull();
    expect(MockIntersectionObserver.instances).toHaveLength(1);

    MockIntersectionObserver.instances[0].trigger(true);
    MockIntersectionObserver.instances[0].trigger(true);

    expect(onLoadMore).toHaveBeenCalledTimes(1);

    resolveLoad?.();
    await Promise.resolve();
    await Promise.resolve();

    MockIntersectionObserver.instances[0].trigger(true);
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it("removes the sentinel and spinner when no more pages exist", () => {
    ({ container, root } = renderBoard({ hasMore: false, onLoadMore: vi.fn() }));

    expect(container.querySelector('[data-testid="board-load-more-sentinel"]')).toBeNull();
    expect(container.querySelector('[data-testid="board-load-more-spinner"]')).toBeNull();
    expect(MockIntersectionObserver.instances).toHaveLength(0);
  });
});
