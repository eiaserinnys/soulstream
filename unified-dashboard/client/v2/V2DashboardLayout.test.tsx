/**
 * @vitest-environment jsdom
 */

import * as React from "react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageApiClient, PageDto, PageYjsClient } from "@seosoyoung/soul-ui/page";

const sessionListProviderSpy = vi.hoisted(() => vi.fn());

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    AskQuestionBanner: () => createElement("div", { "data-testid": "ask-question" }),
    ChatView: () => createElement("div", { "data-testid": "existing-chat-view" }),
    ConnectionBadge: () => createElement("div", { "data-testid": "connection-badge" }),
    RightPanel: () => createElement("div", { "data-testid": "existing-right-panel" }),
    ThemeToggle: () => createElement("button", null, "Theme"),
    initTheme: vi.fn(),
    useAuth: () => ({ user: { email: "admin@example.com" } }),
    useDashboardConfig: vi.fn(),
    useNotification: vi.fn(),
    useReadPositionSync: vi.fn(),
    useServerStatus: () => ({ isDraining: false }),
    useSessionListProvider: sessionListProviderSpy,
    useSessionProvider: () => ({ status: "connected" }),
    useUserPreferencesSync: vi.fn(),
  };
});

vi.mock("../components/ConfigButton", () => ({ ConfigButton: () => createElement("button", null, "Config") }));
vi.mock("../components/ConfigModal", () => ({ ConfigModal: () => null }));
vi.mock("../components/SearchModal", () => ({ SearchModal: () => null }));
vi.mock("../hooks/useNodes", () => ({ useNodes: vi.fn() }));
vi.mock("../providers", () => ({ orchestratorSessionProvider: {} }));
vi.mock("./useV2LegacyBoardItems", () => ({
  useV2LegacyBoardItems: () => ({ status: "ready", message: null }),
}));
vi.mock("../store/orchestrator-store", () => ({
  useOrchestratorStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    nodes: new Map(),
    connectionStatus: "connected",
  }),
}));

import { V2DashboardLayout } from "./V2DashboardLayout";
import { createV2PageRouteController } from "./useV2PageRoute";
import { useDashboardStore } from "@seosoyoung/soul-ui";

const page: PageDto = {
  id: "page-daily",
  title: "Daily page",
  daily_date: "2026-07-12",
  version: 1,
  archived: false,
  metadata: { starred: true },
  created_at: "",
  updated_at: "",
};

function createTarget(pathname = "/v2") {
  const listeners = new Set<() => void>();
  const target = {
    location: { pathname, search: "" },
    history: {
      pushState: vi.fn((_state: unknown, _unused: string, path: string) => { target.location.pathname = path; }),
      replaceState: vi.fn((_state: unknown, _unused: string, path: string) => { target.location.pathname = path; }),
    },
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
  };
  return target;
}

function createApi(): PageApiClient {
  return {
    listPages: vi.fn(async () => ({ items: [page], next_cursor: null })),
    getPage: vi.fn(async () => ({ page, blocks: [], state_vector: "" })),
    getDailyPage: vi.fn(async () => ({ page, created: false })),
    applyOperations: vi.fn(),
    setStarred: vi.fn(),
  };
}

