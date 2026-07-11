/**
 * @vitest-environment jsdom
 */

import * as React from "react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageApiClient, PageDto, PageYjsClient } from "@seosoyoung/soul-ui/page";

vi.mock("@seosoyoung/soul-ui", () => ({
  AskQuestionBanner: () => createElement("div", { "data-testid": "ask-question" }),
  ChatView: () => createElement("div", { "data-testid": "existing-chat-view" }),
  ConnectionBadge: () => createElement("div", { "data-testid": "connection-badge" }),
  DashboardShell: ({ leftPanel, centerPanel, rightPanel, mobileSessionsView }: Record<string, React.ReactNode>) => createElement(
    "div",
    { "data-testid": "v2-dashboard-shell" },
    createElement("section", { "data-desktop-pane": "left" }, leftPanel),
    createElement("section", { "data-desktop-pane": "center" }, centerPanel),
    createElement("section", { "data-desktop-pane": "right" }, rightPanel),
    createElement("section", { "data-mobile-contract": "single-pane" }, mobileSessionsView),
  ),
  MobileChatHeader: () => createElement("div"),
  RightPanel: () => createElement("div", { "data-testid": "existing-right-panel" }),
  ThemeToggle: () => createElement("button", null, "Theme"),
  initTheme: vi.fn(),
  useAuth: () => ({ user: { email: "admin@example.com" } }),
  useDashboardConfig: vi.fn(),
  useDashboardStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    activeSessionKey: null,
    activeSessionSummary: null,
  }),
  useNotification: vi.fn(),
  useReadPositionSync: vi.fn(),
  useServerStatus: () => ({ isDraining: false }),
  useSessionListProvider: () => ({ sessions: [] }),
  useSessionProvider: () => ({ status: "connected" }),
  useUserPreferencesSync: vi.fn(),
}));

vi.mock("../components/ConfigButton", () => ({ ConfigButton: () => createElement("button", null, "Config") }));
vi.mock("../components/ConfigModal", () => ({ ConfigModal: () => null }));
vi.mock("../components/SearchModal", () => ({ SearchModal: () => null }));
vi.mock("../hooks/useNodes", () => ({ useNodes: vi.fn() }));
vi.mock("../providers", () => ({ orchestratorSessionProvider: {} }));
vi.mock("../store/orchestrator-store", () => ({
  useOrchestratorStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    nodes: new Map(),
    connectionStatus: "connected",
  }),
}));

import { V2DashboardLayout } from "./V2DashboardLayout";
import { createV2PageRouteController } from "./useV2PageRoute";

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

function createTarget() {
  const listeners = new Set<() => void>();
  const target = {
    location: { pathname: "/v2" },
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

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it("assembles desktop three-pane chrome and a mobile single-pane contract", async () => {
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

    expect(container.querySelectorAll("[data-desktop-pane]")).toHaveLength(3);
    expect(container.querySelector('[data-desktop-pane="left"] [data-v2-pane="left"]')).not.toBeNull();
    expect(container.querySelector('[data-desktop-pane="center"] [data-v2-pane="center"]')).not.toBeNull();
    expect(container.querySelector('[data-desktop-pane="right"] [data-v2-pane="right"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="existing-right-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-mobile-contract] [data-responsive-mode="single-pane"]')).not.toBeNull();
    expect(api.getDailyPage).toHaveBeenCalledTimes(1);
    expect(target.location.pathname).toBe("/v2/pages/page-daily");
    expect(container.textContent).toContain("Daily page");
    expect(container.textContent).toContain("Starred");

    controller.destroy();
  });
});
