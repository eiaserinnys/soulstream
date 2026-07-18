/**
 * @vitest-environment jsdom
 */

import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CatalogState, SessionSummary } from "../shared/types";
import { useDashboardStore } from "../stores/dashboard-store";
import type { RunbookSnapshot } from "../stores/runbook-store";
import { useRunbookStore } from "../stores/runbook-store";
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

const runbookSnapshot: RunbookSnapshot = {
  runbook: {
    id: "rb-1",
    board_item_id: "runbook:rb-1",
    folder_id: "root",
    title: "Launch Runbook",
    status: "open",
    archived: false,
    version: 1,
    created_session_id: null,
    created_event_id: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  },
  sections: [{
    id: "sec-1",
    runbook_id: "rb-1",
    position_key: "a",
    title: "Phase",
    assignee_kind: null,
    assignee_agent_id: null,
    assignee_session_id: null,
    assignee_user_id: null,
    archived: false,
    version: 1,
    created_session_id: null,
    created_event_id: null,
    updated_session_id: null,
    updated_event_id: null,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
  }],
  items: [
    {
      id: "item-done",
      section_id: "sec-1",
      position_key: "a",
      title: "Done",
      how_to: "",
      status: "completed",
      assignee_kind: null,
      assignee_agent_id: null,
      assignee_session_id: null,
      assignee_user_id: null,
      archived: false,
      version: 1,
      created_session_id: null,
      created_event_id: null,
      updated_session_id: null,
      updated_event_id: null,
      completed_kind: "agent",
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
    {
      id: "item-pending",
      section_id: "sec-1",
      position_key: "b",
      title: "Pending",
      how_to: "",
      status: "pending",
      assignee_kind: null,
      assignee_agent_id: null,
      assignee_session_id: null,
      assignee_user_id: null,
      archived: false,
      version: 1,
      created_session_id: null,
      created_event_id: null,
      updated_session_id: null,
      updated_event_id: null,
      completed_kind: null,
      completed_session_id: null,
      completed_event_id: null,
      completed_user_id: null,
      completed_at: null,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    },
  ],
};

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

function installFetchMock({
  boardItems = [],
  snapshots = {},
  failBoardItems = false,
}: {
  boardItems?: NonNullable<CatalogState["boardItems"]>;
  snapshots?: Record<string, RunbookSnapshot>;
  failBoardItems?: boolean;
} = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/board-items?folder_id=root") {
      if (failBoardItems) {
        return Response.json({ detail: "board items unavailable" }, { status: 503 });
      }
      return Response.json({ boardItems });
    }
    const runbookMatch = url.match(/^\/api\/runbooks\/([^/]+)$/);
    if (runbookMatch) {
      const snapshot = snapshots[decodeURIComponent(runbookMatch[1] ?? "")];
      if (snapshot) return Response.json(snapshot);
      return Response.json({ detail: "not found" }, { status: 404 });
    }
    return Response.json({ detail: `unexpected fetch ${url}` }, { status: 500 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderFolderWorkspace(options: {
  catalogOverride?: CatalogState;
  sessionsOverride?: SessionSummary[];
  boardItems?: NonNullable<CatalogState["boardItems"]>;
  snapshots?: Record<string, RunbookSnapshot>;
  failBoardItems?: boolean;
} = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const fetchMock = installFetchMock({
    boardItems: options.boardItems,
    snapshots: options.snapshots,
    failBoardItems: options.failBoardItems,
  });
  useDashboardStore.getState().reset();
  useRunbookStore.getState().reset();
  useDashboardStore.getState().setCatalog(options.catalogOverride ?? catalog);
  useDashboardStore.getState().selectFolder("root");
  writeFolderWorkspaceViewMode(window.localStorage, "root", "list");

  flushSync(() => {
    root.render(createElement(FolderWorkspaceView, { sessions: options.sessionsOverride ?? sessions }));
  });

  return { container, fetchMock, root };
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

  it("uses the session grid column basis for project header cards", async () => {
    const boardItems: NonNullable<CatalogState["boardItems"]> = [{
      id: "runbook:rb-1",
      folderId: "root",
      containerKind: "folder",
      containerId: "root",
      membershipKind: "primary",
      sourceRunbookItemId: null,
      itemType: "runbook",
      itemId: "rb-1",
      x: 20,
      y: 10,
      metadata: { title: "Launch Runbook" },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }];
    ({ container, root } = renderFolderWorkspace({ boardItems }));

    await flushEffects();

    const childFolderGrid = Array.from(container.querySelectorAll<HTMLElement>("section"))
      .find((section) => section.textContent?.includes("Child A"))
      ?.querySelector<HTMLElement>(".grid");
    const runbookGrid = container.querySelector<HTMLElement>("[data-testid='folder-runbook-section'] > .grid");
    const sessionGrid = container.querySelector<HTMLElement>("[data-testid='folder-session-row-grid']");
    const columnClasses = (element: HTMLElement | null | undefined) =>
      Array.from(element?.classList ?? []).filter((className) => className.includes("grid-cols-"));

    expect(childFolderGrid).not.toBeNull();
    expect(runbookGrid).not.toBeNull();
    expect(sessionGrid).not.toBeNull();
    expect(columnClasses(childFolderGrid)).toEqual(columnClasses(sessionGrid));
    expect(columnClasses(runbookGrid)).toEqual(columnClasses(sessionGrid));
  });

  it("renders folder runbooks above sessions and opens the runbook board", async () => {
    const boardItems: NonNullable<CatalogState["boardItems"]> = [{
      id: "runbook:rb-1",
      folderId: "root",
      containerKind: "folder",
      containerId: "root",
      membershipKind: "primary",
      sourceRunbookItemId: null,
      itemType: "runbook",
      itemId: "rb-1",
      x: 20,
      y: 10,
      metadata: { title: "Launch Runbook" },
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }];
    ({ container, root } = renderFolderWorkspace({
      boardItems,
      snapshots: { "rb-1": runbookSnapshot },
    }));

    await flushEffects();

    const scrollRoot = container.querySelector<HTMLElement>("[data-testid='folder-session-scroll-root']");
    const runbookCard = container.querySelector<HTMLButtonElement>("[data-testid='folder-runbook-card']");
    const virtualGrid = container.querySelector<HTMLElement>("[data-testid='folder-session-virtual-grid']");

    expect(scrollRoot).not.toBeNull();
    expect(runbookCard).not.toBeNull();
    expect(virtualGrid).not.toBeNull();
    expect(scrollRoot?.contains(runbookCard ?? null)).toBe(true);
    expect(scrollRoot?.contains(virtualGrid)).toBe(true);
    expect(scrollRoot?.textContent).toContain("하위 폴더");
    expect(scrollRoot?.textContent).toContain("런북");
    expect(scrollRoot?.textContent).toContain("Launch Runbook");
    expect(scrollRoot?.textContent).toContain("1/2");

    flushSync(() => {
      runbookCard?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(useDashboardStore.getState().activeBoardContainer).toEqual({
      kind: "runbook",
      id: "rb-1",
    });
    expect(useDashboardStore.getState().selectedFolderId).toBe("root");
  });

  it("does not render a runbook section when the folder has no runbooks", async () => {
    ({ container, root } = renderFolderWorkspace());

    await flushEffects();

    expect(container.querySelector("[data-testid='folder-runbook-section']")).toBeNull();
    expect(container.textContent).not.toContain("런북");
    expect(container.textContent).toContain("세션");
  });

  it("hides runbook container sessions from the folder session list", () => {
    ({ container, root } = renderFolderWorkspace({
      catalogOverride: {
        ...catalog,
        boardItems: [
          {
            id: "session:session-a",
            folderId: "root",
            containerKind: "runbook",
            containerId: "rb-1",
            membershipKind: "primary",
            sourceRunbookItemId: "item-1",
            itemType: "session",
            itemId: "session-a",
            x: 10,
            y: 10,
          },
          {
            id: "session:session-b",
            folderId: "root",
            containerKind: "folder",
            containerId: "root",
            membershipKind: "primary",
            sourceRunbookItemId: null,
            itemType: "session",
            itemId: "session-b",
            x: 20,
            y: 20,
          },
        ],
      },
    }));

    expect(container.textContent).not.toContain("Session A");
    expect(container.textContent).toContain("Session B");
  });

  it("hides sessions owned by a different folder container from the folder session list", () => {
    ({ container, root } = renderFolderWorkspace({
      catalogOverride: {
        ...catalog,
        boardItems: [
          {
            id: "session:session-a",
            folderId: "root",
            containerKind: "folder",
            containerId: "child-folder-or-nested-board",
            membershipKind: "primary",
            sourceRunbookItemId: null,
            itemType: "session",
            itemId: "session-a",
            x: 10,
            y: 10,
          },
          {
            id: "session:session-b",
            folderId: "root",
            containerKind: "folder",
            containerId: "root",
            membershipKind: "primary",
            sourceRunbookItemId: null,
            itemType: "session",
            itemId: "session-b",
            x: 20,
            y: 20,
          },
        ],
      },
    }));

    expect(container.textContent).not.toContain("Session A");
    expect(container.textContent).toContain("Session B");
  });

  it("hides runbook container sessions after loading folder-scoped board items", async () => {
    ({ container, root } = renderFolderWorkspace({
      boardItems: [
        {
          id: "session:session-a",
          folderId: "root",
          containerKind: "runbook",
          containerId: "rb-1",
          membershipKind: "primary",
          sourceRunbookItemId: "item-1",
          itemType: "session",
          itemId: "session-a",
          x: 10,
          y: 10,
        },
        {
          id: "session:session-b",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "session",
          itemId: "session-b",
          x: 20,
          y: 20,
        },
      ],
    }));

    expect(container.textContent).toContain("Session A");
    expect(container.textContent).toContain("Session B");

    await flushEffects();

    expect(container.textContent).not.toContain("Session A");
    expect(container.textContent).toContain("Session B");
  });

  it("hides sessions owned by a different folder container after loading folder-scoped board items", async () => {
    ({ container, root } = renderFolderWorkspace({
      boardItems: [
        {
          id: "session:session-a",
          folderId: "root",
          containerKind: "folder",
          containerId: "child-folder-or-nested-board",
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "session",
          itemId: "session-a",
          x: 10,
          y: 10,
        },
        {
          id: "session:session-b",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "session",
          itemId: "session-b",
          x: 20,
          y: 20,
        },
      ],
    }));

    expect(container.textContent).toContain("Session A");
    expect(container.textContent).toContain("Session B");

    await flushEffects();

    expect(container.textContent).not.toContain("Session A");
    expect(container.textContent).toContain("Session B");
  });

  it("keeps folder container and tileless sessions visible", () => {
    const sessionsWithTileless: SessionSummary[] = [
      sessions[1]!,
      {
        agentSessionId: "session-c",
        status: "completed",
        eventCount: 3,
        agentId: "keke",
        agentName: "Keke",
        folderId: "root",
        prompt: "Session C",
        updatedAt: "2026-06-10T00:00:00.000Z",
      },
    ];
    ({ container, root } = renderFolderWorkspace({
      sessionsOverride: sessionsWithTileless,
      catalogOverride: {
        ...catalog,
        boardItems: [{
          id: "session:session-b",
          folderId: "root",
          containerKind: "folder",
          containerId: "root",
          membershipKind: "primary",
          sourceRunbookItemId: null,
          itemType: "session",
          itemId: "session-b",
          x: 20,
          y: 20,
        }],
      },
    }));

    expect(container.textContent).toContain("Session B");
    expect(container.textContent).toContain("Session C");
  });

  it("fails open while board items are missing or fail to load", async () => {
    ({ container, root } = renderFolderWorkspace({ failBoardItems: true }));

    expect(container.textContent).toContain("Session A");
    expect(container.textContent).toContain("Session B");

    await flushEffects();

    expect(container.textContent).toContain("Session A");
    expect(container.textContent).toContain("Session B");
  });

  it("omits archived runbooks from the folder runbook section", async () => {
    const archivedSnapshot: RunbookSnapshot = {
      ...runbookSnapshot,
      runbook: {
        ...runbookSnapshot.runbook,
        archived: true,
      },
    };
    ({ container, root } = renderFolderWorkspace({
      boardItems: [{
        id: "runbook:rb-1",
        folderId: "root",
        containerKind: "folder",
        containerId: "root",
        membershipKind: "primary",
        sourceRunbookItemId: null,
        itemType: "runbook",
        itemId: "rb-1",
        x: 20,
        y: 10,
        metadata: { title: "Archived Runbook" },
      }],
      snapshots: { "rb-1": archivedSnapshot },
    }));

    await flushEffects();

    expect(container.querySelector("[data-testid='folder-runbook-section']")).toBeNull();
    expect(container.textContent).not.toContain("Archived Runbook");
    expect(container.textContent).toContain("세션");
  });
});
