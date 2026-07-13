/**
 * @vitest-environment jsdom
 */

import * as React from "react";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PageApiClient,
  PageDocumentBlock,
  PageDocumentSnapshot,
  PageDto,
  PageYjsClient,
} from "@seosoyoung/soul-ui/page";

const sessionListProviderSpy = vi.hoisted(() => vi.fn());
const sessionListRefetchSpy = vi.hoisted(() => vi.fn());
const createDashboardSessionSpy = vi.hoisted(() => vi.fn());
const acknowledgeSessionReviewSpy = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useQueryClient: () => ({}) };
});

vi.mock("@seosoyoung/soul-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@seosoyoung/soul-ui")>();
  return {
    ...actual,
    acknowledgeSessionReview: acknowledgeSessionReviewSpy,
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
vi.mock("../lib/session-create", () => ({ createDashboardSession: createDashboardSessionSpy }));
vi.mock("../providers", () => ({ orchestratorSessionProvider: {} }));
vi.mock("./useV2LegacyBoardItems", () => ({
  useV2LegacyBoardItems: () => ({ status: "ready", message: null }),
}));
vi.mock("../store/orchestrator-store", () => ({
  useOrchestratorStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    nodes: new Map([["node-a", {
      nodeId: "node-a",
      host: "localhost",
      port: 1,
      status: "connected",
      capabilities: {},
      connectedAt: 1,
      sessionCount: 0,
    }]]),
    connectionStatus: "connected",
  }),
}));

import { V2DashboardLayout } from "./V2DashboardLayout";
import { createV2PageRouteController } from "./useV2PageRoute";
import { useDashboardStore, type SessionSummary } from "@seosoyoung/soul-ui";

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
    searchPages: vi.fn(async () => ({ items: [], next_cursor: null })),
    searchBlocks: vi.fn(async () => ({ items: [], next_cursor: null })),
    getBlock: vi.fn(async () => { throw new Error("not found"); }),
    getBacklinks: vi.fn(async () => ({ items: [], nextCursor: null })),
    applyOperations: vi.fn(),
    setStarred: vi.fn(),
  };
}

