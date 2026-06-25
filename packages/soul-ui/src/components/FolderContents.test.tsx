/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import folderContentsSource from "./FolderContents.tsx?raw";
import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { FolderContents } from "./FolderContents";

const virtualizerMockState = vi.hoisted(() => ({
  startIndex: 0,
  visibleCount: Number.POSITIVE_INFINITY,
  calls: [] as Array<{ count: number; estimatedSize: number; scrollMargin: number }>,
}));

const intersectionObserverMockState = vi.hoisted(() => ({
  options: [] as Array<IntersectionObserverInit | undefined>,
  observedTargets: [] as Element[],
  disconnectCount: 0,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    scrollMargin = 0,
  }: {
    count: number;
    estimateSize: () => number;
    scrollMargin?: number;
  }) => {
    const estimatedSize = estimateSize();
    virtualizerMockState.calls.push({ count, estimatedSize, scrollMargin });
    return {
      options: { scrollMargin },
      getVirtualItems: () => {
        const size = estimateSize();
        const startIndex = count === 0 ? 0 : Math.min(virtualizerMockState.startIndex, count - 1);
        const visibleCount = Number.isFinite(virtualizerMockState.visibleCount)
          ? virtualizerMockState.visibleCount
          : count;
        const itemCount = Math.max(0, Math.min(count - startIndex, visibleCount));
        return Array.from({ length: itemCount }, (_, offset) => {
          const index = startIndex + offset;
          return {
            index,
            key: index,
            size,
            start: scrollMargin + index * size,
          };
        });
      },
      getTotalSize: () => count * estimateSize(),
    };
  },
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

function createSessions(count: number): SessionSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    agentSessionId: `session-${index}`,
    status: "running",
    eventCount: index,
    agentId: "roselin_codex",
    agentName: "Roselin",
    folderId: "folder-a",
    prompt: `Session ${index}`,
    updatedAt: "2026-06-10T00:00:00.000Z",
  }));
}

function createCatalogForSessions(sessionList: SessionSummary[]): CatalogState {
  return {
    ...catalog,
    sessions: Object.fromEntries(
      sessionList.map((session) => [
        session.agentSessionId,
        { folderId: "folder-a", displayName: null },
      ]),
    ),
  };
}

