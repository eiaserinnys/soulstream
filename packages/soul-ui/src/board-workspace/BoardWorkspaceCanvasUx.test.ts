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
      name: "Root",
      sortOrder: 0,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "child-folder",
      name: "Child",
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
    agentPortraitUrl: null,
    prompt: "Session title",
    updatedAt: "2026-06-04T00:00:00.000Z",
  },
];

function renderBoard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalog);
  useDashboardStore.getState().selectFolder("root");

  flushSync(() => {
    root.render(createElement(BoardWorkspaceView, { sessions }));
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

describe("BoardWorkspaceView canvas UX", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
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
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  it("raises the most recently selected card above overlapping board cards", () => {
    ({ container, root } = renderBoard());

    const folderTile = container.querySelector<HTMLElement>('[data-testid="board-folder-tile"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(folderTile).not.toBeNull();
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointerup", { clientX: 200, clientY: 40 });
    });
    expect(Number(sessionTile!.style.zIndex)).toBeGreaterThan(Number(folderTile!.style.zIndex || 0));

    flushSync(() => {
      dispatchPointer(folderTile!, "pointerdown", { clientX: 40, clientY: 80 });
      dispatchPointer(window, "pointerup", { clientX: 40, clientY: 80 });
    });
    expect(Number(folderTile!.style.zIndex)).toBeGreaterThan(Number(sessionTile!.style.zIndex));
  });

  it("marquee-selects multiple cards and drags the selected group together", async () => {
    ({ container, root } = renderBoard());

    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const folderTile = container.querySelector<HTMLElement>('[data-testid="board-folder-tile"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    const markdownTile = container.querySelector<HTMLElement>('[data-testid="board-markdown-tile"]');
    expect(canvas).not.toBeNull();
    expect(folderTile).not.toBeNull();
    expect(sessionTile).not.toBeNull();
    expect(markdownTile).not.toBeNull();

    flushSync(() => {
      dispatchPointer(canvas!, "pointerdown", { clientX: 50020, clientY: 50020, shiftKey: true });
      dispatchPointer(window, "pointermove", { clientX: 50580, clientY: 50300, shiftKey: true });
      dispatchPointer(window, "pointerup", { clientX: 50580, clientY: 50300, shiftKey: true });
    });

    expect(folderTile!.className).toContain("ring-2");
    expect(sessionTile!.className).toContain("ring-2");
    expect(markdownTile!.className).toContain("ring-2");

    flushSync(() => {
      dispatchPointer(sessionTile!, "pointerdown", { clientX: 200, clientY: 40 });
      dispatchPointer(window, "pointermove", { clientX: 240, clientY: 80 });
      dispatchPointer(window, "pointerup", { clientX: 240, clientY: 80 });
    });
    await Promise.resolve();

    expect(folderTile!.style.left).toBe("50080px");
    expect(folderTile!.style.top).toBe("50120px");
    expect(sessionTile!.style.left).toBe("50240px");
    expect(sessionTile!.style.top).toBe("50080px");
    expect(markdownTile!.style.left).toBe("50400px");
    expect(markdownTile!.style.top).toBe("50120px");
  });

  it("pans the canvas from the background after a session tile is selected", () => {
    ({ container, root } = renderBoard());

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(scroller).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      sessionTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sessionTile!.className).toContain("ring-2");

    const startScrollLeft = scroller!.scrollLeft;
    const startScrollTop = scroller!.scrollTop;
    flushSync(() => {
      dispatchPointer(canvas!, "pointerdown", { clientX: 340, clientY: 260 });
      dispatchPointer(window, "pointermove", { clientX: 290, clientY: 220 });
      dispatchPointer(window, "pointerup", { clientX: 290, clientY: 220 });
    });

    expect(scroller!.scrollLeft).toBe(startScrollLeft + 50);
    expect(scroller!.scrollTop).toBe(startScrollTop + 40);

    const markdownTile = container.querySelector<HTMLElement>('[data-testid="board-markdown-tile"]');
    expect(markdownTile).not.toBeNull();
    flushSync(() => {
      markdownTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDashboardStore.getState().activeBoardDocumentId).toBe("doc-a");
  });

  it("pans the canvas from the background after a markdown tile is selected", () => {
    ({ container, root } = renderBoard());

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const markdownTile = container.querySelector<HTMLElement>('[data-testid="board-markdown-tile"]');
    expect(scroller).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(markdownTile).not.toBeNull();

    flushSync(() => {
      markdownTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(markdownTile!.className).toContain("ring-2");

    const startScrollLeft = scroller!.scrollLeft;
    const startScrollTop = scroller!.scrollTop;
    flushSync(() => {
      dispatchPointer(canvas!, "pointerdown", { clientX: 420, clientY: 280 });
      dispatchPointer(window, "pointermove", { clientX: 370, clientY: 250 });
      dispatchPointer(window, "pointerup", { clientX: 370, clientY: 250 });
    });

    expect(scroller!.scrollLeft).toBe(startScrollLeft + 50);
    expect(scroller!.scrollTop).toBe(startScrollTop + 30);
  });

  it("clears multi-selection when empty canvas space is clicked", () => {
    ({ container, root } = renderBoard());

    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    expect(canvas).not.toBeNull();
    expect(sessionTile).not.toBeNull();

    flushSync(() => {
      sessionTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(sessionTile!.className).toContain("ring-2");

    flushSync(() => {
      dispatchPointer(canvas!, "pointerdown", { clientX: 49990, clientY: 49990 });
      dispatchPointer(window, "pointerup", { clientX: 49990, clientY: 49990 });
    });
    expect(sessionTile!.className.split(/\s+/)).not.toContain("ring-2");
  });

  it("zooms with modifier wheel, keeps transform rendering, and toggles the minimap", () => {
    ({ container, root } = renderBoard());

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    expect(scroller).not.toBeNull();
    expect(canvas).not.toBeNull();

    vi.spyOn(scroller!, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 500,
      bottom: 300,
      width: 500,
      height: 300,
      toJSON: () => ({}),
    });

    flushSync(() => {
      scroller!.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -100,
        clientX: 100,
        clientY: 100,
      }));
    });

    expect(canvas!.style.transform).toBe("scale(1.1)");
    expect(canvas!.style.willChange).toBe("transform");
    expect(container.querySelector('[data-testid="board-zoom-indicator"]')?.textContent).toBe("110%");

    const zoomOut = container.querySelector<HTMLButtonElement>('[data-testid="board-zoom-out"]');
    const zoomIn = container.querySelector<HTMLButtonElement>('[data-testid="board-zoom-in"]');
    expect(zoomOut).not.toBeNull();
    expect(zoomIn).not.toBeNull();

    flushSync(() => {
      zoomOut!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvas!.style.transform).toBe("scale(1)");
    expect(container.querySelector('[data-testid="board-zoom-indicator"]')?.textContent).toBe("100%");

    flushSync(() => {
      zoomIn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(canvas!.style.transform).toBe("scale(1.1)");
    expect(container.querySelector('[data-testid="board-zoom-indicator"]')?.textContent).toBe("110%");

    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="board-minimap-toggle"]');
    expect(container.querySelector('[data-testid="board-minimap"]')).not.toBeNull();
    flushSync(() => {
      toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="board-minimap"]')).toBeNull();
  });
});
