/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { BoardWorkspaceView, resolveEffectiveBoardCatalog } from "./BoardWorkspaceView";
import { FolderWorkspaceView } from "./FolderWorkspaceView";
import { writeFolderWorkspaceViewMode } from "./folder-workspace-view-mode";

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
    prompt: "Session title that should wrap up to two lines inside the tile before it is clamped",
    updatedAt: "2026-06-04T00:00:00.000Z",
    lastMessage: {
      type: "assistant",
      preview: "A long assistant preview that should be clamped to a small number of lines inside the fixed square tile.",
      timestamp: "2026-06-04T00:00:00.000Z",
    },
  },
];

const relationSessions: SessionSummary[] = [
  {
    agentSessionId: "parent",
    status: "running",
    eventCount: 1,
    agentId: "roselin_codex",
    agentName: "Roselin",
    prompt: "Parent",
    updatedAt: "2026-06-04T00:00:00.000Z",
  },
  {
    agentSessionId: "same-child",
    status: "running",
    eventCount: 2,
    agentId: "shay",
    agentName: "Shay",
    callerSessionId: "parent",
    prompt: "Implement the same-folder child card summary\nwith extra detail",
    lastMessage: {
      type: "assistant",
      preview: "Currently editing the child portal component\nsecond line ignored",
      timestamp: "2026-06-04T01:30:00.000Z",
    },
    updatedAt: "2026-06-04T01:00:00.000Z",
  },
  {
    agentSessionId: "cross-child",
    status: "completed",
    eventCount: 3,
    agentId: "kiki",
    agentName: "Kiki",
    callerSessionId: "parent",
    prompt: "Review cross-folder delegated work",
    lastMessage: {
      type: "assistant",
      preview: "Waiting for the target folder check",
      timestamp: "2026-06-04T02:30:00.000Z",
    },
    updatedAt: "2026-06-04T02:00:00.000Z",
  },
];

