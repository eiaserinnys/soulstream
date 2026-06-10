/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { FolderContents } from "./FolderContents";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 56,
        start: index * 56,
      })),
    getTotalSize: () => count * 56,
  }),
}));

const catalog: CatalogState = {
  folders: [{
    id: "folder-a",
    name: "Folder A",
    sortOrder: 0,
    parentFolderId: null,
    createdAt: "2026-06-10T00:00:00.000Z",
  }],
  sessions: {
    "session-a": { folderId: "folder-a", displayName: null },
  },
};

const sessions: SessionSummary[] = [{
  agentSessionId: "session-a",
  status: "running",
  eventCount: 1,
  agentId: "roselin_codex",
  agentName: "Roselin",
  folderId: "folder-a",
  prompt: "Visible session",
  updatedAt: "2026-06-10T00:00:00.000Z",
}];

class MockIntersectionObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
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
          bottom: 560,
          width: 320,
          height: 560,
          toJSON: () => ({}),
        },
      } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  unobserve = vi.fn();
  disconnect = vi.fn();
}

function renderFolderContents(props: Partial<React.ComponentProps<typeof FolderContents>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(catalog);
  useDashboardStore.getState().selectFolder("folder-a");

  flushSync(() => {
    root.render(createElement(FolderContents, { sessions, ...props }));
  });

  return { container, root };
}

describe("FolderContents", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalIntersectionObserver: typeof globalThis.IntersectionObserver | undefined;
  let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalResizeObserver = globalThis.ResizeObserver;
    originalMatchMedia = window.matchMedia;
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
  });

  afterEach(() => {
    if (root) {
      flushSync(() => root?.unmount());
    }
    container?.remove();
    document.body.innerHTML = "";
    root = undefined;
    container = undefined;
    globalThis.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    globalThis.ResizeObserver = originalResizeObserver as typeof ResizeObserver;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.restoreAllMocks();
  });

  it("shows continue-session action from a folder session row context menu", async () => {
    ({ container, root } = renderFolderContents({
      onContinueSession: vi.fn().mockResolvedValue(undefined),
      getContinueSessionDisabledReason: () => null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = container.querySelector<HTMLElement>("[data-testid='draggable-session']");
    expect(row).not.toBeNull();

    flushSync(() => {
      row!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 32,
        clientY: 48,
      }));
    });

    expect(document.body.textContent).toContain("이 세션을 이어서 시작하기");
  });
});