class MockIntersectionObserver {
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    void this.callback;
    intersectionObserverMockState.options.push(options);
  }

  observe(target: Element) {
    intersectionObserverMockState.observedTargets.push(target);
  }

  disconnect() {
    intersectionObserverMockState.disconnectCount += 1;
  }
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
  const sessionList = props.sessions ?? sessions;

  useDashboardStore.getState().reset();
  useDashboardStore.getState().setCatalog(createCatalogForSessions(sessionList));
  useDashboardStore.getState().selectFolder("folder-a");

  flushSync(() => {
    root.render(createElement(FolderContents, { sessions: sessionList, ...props }));
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
    virtualizerMockState.startIndex = 0;
    virtualizerMockState.visibleCount = Number.POSITIVE_INFINITY;
    virtualizerMockState.calls = [];
    intersectionObserverMockState.options = [];
    intersectionObserverMockState.observedTargets = [];
    intersectionObserverMockState.disconnectCount = 0;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps WebGL glass registration on session cards, not the whole scroll root", () => {
    expect(folderContentsSource).not.toContain("useGlassSurface(parentRef");
    expect(folderContentsSource).not.toContain("data-liquid-glass-webgl={webglActive");
    expect(folderContentsSource).toContain("<SessionItem");
  });

  it("shows continue-session action from a folder session row context menu", async () => {
    ({ container, root } = renderFolderContents({
      onContinueSession: vi.fn().mockResolvedValue(undefined),
      getContinueSessionDisabledReason: () => null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = container.querySelector<HTMLElement>("[data-testid='draggable-session']");
    expect(row).not.toBeNull();
    expect(row!.className).toContain("liquid-glass-card");
    expect(row!.dataset.liquidGlassEnhanced).toBe("false");

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

  it("virtualizes the desktop session grid so off-screen cards do not mount glass surfaces", async () => {
    const manySessions = createSessions(100);
    const onLoadMore = vi.fn().mockResolvedValue(undefined);
    virtualizerMockState.visibleCount = 3;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(min-width: 1280px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    ({ container, root } = renderFolderContents({
      sessions: manySessions,
      hasMore: true,
      onLoadMore,
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const mountedSessions = container.querySelectorAll("[data-testid='draggable-session']");
    expect(mountedSessions).toHaveLength(6);
    expect(container.querySelectorAll(".liquid-glass-card")).toHaveLength(6);
    expect(container.querySelectorAll("[data-testid='folder-session-virtual-row']")).toHaveLength(3);
    expect(virtualizerMockState.calls.some((call) => call.estimatedSize === 118)).toBe(false);
    expect(virtualizerMockState.calls.some((call) => call.estimatedSize === 148)).toBe(true);
    expect(virtualizerMockState.calls.some((call) => call.scrollMargin === 0)).toBe(true);
    expect(container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-grid']")?.style.height)
      .toBe("7400px");
    const gridInset = container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-grid']")?.parentElement;
    expect(gridInset?.style.paddingInline).toBe("16px");
    expect(gridInset?.style.paddingTop).toBe("16px");
    expect(gridInset?.style.paddingBottom).toBe("16px");
    expect(container.querySelector<HTMLElement>("[data-testid='folder-session-row-grid']")?.style.gap).toBe("16px");
    const cardFrames = container.querySelectorAll<HTMLElement>("[data-testid='folder-session-card-frame']");
    expect(cardFrames).toHaveLength(6);
    cardFrames.forEach((frame) => {
      expect(frame.style.height).toBe("132px");
    });
    const scrollRoot = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-root']");
    expect(intersectionObserverMockState.options).toHaveLength(1);
    expect(intersectionObserverMockState.options[0]?.root).toBe(scrollRoot);
    expect(intersectionObserverMockState.options[0]?.rootMargin).toBe("120px 0px");
    expect(intersectionObserverMockState.options[0]?.threshold).toBe(0.1);
    expect(intersectionObserverMockState.observedTargets).toHaveLength(1);
    expect(intersectionObserverMockState.observedTargets[0].textContent).toBe("Loading...");
    expect(scrollRoot?.contains(intersectionObserverMockState.observedTargets[0])).toBe(true);
    expect(container.textContent).toContain("Session 0");
    expect(container.textContent).toContain("Session 5");
    expect(container.textContent).not.toContain("Session 6");
    expect(container.textContent).not.toContain("Session 99");
  });

  it("uses the scroll header height as virtualizer scrollMargin inside one scroll root", async () => {
    const manySessions = createSessions(12);
    virtualizerMockState.visibleCount = 2;

    ({ container, root } = renderFolderContents({
      sessions: manySessions,
      hasMore: true,
      onLoadMore: vi.fn().mockResolvedValue(undefined),
      scrollHeader: (
        <div data-testid="folder-test-scroll-header">
          하위 폴더
        </div>
      ),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scrollRoot = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-root']");
    const scrollHeader = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-header']");
    const firstRow = container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-row']");

    expect(scrollRoot).not.toBeNull();
    expect(scrollHeader).not.toBeNull();
    expect(scrollRoot?.contains(scrollHeader)).toBe(true);
    expect(scrollRoot?.contains(container.querySelector("[data-testid='folder-session-virtual-grid']"))).toBe(true);
    expect(virtualizerMockState.calls.some((call) => call.scrollMargin === 560)).toBe(true);
    expect(firstRow?.style.transform).toBe("translateY(0px)");
    expect(intersectionObserverMockState.options[0]?.root).toBe(scrollRoot);
    expect(scrollRoot?.contains(intersectionObserverMockState.observedTargets[0])).toBe(true);
  });

  it("applies the same scrollMargin contract to the mobile virtual list", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const manySessions = createSessions(12);
    virtualizerMockState.visibleCount = 2;

    ({ container, root } = renderFolderContents({
      sessions: manySessions,
      hasMore: true,
      onLoadMore: vi.fn().mockResolvedValue(undefined),
      scrollHeader: (
        <div data-testid="folder-test-scroll-header">
          하위 폴더
        </div>
      ),
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const scrollRoot = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-root']");
    const firstItem = container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-item']");

    expect(virtualizerMockState.calls.some((call) => (
      call.estimatedSize === 148 && call.scrollMargin === 560
    ))).toBe(true);
    expect(firstItem?.style.transform).toBe("translateY(0px)");
    expect(intersectionObserverMockState.options[0]?.root).toBe(scrollRoot);
    expect(scrollRoot?.contains(intersectionObserverMockState.observedTargets[0])).toBe(true);
  });
});