const relationCatalog: CatalogState = {
  folders: [
    {
      id: "root",
      name: "Root",
      sortOrder: 0,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "other",
      name: "Other",
      sortOrder: 1,
      parentFolderId: null,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  sessions: {
    parent: { folderId: "root", displayName: null },
    "same-child": { folderId: "root", displayName: null },
    "cross-child": { folderId: "other", displayName: null },
  },
  sessionList: relationSessions,
  boardItems: [
    {
      id: "session:parent",
      folderId: "root",
      itemType: "session",
      itemId: "parent",
      x: 120,
      y: 80,
    },
    {
      id: "session:same-child",
      folderId: "root",
      itemType: "session",
      itemId: "same-child",
      x: 440,
      y: 80,
    },
    {
      id: "session:cross-child",
      folderId: "other",
      itemType: "session",
      itemId: "cross-child",
      x: 160,
      y: 120,
    },
  ],
};

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

function renderBoard(
  props: Partial<React.ComponentProps<typeof BoardWorkspaceView>> = {},
  options: { catalog?: CatalogState; sessions?: SessionSummary[] } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(options.catalog ?? catalog);
  useDashboardStore.getState().selectFolder("root");

  flushSync(() => {
    root.render(createElement(BoardWorkspaceView, { sessions: options.sessions ?? sessions, ...props }));
  });

  return { container, root };
}

function renderFolderWorkspace(
  props: Partial<React.ComponentProps<typeof FolderWorkspaceView>> = {},
  options: { catalog?: CatalogState; sessions?: SessionSummary[] } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(options.catalog ?? catalog);
  useDashboardStore.getState().selectFolder("root");
  writeFolderWorkspaceViewMode(window.localStorage, "root", "board");

  flushSync(() => {
    root.render(createElement(FolderWorkspaceView, { sessions: options.sessions ?? sessions, ...props }));
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

function dispatchFileDragEvent(
  target: EventTarget,
  type: "dragover" | "drop",
  files: File[],
  init: MouseEventInit = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"] },
  });
  flushSync(() => {
    target.dispatchEvent(event);
  });
  return event;
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
    window.localStorage.clear();
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

  it("keeps catalog board items before the Yjs document has synced", () => {
    const result = resolveEffectiveBoardCatalog({
      catalog,
      yjsBoardItemsForSelectedFolder: [],
      isYjsLoading: false,
      hasYjsSynced: false,
      assetSignedUrls: {},
    });

    expect(result).toBe(catalog);
    expect(result?.boardItems).toHaveLength(3);
  });

  it("uses Yjs board items after the document has synced", () => {
    const yjsBoardItems = [{
      id: "session:session-a",
      folderId: "root",
      itemType: "session" as const,
      itemId: "session-a",
      x: 999,
      y: 888,
    }];

    const result = resolveEffectiveBoardCatalog({
      catalog,
      yjsBoardItemsForSelectedFolder: yjsBoardItems,
      isYjsLoading: false,
      hasYjsSynced: true,
      assetSignedUrls: {},
    });

    expect(result).not.toBe(catalog);
    expect(result?.boardItems).toEqual(yjsBoardItems);
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

  it("shows board sync status when websocket connection is unavailable", () => {
    ({ container, root } = renderBoard());

    const status = container.querySelector<HTMLElement>('[data-testid="board-sync-status"]');

    expect(status?.textContent).toContain("연결 끊김");
    expect(status?.title).toContain("websocket is unavailable");
  });

  it("keeps folder names, session titles, markdown previews, and agent profiles bounded inside tiles", () => {
    ({ container, root } = renderBoard());

    expect(container.querySelector('[data-testid="board-folder-title"]')?.className).toContain("truncate");
    expect(container.querySelector('[data-testid="board-session-title"]')?.className).toContain("line-clamp-2");
    expect(container.querySelector('[data-testid="board-session-title"]')?.textContent).toContain(
      "Session title that should wrap",
    );
    expect(container.querySelector('[data-testid="board-session-agent"]')?.textContent).toContain("Roselin");
    expect(container.querySelector<HTMLImageElement>('[data-testid="board-session-agent-avatar"]')?.src).toContain(
      "/api/nodes/eias/agents/roselin_codex/portrait",
    );
    expect(container.querySelector('[data-testid="board-session-agent-avatar"]')?.className).toContain("h-5 w-5");
    expect(container.querySelector('[data-testid="board-session-preview"]')?.className).toContain("line-clamp-3");
    expect(container.querySelector('[data-testid="board-markdown-title"]')?.className).toContain("line-clamp-2");
    expect(container.querySelector('[data-testid="board-markdown-preview"]')?.textContent).toBe("Markdown preview");
  });

  it("keeps the fallback agent avatar aligned with the enlarged board session avatar size", () => {
    ({ container, root } = renderBoard({}, {
      sessions: [
        {
          ...sessions[0],
          agentPortraitUrl: undefined,
        },
      ],
    }));

    const fallbackAvatar = container.querySelector<HTMLElement>('[data-testid="board-session-agent-avatar"]');

    expect(fallbackAvatar?.tagName).toBe("SPAN");
    expect(fallbackAvatar?.className).toContain("h-5 w-5");
  });

  it("renders a running session tile with the shared feed card glow instead of a status dot pulse", () => {
    ({ container, root } = renderBoard());

    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    const title = container.querySelector<HTMLElement>('[data-testid="board-session-title"]');
    const tileClasses = sessionTile?.className.split(/\s+/) ?? [];

    expect(tileClasses).toContain("card-running-base");
    expect(tileClasses).toContain("card-running");
    expect(tileClasses).toContain("border-transparent");
    expect(sessionTile?.className).not.toContain("animate-pulse");
    expect(sessionTile?.className).not.toContain("animate-[pulse_");
    expect(container.querySelector('[data-testid="board-session-status-dot"]')).toBeNull();
    expect(title?.className.split(/\s+/)).not.toContain("pr-4");
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

  it("creates a markdown document from the New menu at an open viewport slot", async () => {
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
      item.x === 300 &&
      item.y === 240
    )).toBe(true);
  });

  it("uploads dropped files and replaces the placeholder with an asset card", async () => {
    const onUploadBoardAsset = vi.fn(async (input) => {
      input.onProgress?.(50);
      return {
        asset: { id: "asset-1" },
        boardItem: {
          id: "asset:asset-1",
          folderId: input.folderId,
          itemType: "asset" as const,
          itemId: "asset-1",
          x: input.x,
          y: input.y,
          metadata: {
            assetId: "asset-1",
            storageKey: "folders/root/assets/asset-1/report.pdf",
            originalName: input.file.name,
            mimeType: input.file.type,
            byteSize: input.file.size,
            signedUrl: "https://r2.example/report.pdf",
          },
        },
      };
    });
    ({ container, root } = renderBoard({ onUploadBoardAsset }));

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    expect(scroller).not.toBeNull();
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });
    const dragover = dispatchFileDragEvent(scroller!, "dragover", [file], {
      clientX: 12000,
      clientY: 8000,
    });
    const drop = dispatchFileDragEvent(scroller!, "drop", [file], {
      clientX: 12000,
      clientY: 8000,
    });

    expect(dragover.defaultPrevented).toBe(true);
    expect(drop.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUploadBoardAsset).toHaveBeenCalledTimes(1);
    expect(onUploadBoardAsset.mock.calls[0]?.[0]).toMatchObject({
      folderId: "root",
      file,
      x: 2000,
      y: 2000,
    });
    expect(container.querySelector('[data-testid="board-asset-title"]')?.textContent).toBe("report.pdf");
    expect(useDashboardStore.getState().catalog?.boardItems?.some((item) =>
      item.id === "asset:asset-1" &&
      item.itemType === "asset" &&
      item.metadata?.signedUrl === "https://r2.example/report.pdf"
    )).toBe(true);
  });

  it("prevents native file dragover on board descendants and keeps a single scroll drop target", () => {
    ({ container, root } = renderBoard({}, {
      catalog: relationCatalog,
      sessions: relationSessions,
    }));

    const scrollers = container.querySelectorAll<HTMLElement>('[data-testid="board-workspace-scroll"]');
    expect(scrollers).toHaveLength(1);
    const scroller = scrollers[0];
    const sessionTile = container.querySelector<HTMLElement>('[data-testid="board-session-tile"]');
    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    expect(sessionTile).not.toBeNull();
    expect(stackBadge).not.toBeNull();
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });

    expect(dispatchFileDragEvent(scroller, "dragover", [file]).defaultPrevented).toBe(true);
    expect(dispatchFileDragEvent(sessionTile!, "dragover", [file]).defaultPrevented).toBe(true);

    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const childCard = container.querySelector<HTMLElement>('[data-testid="board-child-portal-card"]');
    expect(childCard).not.toBeNull();
    expect(dispatchFileDragEvent(childCard!, "dragover", [file]).defaultPrevented).toBe(true);
  });

  it("routes child portal file drops to the current board upload handler", async () => {
    const onUploadBoardAsset = vi.fn(async (input) => ({
      asset: { id: "asset-child" },
      boardItem: {
        id: "asset:asset-child",
        folderId: input.folderId,
        itemType: "asset" as const,
        itemId: "asset-child",
        x: input.x,
        y: input.y,
        metadata: {
          assetId: "asset-child",
          storageKey: "folders/root/assets/asset-child/report.pdf",
          originalName: input.file.name,
          mimeType: input.file.type,
          byteSize: input.file.size,
          signedUrl: "https://r2.example/report.pdf",
        },
      },
    }));
    ({ container, root } = renderBoard({ onUploadBoardAsset }, {
      catalog: relationCatalog,
      sessions: relationSessions,
    }));

    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const childCard = container.querySelector<HTMLElement>('[data-testid="board-child-portal-card"]');
    expect(childCard).not.toBeNull();
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });

    expect(dispatchFileDragEvent(childCard!, "dragover", [file], {
      clientX: 12000,
      clientY: 8000,
    }).defaultPrevented).toBe(true);
    dispatchFileDragEvent(childCard!, "drop", [file], {
      clientX: 12000,
      clientY: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUploadBoardAsset).toHaveBeenCalledTimes(1);
    expect(onUploadBoardAsset.mock.calls[0]?.[0]).toMatchObject({
      folderId: "root",
      file,
      x: 2000,
      y: 2000,
    });
  });

  it("forwards board asset uploads through FolderWorkspaceView board mode", async () => {
    const onUploadBoardAsset = vi.fn(async (input) => ({
      asset: { id: "asset-folder-workspace" },
      boardItem: {
        id: "asset:asset-folder-workspace",
        folderId: input.folderId,
        itemType: "asset" as const,
        itemId: "asset-folder-workspace",
        x: input.x,
        y: input.y,
        metadata: {
          assetId: "asset-folder-workspace",
          storageKey: "folders/root/assets/asset-folder-workspace/report.pdf",
          originalName: input.file.name,
          mimeType: input.file.type,
          byteSize: input.file.size,
          signedUrl: "https://r2.example/report.pdf",
        },
      },
    }));
    ({ container, root } = renderFolderWorkspace({ onUploadBoardAsset }));

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    expect(scroller).not.toBeNull();
    const file = new File(["hello"], "report.pdf", { type: "application/pdf" });

    dispatchFileDragEvent(scroller!, "drop", [file], {
      clientX: 12000,
      clientY: 8000,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onUploadBoardAsset).toHaveBeenCalledTimes(1);
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
    const canvas = container.querySelector<HTMLElement>('[data-testid="board-workspace-canvas"]');
    expect(sessionTile).not.toBeNull();
    expect(canvas).not.toBeNull();

    flushSync(() => {
      sessionTile!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(sessionTile?.className).toContain("ring-2");
    expect(sessionTile?.className).toContain("ring-primary");
    expect(sessionTile?.className).toContain("bg-card");
    expect(sessionTile?.className).not.toContain("hover:bg-accent/50");
    expect(sessionTile?.className.split(/\s+/)).not.toContain("bg-accent");
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-a");
    expect(Array.from(useDashboardStore.getState().selectedSessionIds)).toEqual(["session-a"]);
  });

  it("renders direct child sessions as a parent stack portal and cross-folder refs", async () => {
    ({ container, root } = renderBoard({}, {
      catalog: relationCatalog,
      sessions: relationSessions,
    }));

    const sessionTiles = container.querySelectorAll<HTMLElement>('[data-testid="board-session-tile"]');
    expect(Array.from(sessionTiles).map((tile) => tile.dataset.sessionId)).toEqual(["parent"]);

    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    const stackBadgeClasses = stackBadge?.className.split(/\s+/) ?? [];
    expect(stackBadge?.textContent).toContain("2");
    expect(stackBadgeClasses).toContain("card-running-base");
    expect(stackBadgeClasses).toContain("card-running");
    expect(stackBadgeClasses).toContain("overflow-hidden");
    expect(container.querySelector('[data-testid="board-session-stack-shadow"]')).toBeNull();
    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="board-child-portal"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="board-child-portal-card"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="board-child-ref-card"]')).toHaveLength(1);
    const childCard = container.querySelector<HTMLElement>('[data-testid="board-child-portal-card"]');
    expect(childCard?.className).toContain("w-[280px]");
    expect(childCard?.className).toContain("animate-[pulse_1.5s_ease-in-out_infinite]");
    expect(childCard?.querySelector('[data-testid="board-child-first-message"]')?.textContent)
      .toBe("Implement the same-folder child card summary");
    expect(childCard?.querySelector('[data-testid="board-child-last-message"]')?.textContent)
      .toBe("Currently editing the child portal component");
    flushSync(() => {
      childCard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useDashboardStore.getState().activeSessionKey).toBe("same-child");
    expect(Array.from(useDashboardStore.getState().selectedSessionIds)).toEqual(["same-child"]);

    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const refCard = container.querySelector<HTMLElement>('[data-testid="board-child-ref-card"]');
    flushSync(() => {
      refCard!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().selectedFolderId).toBe("other");
    expect(useDashboardStore.getState().activeSessionKey).toBe("cross-child");
    expect(Array.from(useDashboardStore.getState().selectedSessionIds)).toEqual(["cross-child"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const crossChildTile = container.querySelector<HTMLElement>('[data-session-id="cross-child"]');
    expect(crossChildTile?.className).toContain("animate-pulse");
    expect(container.querySelector('[data-testid="board-session-parent-ref-badge"]')?.textContent).toContain("Root");

    const backRef = container.querySelector<HTMLElement>('[data-testid="board-session-parent-ref-badge"]');
    flushSync(() => {
      backRef!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().selectedFolderId).toBe("root");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const parentTile = container.querySelector<HTMLElement>('[data-session-id="parent"]');
    const parentClasses = parentTile?.className.split(/\s+/) ?? [];
    expect(parentClasses).toContain("card-running-base");
    expect(parentClasses).toContain("card-running");
    expect(parentTile?.className).not.toContain("animate-pulse");
    expect(parentTile?.className).not.toContain("animate-[pulse_1.5s_ease-in-out_infinite]");
  });

  it("keeps child-running glow on the stack button without glowing the parent tile", () => {
    const childOnlyRunningSessions = relationSessions.map((session) =>
      session.agentSessionId === "parent" ? { ...session, status: "completed" as const } : session,
    );
    ({ container, root } = renderBoard({}, {
      catalog: { ...relationCatalog, sessionList: childOnlyRunningSessions },
      sessions: childOnlyRunningSessions,
    }));

    const parentTile = container.querySelector<HTMLElement>('[data-session-id="parent"]');
    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    const stackBadgeClasses = stackBadge?.className.split(/\s+/) ?? [];

    expect(parentTile?.className).not.toContain("card-running-base");
    expect(parentTile?.className).not.toContain("ring-success");
    expect(parentTile?.className).not.toContain("animate-[pulse_1.5s_ease-in-out_infinite]");
    expect(stackBadgeClasses).toContain("card-running-base");
    expect(stackBadgeClasses).toContain("card-running");
    expect(stackBadgeClasses).toContain("border-success");
    expect(stackBadgeClasses).toContain("text-success");
  });

  it("shows both the parent running glow and stack button glow when parent and child are running", () => {
    ({ container, root } = renderBoard({}, {
      catalog: relationCatalog,
      sessions: relationSessions,
    }));

    const parentTile = container.querySelector<HTMLElement>('[data-session-id="parent"]');
    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    const parentClasses = parentTile?.className.split(/\s+/) ?? [];
    const stackBadgeClasses = stackBadge?.className.split(/\s+/) ?? [];

    expect(parentClasses).toContain("card-running-base");
    expect(parentClasses).toContain("card-running");
    expect(parentTile?.className).not.toContain("animate-pulse");
    expect(stackBadgeClasses).toContain("card-running-base");
    expect(stackBadgeClasses).toContain("card-running");
  });

  it("renders child stack errors with red rings instead of running pulse", () => {
    const errorSessions = relationSessions.map((session) =>
      session.agentSessionId === "cross-child" ? { ...session, status: "error" as const } : session,
    );
    ({ container, root } = renderBoard({}, {
      catalog: { ...relationCatalog, sessionList: errorSessions },
      sessions: errorSessions,
    }));

    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    expect(stackBadge?.className).toContain("ring-accent-red");
    expect(stackBadge?.className).not.toContain("animate-[pulse_1.5s_ease-in-out_infinite]");

    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(stackBadge?.className).toContain("ring-accent-red");

    const refCard = container.querySelector<HTMLElement>('[data-testid="board-child-ref-card"]');
    expect(refCard?.className).toContain("ring-accent-red");
    expect(container.querySelector('[data-testid="board-child-last-message"]')?.className).toContain("text-accent-red");
  });

  it("folds the child portal with Escape and empty canvas clicks", () => {
    ({ container, root } = renderBoard({}, {
      catalog: relationCatalog,
      sessions: relationSessions,
    }));

    const stackBadge = container.querySelector<HTMLElement>('[data-testid="board-session-child-stack-badge"]');
    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="board-child-portal"]')).not.toBeNull();

    flushSync(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[data-testid="board-child-portal"]')).toBeNull();

    flushSync(() => {
      stackBadge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="board-child-portal"]')).not.toBeNull();

    const scroller = container.querySelector<HTMLElement>('[data-testid="board-workspace-scroll"]');
    flushSync(() => {
      scroller!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="board-child-portal"]')).toBeNull();
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