function createClient(pageId: string): PageYjsClient {
  const runtimeSnapshot = { status: "ready", ready: true, connected: true, synced: true, error: null } as const;
  const documentSnapshot = {
    page: { id: pageId, title: page.title, dailyDate: page.daily_date, mutationVersion: 1, archived: false, metadata: { starred: true } },
    blocks: [],
  } as const;
  return {
    pageId,
    doc: {} as PageYjsClient["doc"],
    awareness: {} as PageYjsClient["awareness"],
    getSnapshot: () => runtimeSnapshot,
    subscribe: () => () => undefined,
    getProjection: () => ({ getSnapshot: () => documentSnapshot, subscribe: () => () => undefined, destroy: vi.fn() }),
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    destroy: vi.fn(),
  };
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe("V2DashboardLayout", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalMatchMedia: typeof window.matchMedia | undefined;
  let heightSpy: ReturnType<typeof vi.spyOn> | undefined;
  let widthSpy: ReturnType<typeof vi.spyOn> | undefined;

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
    vi.stubGlobal("CSS", { supports: vi.fn(() => false) });
    window.localStorage.clear();
    heightSpy = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    widthSpy = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    sessionListProviderSpy.mockReturnValue({
      sessions: [],
      loading: false,
      error: null,
      catalogLoad: { status: "ready", message: null },
    });
    useDashboardStore.getState().reset();
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    window.matchMedia = originalMatchMedia as typeof window.matchMedia;
    heightSpy?.mockRestore();
    widthSpy?.mockRestore();
    vi.unstubAllGlobals();
  });

  it("assembles the actual DashboardShell desktop three-pane chrome", async () => {
    const api = createApi();
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={api}
        routeController={controller}
        createPageClient={createClient}
      />,
    ));
    await settle();

    expect(container.querySelectorAll("[data-v2-pane]")).toHaveLength(3);
    expect(container.querySelector('[data-v2-pane="left"]')).not.toBeNull();
    expect(container.querySelector('[data-v2-pane="center"]')).not.toBeNull();
    expect(container.querySelector('[data-v2-pane="right"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="existing-right-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mobile-main"]')).toBeNull();
    expect(api.getDailyPage).toHaveBeenCalledTimes(1);
    expect(target.location.pathname).toBe("/v2/pages/page-daily");
    expect(container.textContent).toContain("Daily page");
    expect(container.textContent).toContain("Starred");

    controller.destroy();
  });

  it("shows only Pages, Chat, and Settings on mobile and transitions navigation to page", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    useDashboardStore.setState({ activeTab: "runbooks", selectedFolderId: "legacy-folder" });
    const api = createApi();
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={api}
        routeController={controller}
        createPageClient={createClient}
      />,
    ));
    await settle();

    const labels = Array.from(container.querySelectorAll('[data-slot="tabs-tab"]'))
      .map((tab) => tab.textContent?.trim());
    expect(labels).toEqual(["Pages", "Chat", "Settings"]);
    expect(container.querySelectorAll('[data-slot="tabs-content"]')).toHaveLength(3);
    expect(container.querySelector(".folder-stack")).toBeNull();
    expect(container.querySelector('[data-testid="v2-pages-tab-icon"]')).not.toBeNull();
    expect(useDashboardStore.getState().activeTab).toBe("feed");
    expect(container.querySelector('[data-mobile-v2-pane="page"]')).not.toBeNull();

    const pagesBackButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Pages");
    flushSync(() => pagesBackButton!.click());
    expect(container.querySelector('[data-mobile-v2-pane="navigation"]')).not.toBeNull();

    const starredPageButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Daily page");
    flushSync(() => starredPageButton!.click());
    await settle();
    expect(container.querySelector('[data-mobile-v2-pane="page"]')).not.toBeNull();

    controller.destroy();
  });

  it("returns a restored mobile chat tab to Pages through the real mobile header", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    useDashboardStore.setState({ activeTab: "chat", activeSessionKey: "session-a" });
    const api = createApi();
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={api}
        routeController={controller}
        createPageClient={createClient}
      />,
    ));
    await settle();

    const backButton = container.querySelector<HTMLButtonElement>('[data-testid="mobile-back-button"]');
    expect(backButton).not.toBeNull();

    flushSync(() => backButton!.click());

    expect(useDashboardStore.getState().activeTab).toBe("feed");

    controller.destroy();
  });

  it("opens a legacy session through the canonical active session and mobile Chat tab", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
    const summary = {
      agentSessionId: "session-live",
      status: "running" as const,
      eventCount: 0,
      prompt: "Live referenced session",
      folderId: "legacy-folder",
      nodeId: "eiaserinnys",
    };
    sessionListProviderSpy.mockReturnValue({
      sessions: [summary],
      loading: false,
      error: null,
      catalogLoad: { status: "ready", message: null },
    });
    useDashboardStore.getState().setCatalog({
      folders: [{ id: "legacy-folder", name: "Legacy", sortOrder: 0 }],
      sessions: { "session-live": { folderId: "legacy-folder", displayName: null } },
      boardItems: [],
    });
    const target = createTarget("/v2/legacy-folders/legacy-folder");
    const controller = createV2PageRouteController(target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={createClient}
      />,
    ));
    await settle();

    expect(container.textContent).toContain("Live referenced session");
    const sessionRef = container.querySelector<HTMLElement>("[data-session-ref='session-live']");
    expect(sessionRef).not.toBeNull();
    flushSync(() => sessionRef!.click());

    expect(useDashboardStore.getState().activeSessionKey).toBe("session-live");
    expect(useDashboardStore.getState().activeSessionSummary?.agentSessionId).toBe("session-live");
    expect(useDashboardStore.getState().activeTab).toBe("chat");
    expect(container.querySelector('[data-testid="existing-chat-view"]')).not.toBeNull();
    controller.destroy();
  });
});
