/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { FolderWorkspaceView } from "./FolderWorkspaceView";
import { writeFolderWorkspaceViewMode } from "./folder-workspace-view-mode";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    scrollMargin = 0,
  }: {
    count: number;
    estimateSize: () => number;
    scrollMargin?: number;
  }) => ({
    options: { scrollMargin },
    getVirtualItems: () => Array.from({ length: Math.min(count, 2) }, (_, index) => ({
      index,
      key: index,
      size: estimateSize(),
      start: scrollMargin + index * estimateSize(),
    })),
    getTotalSize: () => count * estimateSize(),
  }),
}));

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
      id: "child-a",
      name: "Child A",
      sortOrder: 1,
      parentFolderId: "root",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    {
      id: "child-b",
      name: "Child B",
      sortOrder: 2,
      parentFolderId: "root",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  sessions: {
    "session-a": { folderId: "root", displayName: null },
    "session-b": { folderId: "root", displayName: null },
  },
};

const sessions: SessionSummary[] = [
  {
    agentSessionId: "session-a",
    status: "running",
    eventCount: 1,
    agentId: "roselin_codex",
    agentName: "Roselin",
    folderId: "root",
    prompt: "Session A",
    updatedAt: "2026-06-10T00:00:00.000Z",
  },
  {
    agentSessionId: "session-b",
    status: "completed",
    eventCount: 2,
    agentId: "seosoyoung",
    agentName: "Seosoyoung",
    folderId: "root",
    prompt: "Session B",
    updatedAt: "2026-06-10T00:00:00.000Z",
  },
];

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
}

class MockResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{
        target,
        contentRect: {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 320,
          bottom: 240,
          width: 320,
          height: 240,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect = vi.fn();
}

function renderFolderWorkspace() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalog);
  useDashboardStore.getState().selectFolder("root");
  writeFolderWorkspaceViewMode(window.localStorage, "root", "list");

  flushSync(() => {
    root.render(createElement(FolderWorkspaceView, { sessions }));
  });

  return { container, root };
}

describe("FolderWorkspaceView list mode", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalResizeObserver = globalThis.ResizeObserver;
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
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
      flushSync(() => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
    document.body.innerHTML = "";
    globalThis.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  it("keeps child folders and virtualized sessions inside one scroll root", () => {
    ({ container, root } = renderFolderWorkspace());

    const scrollRoot = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-root']");
    const childFolder = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Child A"));
    const virtualGrid = container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-grid']");

    expect(scrollRoot).not.toBeNull();
    expect(childFolder).not.toBeNull();
    expect(virtualGrid).not.toBeNull();
    expect(scrollRoot?.contains(childFolder ?? null)).toBe(true);
    expect(scrollRoot?.contains(virtualGrid)).toBe(true);
    expect(scrollRoot?.textContent).toContain("하위 폴더");
    expect(scrollRoot?.textContent).toContain("세션");
    expect(scrollRoot?.textContent).toContain("Session A");
  });
});
