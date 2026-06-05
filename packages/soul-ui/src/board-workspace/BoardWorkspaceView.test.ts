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

  it("renders fixed 160px square grid tiles for folders and sessions", () => {
    ({ container, root } = renderBoard());

    const grid = container.querySelector('[data-testid="board-workspace-grid"]');
    const folderTile = container.querySelector('[data-testid="board-folder-tile"]');
    const sessionTile = container.querySelector('[data-testid="board-session-tile"]');

    expect(grid?.className).toContain("grid-cols-[repeat(auto-fill,160px)]");
    expect(grid?.className).toContain("auto-rows-[160px]");
    expect(grid?.className).toContain("gap-3");
    expect(grid?.className).toContain("justify-start");

    expect(folderTile?.className).toContain("h-40");
    expect(folderTile?.className).toContain("w-40");
    expect(folderTile?.className).toContain("rounded-xl");
    expect(sessionTile?.className).toContain("h-40");
    expect(sessionTile?.className).toContain("w-40");
    expect(sessionTile?.className).toContain("rounded-xl");
  });

  it("keeps folder names, session titles, agent profile, and previews bounded inside each tile", () => {
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