function createClient(pageId: string, blocks: readonly PageDocumentBlock[] = []): PageYjsClient {
  const runtimeSnapshot = { status: "ready", ready: true, connected: true, synced: true, error: null } as const;
  const documentSnapshot = {
    page: { id: pageId, title: page.title, dailyDate: page.daily_date, mutationVersion: 1, archived: false, metadata: { starred: true } },
    blocks,
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

function createMutableClient(
  pageId: string,
  initialBlocks: readonly PageDocumentBlock[],
): { client: PageYjsClient; setBlocks(blocks: readonly PageDocumentBlock[], version: number): void } {
  const runtimeSnapshot = {
    status: "ready",
    ready: true,
    connected: true,
    synced: true,
    error: null,
  } as const;
  let documentSnapshot: PageDocumentSnapshot = {
    page: {
      id: pageId,
      title: page.title,
      dailyDate: page.daily_date,
      mutationVersion: 1,
      archived: false,
      metadata: { starred: true },
    },
    blocks: initialBlocks,
  };
  let notifyProjection: () => void = () => undefined;
  const projection = {
    getSnapshot: () => documentSnapshot,
    subscribe: (listener: () => void) => {
      notifyProjection = listener;
      return () => { notifyProjection = () => undefined; };
    },
    destroy: vi.fn(),
  };
  const client = {
    pageId,
    doc: {} as PageYjsClient["doc"],
    awareness: {} as PageYjsClient["awareness"],
    getSnapshot: () => runtimeSnapshot,
    subscribe: () => () => undefined,
    getProjection: () => projection,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
    destroy: vi.fn(),
  } as PageYjsClient;
  return {
    client,
    setBlocks(blocks, version) {
      documentSnapshot = {
        ...documentSnapshot,
        page: { ...documentSnapshot.page, mutationVersion: version },
        blocks,
      };
      notifyProjection();
    },
  };
}

function fakePageText(value: string): PageDocumentBlock["text"] {
  return {
    doc: null,
    length: value.length,
    toString: () => value,
    observe: vi.fn(),
    unobserve: vi.fn(),
  } as unknown as PageDocumentBlock["text"];
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

async function waitForElement<T extends Element>(
  container: ParentNode,
  selector: string,
): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const element = container.querySelector<T>(selector);
    if (element) return element;
    await settle();
  }
  throw new Error(`Element did not appear: ${selector}`);
}

async function submitInlineSession(
  container: ParentNode,
  blockId: string,
  promptValue: string,
): Promise<void> {
  const command = await waitForElement<HTMLButtonElement>(
    container,
    `[data-testid="page-session-command-${blockId}"]`,
  );
  flushSync(() => command.click());
  await settle();
  await settle();
  const agent = container.querySelector<HTMLSelectElement>('[aria-label="Session agent"]')!;
  expect(agent.value).toBe("agent-a");
  const prompt = container.querySelector<HTMLTextAreaElement>('[aria-label="First session prompt"]')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
    .call(prompt, promptValue);
  flushSync(() => prompt.dispatchEvent(new Event("input", { bubbles: true })));
  await settle();
  expect(prompt.value).toBe(promptValue);
  flushSync(() => container.querySelector<HTMLButtonElement>(
    '[data-testid="v2-inline-session-send"]',
  )!.click());
  await settle();
  await settle();
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
      refetch: sessionListRefetchSpy,
    });
    sessionListRefetchSpy.mockReset();
    createDashboardSessionSpy.mockReset();
    acknowledgeSessionReviewSpy.mockReset();
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

  it("clears a response warning when the canonical visible session poll reports no warnings", async () => {
    const blocks: readonly PageDocumentBlock[] = [
      {
        id: "block-draft",
        parentId: null,
        positionKey: "a",
        type: "paragraph",
        text: fakePageText("/세션"),
        textValue: "/세션",
        properties: {},
        collapsed: false,
      },
      {
        id: "block-other",
        parentId: null,
        positionKey: "b",
        type: "session_ref",
        text: fakePageText("[[Other]]"),
        textValue: "[[Other]]",
        properties: { sessionId: "session-other", primary: false },
        collapsed: false,
      },
    ];
    const otherSession = {
      agentSessionId: "session-other",
      status: "running" as const,
      eventCount: 0,
      prompt: "Other session",
      folderId: null,
      nodeId: "node-a",
    };
    let visibleSessions: SessionSummary[] = [otherSession];
    sessionListProviderSpy.mockImplementation(() => ({
      sessions: visibleSessions,
      loading: false,
      error: null,
      catalogLoad: { status: "ready", message: null },
      refetch: sessionListRefetchSpy,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{ id: "agent-a", name: "Agent A" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    createDashboardSessionSpy.mockResolvedValue({
      agentSessionId: "session-created",
      nodeId: "node-a",
      warnings: [{ code: "LEGACY_PROJECTION_PENDING", message: "Legacy projection is pending." }],
    });
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    const pageClient = createClient(page.id, blocks);
    const createPageClient = () => pageClient;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={createPageClient}
      />,
    ));
    await settle();

    await submitInlineSession(container, "block-draft", "Create from page");

    expect(createDashboardSessionSpy).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="v2-session-creation-warnings"]')?.textContent)
      .toContain("Legacy projection is pending.");
    visibleSessions = [{
      agentSessionId: "session-created",
      status: "running" as const,
      eventCount: 0,
      prompt: "Create from page",
      folderId: null,
      nodeId: "node-a",
      bindingWarnings: [],
    }, otherSession];
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={createPageClient}
      />,
    ));
    await settle();

    expect(useDashboardStore.getState().activeSessionKey).toBe("session-created");
    expect(container.querySelector('[data-testid="v2-session-creation-warnings"]')).toBeNull();
    flushSync(() => container!.querySelector<HTMLButtonElement>('[data-session-ref-open="session-other"]')!.click());
    await settle();
    expect(useDashboardStore.getState().activeSessionKey).toBe("session-other");
    expect(container.querySelector('[data-testid="v2-session-creation-warnings"]')).toBeNull();

    controller.destroy();
  });

  it("uses canonical visible session warnings instead of a stale response warning", async () => {
    const blocks: readonly PageDocumentBlock[] = [{
      id: "block-canonical-warning",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: fakePageText("/세션"),
      textValue: "/세션",
      properties: {},
      collapsed: false,
    }];
    let visibleSessions: SessionSummary[] = [];
    sessionListProviderSpy.mockImplementation(() => ({
      sessions: visibleSessions,
      loading: false,
      error: null,
      catalogLoad: { status: "ready", message: null },
      refetch: sessionListRefetchSpy,
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{ id: "agent-a", name: "Agent A" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    createDashboardSessionSpy.mockResolvedValue({
      agentSessionId: "session-canonical-warning",
      nodeId: "node-a",
      warnings: [{ code: "LEGACY_PROJECTION_PENDING", message: "Stale response warning." }],
    });
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    const pageClient = createClient(page.id, blocks);
    const createPageClient = () => pageClient;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={createPageClient}
      />,
    ));
    await settle();

    await submitInlineSession(container, "block-canonical-warning", "Canonical warning");
    expect(container.textContent).toContain("Stale response warning.");

    visibleSessions = [{
      agentSessionId: "session-canonical-warning",
      status: "running",
      eventCount: 0,
      prompt: "Canonical warning",
      folderId: null,
      nodeId: "node-a",
      bindingWarnings: [{
        code: "PAGE_BINDING_MANUAL_REPAIR",
        message: "Canonical manual repair warning.",
      }],
    }];
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={createPageClient}
      />,
    ));
    await settle();

    expect(useDashboardStore.getState().activeSessionKey).toBe("session-canonical-warning");
    expect(container.textContent).toContain("Canonical manual repair warning.");
    expect(container.textContent).not.toContain("Stale response warning.");
    controller.destroy();
  });

  it("refetches the canonical durable warnings when a lost create response is recovered", async () => {
    const recoverySessionId = "8c55c4d8-625b-4b1f-92ec-81dcb52ae453";
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(recoverySessionId);
    const initialBlock: PageDocumentBlock = {
      id: "block-recovery",
      parentId: null,
      positionKey: "a",
      type: "paragraph",
      text: fakePageText("/세션"),
      textValue: "/세션",
      properties: {},
      collapsed: false,
    };
    const mutableClient = createMutableClient(page.id, [initialBlock]);
    const canonical = {
      agentSessionId: recoverySessionId,
      status: "completed" as const,
      eventCount: 2,
      prompt: "Recovered prompt",
      folderId: null,
      nodeId: "node-a",
      reviewRequired: true,
      reviewState: "needs_review" as const,
      bindingWarnings: [{
        code: "PAGE_BINDING_MANUAL_REPAIR" as const,
        message: "Recovered from the durable binding row.",
      }],
    };
    sessionListRefetchSpy.mockResolvedValue({
      data: { pages: [{ sessions: [canonical], total: 1 }], pageParams: [0] },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{ id: "agent-a", name: "Agent A" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    createDashboardSessionSpy.mockRejectedValueOnce(new Error("response lost"));
    const target = createTarget();
    const controller = createV2PageRouteController(target);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(
      <V2DashboardLayout
        apiClient={createApi()}
        routeController={controller}
        createPageClient={() => mutableClient.client}
      />,
    ));
    const commandButton = await waitForElement<HTMLButtonElement>(container,
      '[data-testid="page-session-command-block-recovery"]',
    );
    flushSync(() => commandButton.click());
    await settle();
    await settle();
    const prompt = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="First session prompt"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!
      .call(prompt, "Recovered prompt");
    flushSync(() => prompt.dispatchEvent(new Event("input", { bubbles: true })));
    await settle();
    flushSync(() => container!.querySelector<HTMLButtonElement>(
      '[data-testid="v2-inline-session-send"]',
    )!.click());
    await settle();
    expect(container.textContent).toContain("response lost");

    flushSync(() => mutableClient.setBlocks([{
      ...initialBlock,
      type: "session_ref",
      text: fakePageText("[[Recovered]]"),
      textValue: "[[Recovered]]",
      properties: { sessionId: recoverySessionId, primary: true },
    }], 2));
    await settle();
    flushSync(() => container!.querySelector<HTMLButtonElement>(
      '[data-testid="v2-inline-session-send"]',
    )!.click());
    await settle();
    await settle();

    expect(sessionListRefetchSpy).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
      agentSessionId: recoverySessionId,
      status: "completed",
      bindingWarnings: [{ code: "PAGE_BINDING_MANUAL_REPAIR" }],
    });
    expect(container.textContent).toContain("Recovered from the durable binding row.");
    expect(container.querySelector('[data-testid="v2-session-review"]')).not.toBeNull();
    controller.destroy();
  });

  it("composes durable recovery warnings and review acknowledgement without changing status", async () => {
    const summary = {
      agentSessionId: "session-recovered",
      status: "completed" as const,
      eventCount: 7,
      prompt: "Recovered after response loss",
      folderId: null,
      nodeId: "node-a",
      reviewRequired: true,
      reviewState: "needs_review" as const,
      bindingWarnings: [{
        code: "PAGE_BINDING_MANUAL_REPAIR" as const,
        message: "Manual repair is required.",
      }],
    };
    sessionListProviderSpy.mockReturnValue({
      sessions: [summary],
      loading: false,
      error: null,
      catalogLoad: { status: "ready", message: null },
    });
    useDashboardStore.setState({
      activeSessionKey: summary.agentSessionId,
      activeSessionSummary: summary,
      activeTab: "chat",
    });
    let resolveAcknowledge!: (value: {
      status: "ok";
      agentSessionId: string;
      reviewState: "acknowledged";
      changed: boolean;
    }) => void;
    acknowledgeSessionReviewSpy.mockReturnValue(new Promise((resolve) => {
      resolveAcknowledge = resolve;
    }));
    const target = createTarget();
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

    expect(container.querySelector('[data-testid="v2-session-creation-warnings"]')?.textContent)
      .toContain("Manual repair is required.");
    expect(container.querySelector('[data-testid="v2-session-review"]')).not.toBeNull();
    flushSync(() => container!.querySelector<HTMLButtonElement>(
      '[data-testid="v2-session-review-acknowledge"]',
    )!.click());
    flushSync(() => useDashboardStore.getState().setActiveSessionSummary({
      ...summary,
      status: "interrupted",
    }));
    resolveAcknowledge({
      status: "ok",
      agentSessionId: summary.agentSessionId,
      reviewState: "acknowledged",
      changed: true,
    });
    await settle();

    expect(useDashboardStore.getState().activeSessionSummary).toMatchObject({
      status: "interrupted",
      reviewState: "acknowledged",
    });
    expect(container.textContent).toContain("Review acknowledged.");
    expect(container.querySelector('[data-testid="v2-session-creation-warnings"]')).not.toBeNull();
    controller.destroy();
  });
});
