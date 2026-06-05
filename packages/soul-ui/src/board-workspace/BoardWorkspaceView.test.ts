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

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>("button"))
    .find((button) => button.textContent?.trim() === text);
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
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
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
    vi.restoreAllMocks();
  });

  it("renders fixed 280x160 positioned tiles on a 20px dotted infinite canvas", () => {
    ({ container, root } = renderBoard());

    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const folderTile = container.querySelector<HTMLElement>('[data-testid="board-folder-tile"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    const markdownTile = container.querySelector<HTMLElement>('[data-testid="board-markdown-tile"]');

    expect(canvas?.style.backgroundSize).toBe("20px 20px");
    expect(canvas?.style.width).toBe("20000px");
    expect(canvas?.style.height).toBe("12000px");

    expect(folderTile?.className).toContain("h-[160px]");
    expect(folderTile?.className).toContain("w-[280px]");
    expect(folderTile?.className).toContain("rounded-md");
    expect(folderTile?.style.left).toBe("10040px");
    expect(folderTile?.style.top).toBe("6080px");
    expect(sessionTile?.className).toContain("h-[160px]");
    expect(sessionTile?.className).toContain("w-[280px]");
    expect(sessionTile?.className).toContain("rounded-md");
    expect(sessionTile?.style.left).toBe("10200px");
    expect(sessionTile?.style.top).toBe("6040px");
    expect(markdownTile?.style.left).toBe("10360px");
    expect(markdownTile?.style.top).toBe("6080px");
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

  it("shows a snapped drag ghost and updates the Y-doc board position without HTTP persistence", async () => {
    const onUpdateBoardItemPosition = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = renderBoard({ onUpdateBoardItemPosition }));

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointermove", { clientX: 255, clientY: 101 });
    });

    const ghost = container.querySelector<HTMLElement>('[data-testid="board-drag-ghost"]');
    expect(ghost?.style.left).toBe("10260px");
    expect(ghost?.style.top).toBe("6100px");

    flushSync(() => {
      dispatchPointer(window, "pointerup", { clientX: 255, clientY: 101 });
    });
    await Promise.resolve();

    expect(onUpdateBoardItemPosition).not.toHaveBeenCalled();
    expect(sessionTile?.style.left).toBe("10260px");
    expect(sessionTile?.style.top).toBe("6100px");
  });

  it("does not roll back to a stale server position when the legacy callback rejects", async () => {
    const onUpdateBoardItemPosition = vi.fn().mockRejectedValue(new Error("no"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    ({ container, root } = renderBoard({ onUpdateBoardItemPosition }));

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointermove", { clientX: 255, clientY: 101 });
      dispatchPointer(window, "pointerup", { clientX: 255, clientY: 101 });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onUpdateBoardItemPosition).not.toHaveBeenCalled();
    expect(sessionTile?.style.left).toBe("10260px");
    expect(sessionTile?.style.top).toBe("6100px");
    expect(consoleError).not.toHaveBeenCalledWith("Board item position update failed:", expect.any(Error));
  });

  it("allows negative board coordinates when dragging left and up", async () => {
    const onUpdateBoardItemPosition = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = renderBoard({ onUpdateBoardItemPosition }));

    const folderTile = container.querySelector<HTMLElement>('[data-testid="board-folder-tile"]');
    expect(folderTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(folderTile!, "pointerdown", { clientX: 40, clientY: 80 });
      dispatchPointer(window, "pointermove", { clientX: -82, clientY: -116 });
      dispatchPointer(window, "pointerup", { clientX: -82, clientY: -116 });
    });
    await Promise.resolve();

    expect(onUpdateBoardItemPosition).not.toHaveBeenCalled();
    expect(folderTile?.style.left).toBe("9920px");
    expect(folderTile?.style.top).toBe("5880px");
  });

  it("auto-pans the canvas while dragging near the viewport edge", () => {
    ({ container, root } = renderBoard());

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(scroller).not.toBeNull();
    expect(sessionTile).not.toBeNull();
    vi.spyOn(scroller!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 300,
      bottom: 200,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    });
    const startScrollLeft = scroller!.scrollLeft;

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointermove", { clientX: 290, clientY: 100 });
    });

    expect(scroller!.scrollLeft).toBe(startScrollLeft + 24);
  });

  it("creates a markdown document from the New menu at the first open grid slot", async () => {
    const onCreateMarkdownDocument = vi.fn();
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

    expect(onCreateMarkdownDocument).not.toHaveBeenCalled();
    const activeDocumentId = useDashboardStore.getState().activeBoardDocumentId;
    expect(activeDocumentId).toBeTruthy();
    expect(useDashboardStore.getState().catalog?.boardItems?.some((item) =>
      item.id === `markdown:${activeDocumentId}` &&
      item.folderId === "root" &&
      item.x === 0 &&
      item.y === 0
    )).toBe(true);
  });

  it("opens the desktop context menu with folder, session, and markdown actions at a snapped board point", async () => {
    ({ container, root } = renderBoard());

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]')?.parentElement;
    expect(scroller).not.toBeNull();

    flushSync(() => {
      scroller!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 10023,
        clientY: 6041,
      }));
    });

    const menuText = container.textContent ?? "";
    expect(menuText).toContain("폴더 추가");
    expect(menuText).toContain("새 세션 시작");
    expect(menuText).toContain("새 문서");

    const sessionButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("새 세션 시작"));
    expect(sessionButton).not.toBeUndefined();

    flushSync(() => {
      sessionButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().isNewSessionModalOpen).toBe(true);
    expect(useDashboardStore.getState().newSessionDefaults).toEqual({
      folderId: "root",
      boardPosition: { x: 20, y: 40 },
    });
  });

  it("marks the selected board card with a visible ring", () => {
    ({ container, root } = renderBoard());

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      sessionTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(sessionTile?.className).toContain("ring-2");
    expect(sessionTile?.className).toContain("ring-primary");
  });

  it("opens a session card context menu with delete action", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const onDeleteSessions = vi.fn().mockResolvedValue(undefined);
    ({ container, root } = renderBoard({ onDeleteSessions }));

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      sessionTile!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 120,
        clientY: 80,
      }));
    });
    await Promise.resolve();

    const deleteAction = findButtonByText(document.body, "삭제");
    expect(deleteAction).not.toBeUndefined();
    flushSync(() => {
      deleteAction!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    const confirmDelete = findButtonByText(document.body, "삭제");
    expect(confirmDelete).not.toBeUndefined();
    flushSync(() => {
      confirmDelete!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await Promise.resolve();

    expect(onDeleteSessions).toHaveBeenCalledWith(["session-a"]);
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
