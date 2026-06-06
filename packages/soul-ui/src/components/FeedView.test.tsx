/**
 * @vitest-environment jsdom
 */

import { DndContext } from "@dnd-kit/core";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import { createElement, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionPage } from "../hooks/session-stream-helpers";
import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import { FeedView, type FeedViewProps } from "./FeedView";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: estimateSize(),
        start: index * estimateSize(),
      })),
  }),
}));

function makeSession(
  agentSessionId: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  const now = "2026-06-06T00:00:00Z";
  return {
    agentSessionId,
    status: "running",
    sessionType: "claude",
    createdAt: now,
    updatedAt: now,
    eventCount: 1,
    prompt: agentSessionId,
    ...overrides,
  };
}

function page(sessions: SessionSummary[]): InfiniteData<SessionPage> {
  return {
    pages: [{ sessions, total: sessions.length }],
    pageParams: [0],
  };
}

const catalog: CatalogState = {
  folders: [{ id: "folder-a", name: "Folder A", sortOrder: 0, parentFolderId: null }],
  sessions: {
    "in-folder": { folderId: "folder-a", displayName: null },
  },
};

describe("FeedView sidebar placement", () => {
  const SidebarFeedView = FeedView as ComponentType<FeedViewProps>;
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    useDashboardStore.getState().reset();
    useDashboardStore.getState().setCatalog(catalog);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(
      ["sessions", "all", "feed", null],
      page([makeSession("in-folder"), makeSession("orphan")]),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    vi.unstubAllGlobals();
  });

  function renderFeed() {
    flushSync(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(DndContext, null, createElement(SidebarFeedView, { placement: "sidebar" })),
        ),
      );
    });
  }

  it("does not auto-select the first feed session", async () => {
    renderFeed();
    await Promise.resolve();

    expect(useDashboardStore.getState().activeSessionKey).toBeNull();
  });

  it("selects the session folder and active session when a sidebar feed card is clicked", async () => {
    renderFeed();
    await Promise.resolve();

    const card = container.querySelector<HTMLElement>('[data-session-id="in-folder"]');
    expect(card).not.toBeNull();

    flushSync(() => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const state = useDashboardStore.getState();
    expect(state.viewMode).toBe("folder");
    expect(state.selectedFolderId).toBe("folder-a");
    expect(state.activeSessionKey).toBe("in-folder");
    expect(state.activeSessionSummary?.agentSessionId).toBe("in-folder");
    expect(state.leftNavigationMode).toBe("feed");
  });

  it("keeps the current folder surface when a sidebar feed card has no folder assignment", async () => {
    useDashboardStore.getState().selectFolder("folder-a");
    useDashboardStore.getState().setLeftNavigationMode("feed");
    renderFeed();
    await Promise.resolve();

    const card = container.querySelector<HTMLElement>('[data-session-id="orphan"]');
    expect(card).not.toBeNull();

    flushSync(() => {
      card!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const state = useDashboardStore.getState();
    expect(state.viewMode).toBe("folder");
    expect(state.selectedFolderId).toBe("folder-a");
    expect(state.activeSessionKey).toBe("orphan");
    expect(state.activeSessionSummary?.agentSessionId).toBe("orphan");
    expect(state.leftNavigationMode).toBe("feed");
  });
});
